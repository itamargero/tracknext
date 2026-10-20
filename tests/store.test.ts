import { describe, expect, it, vi } from 'vitest';
import { createStoredTracker } from '../src/store.js';
import { createTracker, encodeState } from '../src/tracker.js';
import type { AttributionState, AttributionStore } from '../src/types.js';

const START = Date.UTC(2026, 9, 20);
const ID = 'd30ae664-60bf-47d6-9d68-374498324dde';
const arrival = (source: string, now = START) => ({
  url: `https://example.com/?utm_source=${source}&utm_medium=email`, now,
});

/** Test fixture only: serialize callbacks per visitor, as a real adapter must. */
function fixture() {
  const records = new Map<string, AttributionState>();
  const pending = new Map<string, Promise<unknown>>();
  const store: AttributionStore = {
    read: vi.fn(async (id: string) => structuredClone(records.get(id) ?? null)),
    update: vi.fn(async (id: string, updater: (state: AttributionState | null) => AttributionState | null) => {
      const previous = pending.get(id) ?? Promise.resolve();
      const operation = previous.catch(() => undefined).then(() => {
        const state = updater(structuredClone(records.get(id) ?? null));
        if (state) records.set(id, structuredClone(state));
        else records.delete(id);
        return structuredClone(state);
      });
      pending.set(id, operation);
      try { return await operation; }
      finally { if (pending.get(id) === operation) pending.delete(id); }
    }),
    delete: vi.fn(async (id: string) => { records.delete(id); }),
  };
  return { store, records };
}

describe('optional ORM-independent server storage', () => {
  it('keeps a longer server history while retaining a bounded cookie backup', async () => {
    const { store } = fixture();
    const tracker = createStoredTracker({ store, now: () => START });
    let cookie: string | undefined;
    let id: string | undefined;
    for (let index = 0; index < 12; index += 1) {
      const result = await tracker.capture(arrival(`campaign-${index}`, START + index * 1000), cookie, id);
      expect(result.persisted).toBe(true);
      cookie = result.cookieValue ?? cookie;
      id = result.visitorId;
    }
    const saved = await tracker.read(undefined, id, START + 12_000);
    expect(saved?.touches).toHaveLength(12);
    expect(saved?.droppedTouchCount).toBe(0);
    expect(createTracker().read(cookie, START + 12_000)?.touches.length).toBeLessThanOrEqual(5);
    expect(tracker.visitorCookie).toEqual({ ...tracker.cookie, name: 'tracknext_id' });
  });

  it('recovers a deleted or invalid attribution payload using the surviving visitor cookie', async () => {
    const { store } = fixture();
    const tracker = createStoredTracker({ store });
    const first = await tracker.capture(arrival('newsletter'));
    for (const raw of [undefined, 'broken-cookie']) {
      const recovered = await tracker.capture({ url: 'https://example.com/', now: START + 1000 }, raw, first.visitorId);
      expect(recovered.persisted).toBe(true);
      expect(recovered.reason).toBe('direct_return');
      expect(recovered.snapshot?.firstTouch.source).toBe('newsletter');
      expect(recovered.cookieValue).toBeDefined();
    }
  });

  it('does not call storage or mint an identity for ignored/internal navigation', async () => {
    const { store } = fixture();
    const tracker = createStoredTracker({ store });
    const result = await tracker.capture({ ...arrival('internal-banner'), referrer: 'https://example.com/pricing' });
    expect(result).toMatchObject({ reason: 'ignored', persisted: false, snapshot: null });
    expect(result.visitorId).toBeUndefined();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it('persists an initial direct arrival and preserves it when marketing later arrives', async () => {
    const { store } = fixture();
    const tracker = createStoredTracker({ store });
    const first = await tracker.capture({ url: 'https://example.com/', now: START });
    const next = await tracker.capture(arrival('newsletter', START + 1000), first.cookieValue, first.visitorId);
    expect(first.persisted).toBe(true);
    expect(next.snapshot?.firstTouch.source).toBe('direct');
    expect(next.snapshot?.lastTouch.source).toBe('newsletter');
  });

  it('uses cookie fallback after rejected writes and swallows a throwing error callback', async () => {
    const { store } = fixture();
    const failure = new Error('database unavailable');
    store.update = vi.fn(async () => { throw failure; });
    const callback = vi.fn(() => { throw new Error('logging unavailable'); });
    const tracker = createStoredTracker({ store, onStoreError: callback });
    const result = await tracker.capture(arrival('newsletter'), undefined, ID);
    expect(result).toMatchObject({ persisted: false, visitorId: ID, reason: 'recorded' });
    expect(result.snapshot?.firstTouch.source).toBe('newsletter');
    expect(result.cookieValue).toBeDefined();
    expect(callback).toHaveBeenCalledWith(failure, 'update');
  });

  it('bounds store latency and returns the same identity for a late successful write', async () => {
    vi.useFakeTimers();
    try {
      const { store } = fixture();
      const update = store.update;
      store.update = (id, updater) => new Promise((resolve) => {
        setTimeout(() => { void update(id, updater).then(resolve); }, 100);
      });
      const onStoreError = vi.fn();
      const tracker = createStoredTracker({ store, storeTimeoutMs: 10, onStoreError });
      const capture = tracker.capture(arrival('newsletter'));
      await vi.advanceTimersByTimeAsync(11);
      const result = await capture;
      expect(result.persisted).toBe(false);
      expect(result.visitorId).toMatch(/^[a-f0-9-]{36}$/u);
      expect(onStoreError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('timed out') }), 'update');
      await vi.advanceTimersByTimeAsync(100);
      expect((await tracker.read(undefined, result.visitorId, START + 200))?.firstTouch.source).toBe('newsletter');
    } finally { vi.useRealTimers(); }
  });

  it('falls back after read failure/timeout and does not mutate storage during reads', async () => {
    const { store } = fixture();
    const raw = createTracker().capture(arrival('newsletter')).cookieValue;
    const onStoreError = vi.fn();
    const tracker = createStoredTracker({ store, onStoreError, storeTimeoutMs: 5 });
    store.read = vi.fn(async () => { throw new Error('offline'); });
    expect((await tracker.read(raw, ID, START))?.firstTouch.source).toBe('newsletter');
    expect(onStoreError).toHaveBeenCalledWith(expect.any(Error), 'read');
    vi.useFakeTimers();
    try {
      store.read = () => new Promise(() => undefined);
      const reading = tracker.read(raw, ID, START);
      await vi.advanceTimersByTimeAsync(6);
      expect((await reading)?.firstTouch.source).toBe('newsletter');
    } finally { vi.useRealTimers(); }
    expect(store.update).not.toHaveBeenCalled();
  });

  it('serializes concurrent updates for an established identity without losing touches', async () => {
    const { store } = fixture();
    const tracker = createStoredTracker({ store });
    const first = await tracker.capture(arrival('first'), undefined, ID);
    const [left, right] = await Promise.all([
      tracker.capture(arrival('left', START + 1000), first.cookieValue, ID),
      tracker.capture(arrival('right', START + 1000), first.cookieValue, ID),
    ]);
    expect(left.visitorId).toBe(ID);
    expect(right.visitorId).toBe(ID);
    const result = await tracker.read(undefined, ID, START + 2000);
    expect(result?.touches.map((touch) => touch.source)).toEqual(['first', 'left', 'right']);
    expect(result?.totalTouchCount).toBe(3);
  });

  it('repairs invalid stored records using valid backup data', async () => {
    const { store, records } = fixture();
    const tracker = createStoredTracker({ store });
    const raw = createTracker().capture(arrival('first')).cookieValue;
    records.set(ID, { invalid: true } as unknown as AttributionState);
    expect((await tracker.read(raw, ID, START))?.firstTouch.source).toBe('first');
    const result = await tracker.capture(arrival('second', START + 1000), raw, ID);
    expect(result.snapshot?.touches.map((touch) => touch.source)).toEqual(['first', 'second']);
    expect(result.persisted).toBe(true);
  });

  it('enforces fixed expiry and configured server retention independently of cookie truncation', async () => {
    const { store } = fixture();
    const tracker = createStoredTracker({ store, serverMaxTouches: 3, ttlDays: 1 });
    let cookie: string | undefined;
    for (let index = 0; index < 6; index += 1) {
      const result = await tracker.capture(arrival(`source-${index}`, START + index * 1000), cookie, ID);
      cookie = result.cookieValue ?? cookie;
    }
    const result = await tracker.read(cookie, ID, START + 6000);
    expect(result?.touches.map((touch) => touch.source)).toEqual(['source-0', 'source-4', 'source-5']);
    expect(result?.totalTouchCount).toBe(6);
    expect(result?.droppedTouchCount).toBe(3);
    expect(result?.expiresAt).toBe(START + 86_400_000);
    expect(await tracker.read(cookie, ID, START + 86_400_000)).toBeNull();
    const renewed = await tracker.capture(arrival('fresh', START + 86_400_001), cookie, ID);
    expect(renewed.snapshot?.totalTouchCount).toBe(1);
    expect(renewed.snapshot?.firstTouch.source).toBe('fresh');
  });

  it('merges still-retained outage touches when storage recovers without duplicate endpoints', async () => {
    const { store } = fixture();
    const tracker = createStoredTracker({ store, maxTouches: 3 });
    let current = await tracker.capture(arrival('first'), undefined, ID);
    const working = store.update;
    store.update = async () => { throw new Error('offline'); };
    for (let index = 1; index <= 4; index += 1) {
      current = await tracker.capture(arrival(`outage-${index}`, START + index * 1000), current.cookieValue, ID);
    }
    store.update = working;
    const recovered = await tracker.capture(arrival('recovered', START + 5000), current.cookieValue, ID);
    expect(recovered.snapshot?.touches.map((touch) => touch.source)).toEqual(['first', 'outage-3', 'outage-4', 'recovered']);
    // Two touches evicted from the outage backup cannot be reconstructed.
    expect(recovered.snapshot?.droppedTouchCount).toBe(2);
    expect(recovered.snapshot?.totalTouchCount).toBe(6);
    const duplicate = await tracker.capture(arrival('recovered', START + 5001), recovered.cookieValue, ID);
    expect(duplicate.snapshot?.totalTouchCount).toBe(6);
  });

  it('includes newer backup touches at conversion even when writes failed but server reads still work', async () => {
    const { store, records } = fixture();
    const tracker = createStoredTracker({ store });
    const first = await tracker.capture(arrival('first'), undefined, ID);
    store.update = async () => { throw new Error('writes unavailable'); };
    const outage = await tracker.capture(arrival('outage', START + 1000), first.cookieValue, ID);
    const result = await tracker.read(outage.cookieValue, ID, START + 2000);
    expect(result?.touches.map((touch) => touch.source)).toEqual(['first', 'outage']);
    // read() constructs a combined snapshot; it never writes to the server.
    expect(records.get(ID)?.touches.map((touch) => touch.source)).toEqual(['first']);
  });

  it('recovers outage touches using stable anchors even when cookie fitting trimmed first-touch fields', async () => {
    const { store } = fixture();
    const tracker = createStoredTracker({ store, maxCookieBytes: 1024, maxFieldLength: 200 });
    const source = 'a'.repeat(190);
    const first = await tracker.capture({
      url: `https://example.com/?utm_source=${source}&utm_medium=email&utm_campaign=${'b'.repeat(190)}`,
      now: START,
    }, undefined, ID);
    const backup = createTracker().read(first.cookieValue, START);
    expect(backup?.firstTouch.fieldsTruncated).toBe(true);
    expect(backup?.firstTouch.source).not.toBe(source);
    const working = store.update;
    store.update = async () => { throw new Error('offline'); };
    const outage = await tracker.capture(arrival('outage', START + 1000), first.cookieValue, ID);
    store.update = working;
    const result = await tracker.capture(arrival('recovered', START + 2000), outage.cookieValue, ID);
    expect(result.snapshot?.firstTouch.source).toBe(source);
    expect(result.snapshot?.firstTouch.utm?.campaign).toBe('b'.repeat(190));
    expect(result.snapshot?.touches.map((touch) => touch.source)).toEqual([source, 'outage', 'recovered']);
    expect(result.snapshot?.totalTouchCount).toBe(3);
  });

  it('recovers different fallback touches with timestamps equal to the latest stored touch', async () => {
    const { store } = fixture();
    const tracker = createStoredTracker({ store });
    const first = await tracker.capture(arrival('first'), undefined, ID);
    const working = store.update;
    store.update = async () => { throw new Error('offline'); };
    const outage = await tracker.capture(arrival('outage'), first.cookieValue, ID);
    store.update = working;
    const result = await tracker.capture(arrival('recovered', START + 1), outage.cookieValue, ID);
    expect(result.snapshot?.touches.map((touch) => touch.source)).toEqual(['first', 'outage', 'recovered']);
    const reread = await tracker.read(result.cookieValue, ID, START + 1);
    expect(reread?.totalTouchCount).toBe(3);
  });

  it('still recovers newer outage touches from legacy records without stable touch IDs', async () => {
    const { store, records } = fixture();
    const tracker = createStoredTracker({ store });
    await tracker.capture(arrival('first'), undefined, ID);
    const legacy = records.get(ID)!;
    delete legacy.touches[0]!.id;
    const raw = encodeState(legacy);
    const working = store.update;
    store.update = async () => { throw new Error('offline'); };
    const outage = await tracker.capture(arrival('outage', START + 1000), raw, ID);
    store.update = working;
    const result = await tracker.capture(arrival('recovered', START + 2000), outage.cookieValue, ID);
    expect(result.snapshot?.touches.map((touch) => touch.source)).toEqual(['first', 'outage', 'recovered']);
    expect(result.snapshot?.firstTouch.id).toBeUndefined();
    expect(result.snapshot?.totalTouchCount).toBe(3);
  });

  it('inserts stable older backup touches into complete server history without changing its latest arrival', async () => {
    const { store } = fixture();
    const tracker = createStoredTracker({ store });
    const first = await tracker.capture(arrival('first'), undefined, ID);
    const working = store.update;
    store.update = async () => { throw new Error('offline'); };
    const intermediate = await tracker.capture(arrival('intermediate', START + 1000), first.cookieValue, ID);
    store.update = working;
    await tracker.capture(arrival('later', START + 2000), first.cookieValue, ID);
    const snapshot = await tracker.read(intermediate.cookieValue, ID, START + 3000);
    expect(snapshot?.touches.map((touch) => touch.source)).toEqual(['first', 'intermediate', 'later']);
    expect(snapshot?.lastTouch.source).toBe('later');
    expect(snapshot?.totalTouchCount).toBe(3);
    const result = await tracker.capture(arrival('newest', START + 3000), intermediate.cookieValue, ID);
    expect(result.snapshot?.touches.map((touch) => touch.source)).toEqual(['first', 'intermediate', 'later', 'newest']);
    expect(result.snapshot?.totalTouchCount).toBe(4);
    expect((await tracker.read(intermediate.cookieValue, ID, START + 3000))?.totalTouchCount).toBe(4);
  });

  it('keeps the same touch ID across atomic updater retries and the cookie fallback', async () => {
    const { store } = fixture();
    const working = store.update;
    const attemptedIds: (string | undefined)[] = [];
    store.update = (id, updater) => working(id, (current) => {
      attemptedIds.push(updater(current)?.touches.at(-1)?.id);
      const result = updater(current);
      attemptedIds.push(result?.touches.at(-1)?.id);
      return result;
    });
    const tracker = createStoredTracker({ store });
    const result = await tracker.capture(arrival('first'), undefined, ID);
    expect(attemptedIds[0]).toBeDefined();
    expect(new Set(attemptedIds).size).toBe(1);
    expect(createTracker().read(result.cookieValue, START)?.lastTouch.id).toBe(attemptedIds[0]);
  });

  it('does not double-count a timed-out write after its fallback touch already recovered on a newer request', async () => {
    vi.useFakeTimers();
    try {
      const { store } = fixture();
      const tracker = createStoredTracker({ store, storeTimeoutMs: 10 });
      const first = await tracker.capture(arrival('first'), undefined, ID);
      const working = store.update;
      store.update = (id, updater) => new Promise((resolve) => {
        setTimeout(() => { void working(id, updater).then(resolve); }, 100);
      });
      const waiting = tracker.capture(arrival('delayed', START + 1000), first.cookieValue, ID);
      await vi.advanceTimersByTimeAsync(11);
      const fallback = await waiting;
      expect(fallback.persisted).toBe(false);
      store.update = working;
      await tracker.capture(arrival('newer', START + 2000), fallback.cookieValue, ID);
      await vi.advanceTimersByTimeAsync(100);
      const result = await tracker.read(undefined, ID, START + 3000);
      expect(result?.touches.map((touch) => touch.source)).toEqual(['first', 'delayed', 'newer']);
      expect(result?.totalTouchCount).toBe(3);
      expect(new Set(result?.touches.map((touch) => touch.id)).size).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  it('does not replace newer server history when a delayed updater executes more than five minutes later', async () => {
    vi.useFakeTimers();
    try {
      let clock = START;
      const { store } = fixture();
      const tracker = createStoredTracker({ store, storeTimeoutMs: 10, now: () => clock });
      const first = await tracker.capture(arrival('first'), undefined, ID);
      const working = store.update;
      let executeDelayed: (() => Promise<AttributionState | null>) | undefined;
      store.update = (id, updater) => new Promise((resolve) => {
        executeDelayed = async () => {
          const result = await working(id, updater);
          resolve(result);
          return result;
        };
      });
      const waiting = tracker.capture(arrival('delayed', START + 1000), first.cookieValue, ID);
      await vi.advanceTimersByTimeAsync(11);
      const fallback = await waiting;
      store.update = working;
      clock = START + 600_000;
      await tracker.capture(arrival('newer', clock), fallback.cookieValue, ID);
      await executeDelayed!();
      const result = await tracker.read(undefined, ID, clock);
      expect(result?.touches.map((touch) => touch.source)).toEqual(['first', 'delayed', 'newer']);
      expect(result?.totalTouchCount).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  it('does not attach an expired delayed write to a newer visitor journey', async () => {
    vi.useFakeTimers();
    try {
      let clock = START;
      const { store } = fixture();
      const tracker = createStoredTracker({ store, ttlDays: 1 / 86_400, storeTimeoutMs: 10, now: () => clock });
      const first = await tracker.capture(arrival('old-first'), undefined, ID);
      const working = store.update;
      let executeDelayed: (() => Promise<AttributionState | null>) | undefined;
      store.update = (id, updater) => new Promise((resolve) => {
        executeDelayed = async () => {
          const result = await working(id, updater);
          resolve(result);
          return result;
        };
      });
      const waiting = tracker.capture(arrival('old-delayed', START + 100), first.cookieValue, ID);
      await vi.advanceTimersByTimeAsync(11);
      await waiting;
      store.update = working;
      clock = START + 2000;
      await tracker.capture(arrival('new-journey', clock), first.cookieValue, ID);
      await executeDelayed!();
      const result = await tracker.read(undefined, ID, clock);
      expect(result?.touches.map((touch) => touch.source)).toEqual(['new-journey']);
      expect(result?.totalTouchCount).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('does not overwrite rich stored endpoints with cookie-truncated or forged replacements', async () => {
    const { store } = fixture();
    const tracker = createStoredTracker({ store });
    const first = await tracker.capture(arrival('authoritative'), undefined, ID);
    const forged = createTracker().capture(arrival('forged', START + 100)).cookieValue;
    const result = await tracker.capture(arrival('next', START + 1000), forged, first.visitorId);
    expect(result.snapshot?.firstTouch.source).toBe('authoritative');
    expect(result.snapshot?.touches.map((touch) => touch.source)).toEqual(['authoritative', 'next']);
  });

  it('clears stored history, catches failed deletion, and rejects malformed visitor IDs', async () => {
    const { store, records } = fixture();
    const onStoreError = vi.fn();
    const tracker = createStoredTracker({ store, onStoreError });
    await tracker.capture(arrival('first'), undefined, ID);
    await tracker.delete(ID);
    expect(records.size).toBe(0);
    const failure = new Error('delete failed');
    store.delete = vi.fn(async () => { throw failure; });
    await tracker.delete(ID);
    expect(onStoreError).toHaveBeenCalledWith(failure, 'delete');
    await tracker.read(undefined, 'not-a-uuid', START);
    await tracker.delete('not-a-uuid');
    expect(store.read).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledTimes(1);
    const result = await tracker.capture(arrival('first'), undefined, 'not-a-uuid');
    expect(result.visitorId).not.toBe('not-a-uuid');
  });

  it.each([
    { storeTimeoutMs: 0 }, { storeTimeoutMs: 10_001 }, { storeTimeoutMs: 1.5 },
    { serverMaxTouches: 1 }, { serverMaxTouches: 10_001 }, { serverMaxTouches: 2.5 },
    { visitorCookieName: '' }, { visitorCookieName: 'bad;name' },
    { visitorCookieName: 'x'.repeat(65) }, { visitorCookieName: 'tracknext' },
    { visitorCookieName: '__Host-visitor', cookieDomain: 'example.com' },
  ])('rejects invalid stored-tracker options: %j', (options) => {
    expect(() => createStoredTracker({ store: fixture().store, ...options })).toThrow(TypeError);
  });
});
