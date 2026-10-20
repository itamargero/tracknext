import { parseAttribution } from './parse.js';
import type {
  AttributionChannel, AttributionCookieOptions, AttributionDecision, AttributionSnapshot,
  AttributionState, AttributionTouch, AttributionTracker, TrackerOptions, UtmParameters,
} from './types.js';

const DAY = 86_400_000;
const CHANNELS = new Set<AttributionChannel>([
  'direct', 'organic_search', 'paid_search', 'paid_social', 'social',
  'email', 'referral', 'ai_referral', 'display', 'unknown',
]);
const UTM_KEYS = [
  'source', 'medium', 'campaign', 'term', 'content', 'id',
  'sourcePlatform', 'creativeFormat', 'marketingTactic',
] as const;
const CLICK_ID_KEYS = new Set(['gclid', 'gbraid', 'wbraid', 'dclid', 'msclkid', 'ttclid', 'twclid', 'li_fat_id', 'fbclid']);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Rebuild validated input instead of returning the client's object unchecked. */
function decodeTouch(value: unknown, now: number): AttributionTouch | null {
  if (!isRecord(value) || !validString(value.source, 200) || !validString(value.medium, 200)
    || !CHANNELS.has(value.channel as AttributionChannel)
    || !['utm', 'click_id', 'referrer', 'none'].includes(String(value.evidence))
    || !validTime(value.timestamp) || value.timestamp > now + 300_000) return null;
  const touch: AttributionTouch = {
    source: value.source, medium: value.medium, channel: value.channel as AttributionChannel,
    evidence: value.evidence as AttributionTouch['evidence'], timestamp: value.timestamp,
  };
  if (value.id !== undefined) {
    if (typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.id)) return null;
    touch.id = value.id;
  }
  if (value.fieldsTruncated !== undefined) {
    if (typeof value.fieldsTruncated !== 'boolean') return null;
    touch.fieldsTruncated = value.fieldsTruncated;
  }
  if (value.referrer !== undefined) {
    if (!validString(value.referrer, 253) || /[/?#\s]/u.test(value.referrer)) return null;
    touch.referrer = value.referrer;
  }
  if (value.landingPath !== undefined) {
    if (!validString(value.landingPath, 512) || !value.landingPath.startsWith('/') || /[?#]/u.test(value.landingPath)) return null;
    touch.landingPath = value.landingPath;
  }
  if (value.utm !== undefined) {
    if (!isRecord(value.utm) || Object.keys(value.utm).some((key) => !UTM_KEYS.includes(key as typeof UTM_KEYS[number]))) return null;
    const utm: UtmParameters = {};
    for (const key of UTM_KEYS) {
      const field = value.utm[key];
      if (field !== undefined) {
        if (!validString(field, 200)) return null;
        utm[key] = field;
      }
    }
    touch.utm = utm;
  }
  if (value.clickIds !== undefined) {
    if (!isRecord(value.clickIds)) return null;
    const clickIds: Record<string, string> = {};
    for (const [key, field] of Object.entries(value.clickIds)) {
      if (!CLICK_ID_KEYS.has(key) || !validString(field, 200)) return null;
      clickIds[key] = field;
    }
    touch.clickIds = clickIds;
  }
  if (touch.evidence === 'none' && (touch.source !== 'direct' || touch.medium !== 'none' || touch.channel !== 'direct')) return null;
  if (touch.channel === 'direct' && touch.evidence !== 'none') return null;
  return touch;
}

/** Base64url avoids cookie percent-encoding amplification for Unicode campaigns. */
export function encodeState(state: AttributionState): string {
  const bytes = encoder.encode(JSON.stringify(state));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

/** Validate both cookie data and state returned by optional storage adapters. */
export function validateState(value: unknown, now: number, ttlDays: number, maxTouches = 20): AttributionState | null {
  if (!validTime(now) || !isRecord(value) || value.version !== 1 || !Array.isArray(value.touches)
    || value.touches.length < 1 || value.touches.length > maxTouches
    || !Number.isSafeInteger(value.totalTouchCount) || !Number.isSafeInteger(value.droppedTouchCount)
    || typeof value.totalTouchCount !== 'number' || typeof value.droppedTouchCount !== 'number'
    || value.droppedTouchCount < 0 || value.totalTouchCount !== value.touches.length + value.droppedTouchCount
    || !validTime(value.expiresAt) || value.expiresAt <= now) return null;
  const touches: AttributionTouch[] = [];
  for (const candidate of value.touches) {
    const touch = decodeTouch(candidate, now);
    if (!touch || (touches.length > 0 && (touch.evidence === 'none' || touch.timestamp < touches[touches.length - 1]!.timestamp))) return null;
    touches.push(touch);
  }
  const first = touches[0]!;
  const expiresAt = Math.min(value.expiresAt, first.timestamp + Math.round(ttlDays * DAY));
  if (expiresAt <= now || value.expiresAt <= touches[touches.length - 1]!.timestamp
    || value.expiresAt > first.timestamp + 400 * DAY) return null;
  return { version: 1, touches, totalTouchCount: value.totalTouchCount, droppedTouchCount: value.droppedTouchCount, expiresAt };
}

function decodeState(raw: string | undefined, now: number, ttlDays: number): AttributionState | null {
  // Bound work on attacker-controlled cookies before decoding or parsing JSON.
  if (!raw || raw.length > 8_192 || !/^[A-Za-z0-9_-]+$/u.test(raw) || !validTime(now)) return null;
  try {
    const binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const value: unknown = JSON.parse(decoder.decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
    return validateState(value, now, ttlDays);
  } catch {
    return null;
  }
}

export function toSnapshot(state: AttributionState): AttributionSnapshot {
  const firstTouch = state.touches[0]!;
  const lastTouch = state.touches[state.touches.length - 1]!;
  return {
    ...state, firstTouch, lastTouch,
    lastNonDirectTouch: [...state.touches].reverse().find((touch) => touch.evidence !== 'none') ?? null,
    middleTouches: state.touches.slice(1, -1), historyTruncated: state.droppedTouchCount > 0,
  };
}

function evidenceKey(touch: AttributionTouch): string {
  // Landing path is deliberately excluded: moving/reloading must not invent a campaign.
  return JSON.stringify([
    touch.source, touch.medium, touch.evidence,
    UTM_KEYS.map((key) => touch.utm?.[key] ?? null),
    [...CLICK_ID_KEYS].map((key) => touch.clickIds?.[key] ?? null),
    touch.evidence === 'referrer' ? touch.referrer : null,
  ]);
}

function dropOldestMiddle(state: AttributionState): void {
  state.touches.splice(1, 1);
  state.droppedTouchCount += 1;
}

/** Shared transition for bounded cookies and atomic, longer server-side histories. */
export function advanceState(
  previous: AttributionState | null, decision: AttributionDecision,
  now: number, options: TrackerOptions, maxTouches = options.maxTouches ?? 5,
): { state: AttributionState | null; reason: 'recorded' | 'ignored' | 'duplicate' | 'direct_return' } {
  if (decision.kind === 'ignore') return { reason: 'ignored', state: previous };
  if (previous && decision.kind === 'direct') return { reason: 'direct_return', state: previous };
  const touch = structuredClone(decision.touch);
  touch.id ??= crypto.randomUUID();
  // Store callbacks may be retried, and an operation can finish after a timeout.
  // Event identity is independent of the configurable campaign dedupe window.
  if (previous?.touches.some((existing) => existing.id === touch.id)) {
    return { reason: 'duplicate', state: previous };
  }
  const last = previous?.touches[previous.touches.length - 1];
  const duplicateWindow = (options.dedupeWindowSeconds ?? 1_800) * 1_000;
  if (last && now >= last.timestamp && now - last.timestamp < duplicateWindow && evidenceKey(last) === evidenceKey(touch)) {
    return { reason: 'duplicate', state: previous };
  }
  if (last && touch.timestamp < last.timestamp) touch.timestamp = last.timestamp;
  const state: AttributionState = previous
    ? { ...previous, touches: [...previous.touches, touch], totalTouchCount: previous.totalTouchCount + 1 }
    : { version: 1, touches: [touch], totalTouchCount: 1, droppedTouchCount: 0, expiresAt: now + Math.round((options.ttlDays ?? 90) * DAY) };
  while (state.touches.length > maxTouches) dropOldestMiddle(state);
  return { reason: 'recorded', state };
}

function trimTouch(touch: AttributionTouch, length: number): AttributionTouch {
  const trimmed: AttributionTouch = { ...touch, fieldsTruncated: true };
  delete trimmed.clickIds;
  trimmed.source = touch.evidence === 'none' ? 'direct' : [...touch.source].slice(0, length).join('');
  trimmed.medium = touch.evidence === 'none' ? 'none' : [...touch.medium].slice(0, length).join('');
  if (touch.utm) {
    trimmed.utm = {};
    for (const key of UTM_KEYS) {
      const field = touch.utm[key];
      if (field) trimmed.utm[key] = [...field].slice(0, length).join('');
    }
  }
  if (touch.landingPath) trimmed.landingPath = touch.landingPath.slice(0, length);
  return trimmed;
}

function fitCookie(state: AttributionState, budget: number, overhead: number): string {
  let raw = encodeState(state);
  while (raw.length + overhead > budget && state.touches.length > 2) {
    dropOldestMiddle(state);
    raw = encodeState(state);
  }
  for (const length of [80, 40, 16]) {
    if (raw.length + overhead <= budget) break;
    state.touches = state.touches.map((touch) => trimTouch(touch, length));
    raw = encodeState(state);
  }
  if (raw.length + overhead > budget) {
    state.touches = state.touches.map((touch) => {
      const minimal = trimTouch(touch, 16);
      delete minimal.utm;
      delete minimal.referrer;
      delete minimal.landingPath;
      return minimal;
    });
    raw = encodeState(state);
  }
  for (const length of [8, 4, 1]) {
    if (raw.length + overhead <= budget) break;
    state.touches = state.touches.map((touch) => trimTouch(touch, length));
    raw = encodeState(state);
  }
  if (raw.length + overhead > budget) throw new Error('TrackNext could not fit the attribution cookie');
  return raw;
}

function validateOptions(options: TrackerOptions): void {
  const inRange = (value: number | undefined, min: number, max: number, integer = false) =>
    value === undefined || (Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)));
  if (!inRange(options.maxTouches, 2, 20, true) || !inRange(options.maxCookieBytes, 1_024, 3_800, true)
    || !inRange(options.ttlDays, 1 / 86_400, 400) || !inRange(options.dedupeWindowSeconds, 0, 86_400, true)
    || !inRange(options.maxFieldLength, 1, 200, true)) throw new TypeError('Invalid TrackNext retention, history, field length, or cookie budget option');
  if (options.cookieName !== undefined && (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(options.cookieName) || options.cookieName.length > 64)) {
    throw new TypeError('TrackNext cookieName must be a valid cookie token of at most 64 characters');
  }
  if (options.cookieDomain !== undefined && (!/^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(options.cookieDomain)
    || options.cookieDomain.length > 253 || options.cookieDomain.includes('..'))) throw new TypeError('TrackNext cookieDomain must be a hostname, not a URL');
  if (options.cookieName?.startsWith('__Host-') && (options.cookieDomain || options.secure === false)) {
    throw new TypeError('__Host- cookies require HTTPS and cannot have a cookieDomain');
  }
}

/** Turn a longer stored history into a bounded backup without mutating the stored record. */
export function toCookie(state: AttributionState, options: TrackerOptions = {}): { cookieValue: string; snapshot: AttributionSnapshot } {
  const backup = structuredClone(state);
  while (backup.touches.length > (options.maxTouches ?? 5)) dropOldestMiddle(backup);
  const overhead = (options.cookieName ?? 'tracknext').length + 1 + 128 + (options.cookieDomain?.length ?? 0);
  const cookieValue = fitCookie(backup, options.maxCookieBytes ?? 3_600, overhead);
  return { cookieValue, snapshot: toSnapshot(backup) };
}

export function createTracker(options: TrackerOptions = {}): AttributionTracker {
  validateOptions(options);
  const ttlDays = options.ttlDays ?? 90;
  const maxTouches = options.maxTouches ?? 5;
  const budget = options.maxCookieBytes ?? 3_600;
  const clock = options.now ?? Date.now;
  const cookie: Readonly<AttributionCookieOptions> = Object.freeze({
    name: options.cookieName ?? 'tracknext', path: '/', httpOnly: true, sameSite: 'lax',
    secure: options.secure, domain: options.cookieDomain,
  });
  const overhead = cookie.name.length + 1 + 128 + (cookie.domain?.length ?? 0);
  return {
    cookie,
    read(raw, now = clock()) {
      const state = decodeState(raw, now, ttlDays);
      return state ? toSnapshot(state) : null;
    },
    capture(input, previousCookie) {
      const now = input.now ?? clock();
      const previous = decodeState(previousCookie, now, ttlDays);
      const decision = parseAttribution({ ...input, now }, options);
      const { state, reason } = advanceState(previous, decision, now, options, maxTouches);
      if (!state) return { reason, snapshot: null };
      if (reason !== 'recorded') return { reason, snapshot: toSnapshot(state) };
      const cookieValue = fitCookie(state, budget, overhead);
      return { reason, cookieValue, snapshot: toSnapshot(state) };
    },
  };
}
