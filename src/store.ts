import { parseAttribution } from './parse.js';
import { advanceState, createTracker, toCookie, toSnapshot, validateState } from './tracker.js';
import type {
  AttributionState, AttributionTouch, StoredAttributionTracker, StoredTrackerOptions,
} from './types.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validId(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

/** Evidence fallback supports records written before stable touch IDs existed. */
function legacyIdentity(touch: AttributionTouch): string {
  return JSON.stringify([
    touch.timestamp, touch.source, touch.medium, touch.evidence,
    Object.entries(touch.utm ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    touch.evidence === 'referrer' ? touch.referrer : undefined,
  ]);
}

function sameTouch(left: AttributionTouch, right: AttributionTouch): boolean {
  if (left.id && right.id) return left.id === right.id;
  return legacyIdentity(left) === legacyIdentity(right);
}

/**
 * Recover newer touches retained in a cookie during an outage. The server's
 * existing endpoints remain authoritative: require a shared first-touch anchor,
 * then merge unseen arrivals. Stable IDs permit chronological insertion into a
 * complete server record, including different arrivals sharing a timestamp.
 * Truncated server records only accept arrivals at or after their latest touch:
 * an unmatched older ID may already have been evicted and counted there.
 * Legacy records without IDs require a strictly newer timestamp.
 */
function mergeBackup(
  current: AttributionState, backup: AttributionState | null, maxTouches: number,
): AttributionState {
  if (!backup || !sameTouch(current.touches[0]!, backup.touches[0]!)) return current;
  const first = current.touches[0]!;
  const latestTimestamp = current.touches[current.touches.length - 1]!.timestamp;
  const canInsertOlder = current.droppedTouchCount === 0 && first.id !== undefined && first.id === backup.touches[0]!.id;
  const known = [...current.touches];
  const additions = backup.touches.filter((touch) => {
    if (touch.timestamp < first.timestamp
      || (touch.timestamp < latestTimestamp && !(canInsertOlder && touch.id))
      || (!touch.id && touch.timestamp === latestTimestamp)
      || known.some((existing) => sameTouch(existing, touch))) return false;
    known.push(touch);
    return true;
  });
  if (!additions.length) return current;
  // Keep the authoritative first object, including its richer untrimmed fields.
  // Stable sorting retains established order when separate arrivals share a time.
  const touches = [first, ...[...current.touches.slice(1), ...additions].sort((left, right) => left.timestamp - right.timestamp)];
  // Cookie counters also tell us when outage touches were already evicted. Their
  // contents cannot be recovered, but the resulting snapshot must show that loss.
  const totalTouchCount = Math.max(current.totalTouchCount + additions.length, backup.totalTouchCount);
  while (touches.length > maxTouches) touches.splice(1, 1);
  return {
    ...current, touches, totalTouchCount,
    droppedTouchCount: totalTouchCount - touches.length,
  };
}

/**
 * Optional durable capture with an ORM-independent adapter. Atomic update is
 * essential: adapters must run the synchronous callback inside a transaction,
 * per-visitor lock, or compare-and-swap retry, rather than read then write.
 */
export function createStoredTracker(options: StoredTrackerOptions): StoredAttributionTracker {
  const fallback = createTracker(options);
  const name = options.visitorCookieName ?? `${fallback.cookie.name}_id`;
  // Reuse the cookie engine's complete naming/domain/prefix validation.
  const visitorCookie = createTracker({ ...options, cookieName: name }).cookie;
  const timeoutMs = options.storeTimeoutMs ?? 1000;
  const maxTouches = options.serverMaxTouches ?? 1000;
  if (name === fallback.cookie.name) throw new TypeError('TrackNext attribution and visitor cookies must have distinct names');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError('TrackNext storeTimeoutMs must be an integer between 1 and 10000');
  }
  if (!Number.isInteger(maxTouches) || maxTouches < 2 || maxTouches > 10_000) {
    throw new TypeError('TrackNext serverMaxTouches must be an integer between 2 and 10000');
  }
  if (!options.store || ['read', 'update', 'delete'].some((key) => typeof options.store[key as keyof typeof options.store] !== 'function')) {
    throw new TypeError('TrackNext store must implement read, atomic update, and delete');
  }
  const clock = options.now ?? Date.now;
  const ttlDays = options.ttlDays ?? 90;
  type Operation = 'read' | 'update' | 'delete';

  function report(error: unknown, operation: Operation): void {
    try { options.onStoreError?.(error, operation); }
    catch { /* Diagnostics must never fail the visitor's page or conversion. */ }
  }

  async function attempt<T>(operation: Operation, execute: () => Promise<T>): Promise<
    { ok: true; value: T } | { ok: false }
  > {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A timeout bounds response latency. It does not cancel an adapter's write;
      // keeping the returned ID stable lets a later request recover that write.
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`TrackNext store ${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      const value = await Promise.race([Promise.resolve().then(execute), timeout]);
      return { ok: true, value };
    } catch (error) {
      report(error, operation);
      return { ok: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    cookie: fallback.cookie,
    visitorCookie,
    async capture(input, raw, suppliedId) {
      const startedAt = clock();
      const now = input.now ?? startedAt;
      // Preserve an explicitly supplied test/request timestamp while accounting
      // for time elapsed before an adapter finally invokes or retries its callback.
      const operationTime = () => now + Math.max(0, clock() - startedAt);
      const decision = parseAttribution({ ...input, now }, options);
      const cookieResult = fallback.capture({ ...input, now }, raw);
      const id = validId(suppliedId) ? suppliedId : undefined;
      if (decision.kind === 'ignore') return { ...cookieResult, visitorId: id, persisted: false };
      // One request must use one touch ID across the fallback cookie, atomic
      // retries, and a write that completes after its timeout. Otherwise a later
      // recovery can count the same arrival twice under independently minted IDs.
      decision.touch.id = cookieResult.reason === 'recorded' && cookieResult.snapshot?.lastTouch.id
        ? cookieResult.snapshot.lastTouch.id : crypto.randomUUID();
      const visitorId = id ?? crypto.randomUUID();
      // The previous cookie excludes this request's touch. Replaying a fallback
      // result here would add it twice when the server succeeds.
      const backup = validateState(fallback.read(raw, now), now, ttlDays, maxTouches);
      let reason = cookieResult.reason;
      const result = await attempt('update', () => options.store.update(visitorId, (untrustedCurrent) => {
        const observedAt = operationTime();
        const current = validateState(untrustedCurrent, observedAt, ttlDays, maxTouches);
        // A late, uncancellable write must not resurrect an expired journey or
        // append its old arrival to a newer journey already stored for this ID.
        if (decision.touch.timestamp + Math.round(ttlDays * 86_400_000) <= observedAt
          || (current && decision.touch.timestamp < current.touches[0]!.timestamp)) {
          reason = 'ignored';
          return current;
        }
        const validBackup = validateState(backup, observedAt, ttlDays, maxTouches);
        const previous = current ? mergeBackup(current, validBackup, maxTouches) : validBackup;
        const next = advanceState(previous, decision, now, options, maxTouches);
        reason = next.reason;
        return next.state;
      }));
      const stored = result.ok ? validateState(result.value, operationTime(), ttlDays, maxTouches) : null;
      if (!stored) {
        if (result.ok) report(new Error('TrackNext store returned invalid attribution state after update'), 'update');
        return { ...cookieResult, visitorId, persisted: false };
      }
      const encoded = toCookie(stored, options);
      return {
        snapshot: toSnapshot(stored), reason, persisted: true, visitorId,
        ...(encoded.cookieValue !== raw ? { cookieValue: encoded.cookieValue } : {}),
      };
    },
    async read(raw, visitorId, now = clock()) {
      if (validId(visitorId)) {
        const result = await attempt('read', () => options.store.read(visitorId));
        const state = result.ok ? validateState(result.value, now, ttlDays, maxTouches) : null;
        if (state) {
          const backup = validateState(fallback.read(raw, now), now, ttlDays, maxTouches);
          return toSnapshot(mergeBackup(state, backup, maxTouches));
        }
      }
      return fallback.read(raw, now);
    },
    async delete(visitorId) {
      if (validId(visitorId)) await attempt('delete', () => options.store.delete(visitorId));
    },
  };
}
