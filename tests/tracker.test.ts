import { describe, expect, it } from 'vitest';
import { createTracker } from '../src/tracker.js';
import { advanceState } from '../src/tracker.js';
import type { AttributionState, TrackerOptions } from '../src/types.js';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 20);
const input = (source: string, now = START) => ({
  url: `https://example.com/landing?utm_source=${source}&utm_medium=email&utm_campaign=Launch`,
  now,
});
const encodeFixture = (state: unknown) => Buffer.from(JSON.stringify(state)).toString('base64url');

describe('marketing journey history', () => {
  it('assigns stable touch IDs that survive cookie pressure and later decoding', () => {
    const tracker = createTracker({ maxCookieBytes: 1_024 });
    const first = tracker.capture(input('newsletter'));
    expect(first.snapshot?.firstTouch).toHaveProperty('id', expect.stringMatching(/^[0-9a-f-]{36}$/));
    const next = tracker.capture({ url: `https://example.com/?utm_source=later&utm_campaign=${encodeURIComponent('あ'.repeat(150))}`, now: START + DAY }, first.cookieValue);
    const decoded = tracker.read(next.cookieValue, START + DAY);
    expect(decoded?.firstTouch).toHaveProperty('id', first.snapshot?.firstTouch.id);
    expect(decoded?.lastTouch.id).not.toBe(decoded?.firstTouch.id);
  });

  it('does not count a replayed touch ID twice when duplicate suppression is disabled', () => {
    const tracker = createTracker({ dedupeWindowSeconds: 0 });
    const first = tracker.capture(input('newsletter'));
    const decision = { kind: 'touch' as const, touch: first.snapshot!.firstTouch };
    const result = advanceState(first.snapshot!, decision, START + DAY, { dedupeWindowSeconds: 0 });
    expect(result.reason).toBe('duplicate');
    expect(result.state?.totalTouchCount).toBe(1);
  });
  it('retains first, intermediate, and last marketing arrivals at conversion', () => {
    const tracker = createTracker();
    const first = tracker.capture(input('google'));
    const middle = tracker.capture(input('newsletter', START + DAY), first.cookieValue);
    const last = tracker.capture(input('linkedin', START + 2 * DAY), middle.cookieValue);
    const snapshot = tracker.read(last.cookieValue, START + 2 * DAY);
    expect(snapshot?.firstTouch.source).toBe('google');
    expect(snapshot?.middleTouches.map((touch) => touch.source)).toEqual(['newsletter']);
    expect(snapshot?.lastNonDirectTouch?.source).toBe('linkedin');
    expect(snapshot?.lastTouch.source).toBe('linkedin');
    expect(snapshot?.totalTouchCount).toBe(3);
    expect(snapshot?.historyTruncated).toBe(false);
  });

  it('remembers a direct first arrival without fabricating a non-direct source', () => {
    const tracker = createTracker();
    const first = tracker.capture({ url: 'https://example.com/', now: START });
    expect(first.snapshot?.firstTouch.source).toBe('direct');
    expect(first.snapshot?.lastNonDirectTouch).toBeNull();
    expect(first.snapshot?.middleTouches).toEqual([]);
    const next = tracker.capture(input('newsletter', START + DAY), first.cookieValue);
    expect(next.snapshot?.firstTouch.source).toBe('direct');
    expect(next.snapshot?.lastNonDirectTouch?.source).toBe('newsletter');
  });

  it('does not let direct return visits replace a known marketing touch or extend retention', () => {
    const tracker = createTracker();
    const first = tracker.capture(input('newsletter'));
    const direct = tracker.capture({ url: 'https://example.com/pricing', now: START + DAY }, first.cookieValue);
    expect(direct.reason).toBe('direct_return');
    expect(direct.cookieValue).toBeUndefined();
    expect(direct.snapshot?.lastTouch.source).toBe('newsletter');
    expect(direct.snapshot?.expiresAt).toBe(START + 90 * DAY);
  });

  it('ignores internal campaign links without mutating the previous snapshot', () => {
    const tracker = createTracker();
    const first = tracker.capture(input('newsletter'));
    const internal = tracker.capture({ ...input('banner', START + DAY), referrer: 'https://example.com/' }, first.cookieValue);
    expect(internal.reason).toBe('ignored');
    expect(internal.cookieValue).toBeUndefined();
    expect(internal.snapshot?.totalTouchCount).toBe(1);
  });

  it('suppresses repeated campaign evidence within a window, including a different landing path', () => {
    const tracker = createTracker();
    const first = tracker.capture(input('newsletter'));
    const repeated = tracker.capture({ ...input('newsletter', START + 10_000), url: 'https://example.com/pricing?utm_source=newsletter&utm_medium=email&utm_campaign=Launch' }, first.cookieValue);
    expect(repeated.reason).toBe('duplicate');
    expect(repeated.cookieValue).toBeUndefined();
    expect(repeated.snapshot?.totalTouchCount).toBe(1);
  });

  it('records a later arrival from the same campaign after the deduplication window', () => {
    const tracker = createTracker();
    const first = tracker.capture(input('newsletter'));
    const later = tracker.capture(input('newsletter', START + 1_800_000), first.cookieValue);
    expect(later.reason).toBe('recorded');
    expect(later.snapshot?.totalTouchCount).toBe(2);
  });

  it('records a changed campaign immediately even when source and medium match', () => {
    const tracker = createTracker();
    const first = tracker.capture(input('newsletter'));
    const changed = tracker.capture({ url: 'https://example.com/?utm_source=newsletter&utm_medium=email&utm_campaign=New', now: START + 1 }, first.cookieValue);
    expect(changed.snapshot?.totalTouchCount).toBe(2);
  });

  it('allows applications to turn duplicate suppression off', () => {
    const tracker = createTracker({ dedupeWindowSeconds: 0 });
    const first = tracker.capture(input('newsletter'));
    const repeated = tracker.capture(input('newsletter', START + 1), first.cookieValue);
    expect(repeated.snapshot?.totalTouchCount).toBe(2);
  });

  it('keeps the first and most recent touches and reports exactly how many were dropped', () => {
    const tracker = createTracker({ maxTouches: 3 });
    let cookie: string | undefined;
    for (let index = 0; index < 6; index += 1) {
      cookie = tracker.capture(input(`campaign${index}`, START + index * DAY), cookie).cookieValue;
    }
    const snapshot = tracker.read(cookie, START + 6 * DAY);
    expect(snapshot?.touches.map((touch) => touch.source)).toEqual(['campaign0', 'campaign4', 'campaign5']);
    expect(snapshot?.middleTouches.map((touch) => touch.source)).toEqual(['campaign4']);
    expect(snapshot?.totalTouchCount).toBe(6);
    expect(snapshot?.droppedTouchCount).toBe(3);
    expect(snapshot?.historyTruncated).toBe(true);
  });

  it('expires the whole journey at the fixed retention boundary and starts a new one', () => {
    const tracker = createTracker({ ttlDays: 1 });
    const first = tracker.capture(input('first'));
    const later = tracker.capture(input('later', START + DAY - 1), first.cookieValue);
    expect(later.snapshot?.expiresAt).toBe(START + DAY);
    expect(tracker.read(later.cookieValue, START + DAY)).toBeNull();
    const fresh = tracker.capture(input('fresh', START + DAY), later.cookieValue);
    expect(fresh.snapshot?.firstTouch.source).toBe('fresh');
    expect(fresh.snapshot?.totalTouchCount).toBe(1);
  });

  it('uses the injected clock for capture and reading by default', () => {
    const tracker = createTracker({ now: () => START });
    const result = tracker.capture({ url: 'https://example.com/?utm_source=test' });
    expect(result.snapshot?.firstTouch.timestamp).toBe(START);
    expect(tracker.read(result.cookieValue)?.firstTouch.timestamp).toBe(START);
  });
});

describe('cookie boundaries and untrusted input', () => {
  it('keeps a direct first touch readable when later Unicode evidence forces minimal cookies', () => {
    const tracker = createTracker({
      maxCookieBytes: 1_024, cookieName: 'n'.repeat(64),
      cookieDomain: ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.'),
    });
    const initial = tracker.capture({ url: 'https://example.com/', now: START });
    const next = tracker.capture({ url: `https://example.com/?utm_source=${encodeURIComponent('😀'.repeat(75))}&utm_medium=${encodeURIComponent('😀'.repeat(75))}`, now: START + DAY }, initial.cookieValue);
    expect(tracker.read(next.cookieValue, START + DAY)?.firstTouch).toMatchObject({ source: 'direct', medium: 'none', evidence: 'none' });
  });
  it('can read normalized Unicode sources whose lowercase form expands in length', () => {
    const tracker = createTracker({ maxFieldLength: 200 });
    const result = tracker.capture({ url: `https://example.com/?utm_source=${encodeURIComponent('İ'.repeat(110))}&utm_medium=${encodeURIComponent('İ'.repeat(110))}`, now: START });
    const decoded = tracker.read(result.cookieValue, START);
    expect(decoded?.firstTouch.source.length).toBeLessThanOrEqual(200);
    expect(decoded?.firstTouch.medium.length).toBeLessThanOrEqual(200);
    expect(decoded?.firstTouch.fieldsTruncated).toBe(true);
  });
  it('still fits both endpoints with worst-case Unicode and long valid cookie attributes', () => {
    const tracker = createTracker({
      maxCookieBytes: 1_024,
      cookieName: 'x'.repeat(64),
      cookieDomain: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`,
    });
    const first = tracker.capture({ url: `https://example.com/?utm_source=${encodeURIComponent('😀'.repeat(75))}&utm_medium=${encodeURIComponent('あ'.repeat(150))}`, now: START });
    const second = tracker.capture({ url: `https://example.com/?utm_source=${encodeURIComponent('😁'.repeat(75))}&utm_medium=${encodeURIComponent('い'.repeat(150))}`, now: START + DAY }, first.cookieValue);
    expect(Buffer.byteLength(second.cookieValue!) + 64 + 1 + 253 + 128).toBeLessThanOrEqual(1_024);
    expect(tracker.read(second.cookieValue, START + DAY)?.touches).toHaveLength(2);
  });

  it('rounds fractional retention durations to readable integer millisecond timestamps', () => {
    const tracker = createTracker({ ttlDays: 1.23456789 });
    const capture = tracker.capture(input('fractional'));
    expect(tracker.read(capture.cookieValue, START)?.firstTouch.source).toBe('fractional');
  });
  it('round trips Unicode evidence into a cookie-safe value within the full cookie budget', () => {
    const tracker = createTracker({ maxCookieBytes: 1_024 });
    const campaign = 'あ😀'.repeat(100);
    const result = tracker.capture({ url: `https://example.com/?utm_source=Newsletter&utm_campaign=${encodeURIComponent(campaign)}&utm_content=${encodeURIComponent(campaign)}`, now: START });
    expect(result.cookieValue).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.byteLength(`tracknext=${result.cookieValue}`) + 128).toBeLessThanOrEqual(1_024);
    const snapshot = tracker.read(result.cookieValue, START);
    expect(snapshot?.firstTouch.source).toBe('newsletter');
    expect(snapshot?.firstTouch.fieldsTruncated).toBe(true);
  });

  it('preserves first and last touch under byte pressure rather than emitting oversized cookies', () => {
    const tracker = createTracker({ maxCookieBytes: 1_024 });
    let cookie: string | undefined;
    for (const source of ['first', 'second', 'third']) {
      const result = tracker.capture({ url: `https://example.com/?utm_source=${source}&utm_campaign=${encodeURIComponent('あ'.repeat(150))}`, now: START }, cookie);
      cookie = result.cookieValue;
      expect(Buffer.byteLength(`tracknext=${cookie}`) + 128).toBeLessThanOrEqual(1_024);
    }
    const snapshot = tracker.read(cookie, START);
    expect(snapshot?.firstTouch.source).toBe('first');
    expect(snapshot?.lastTouch.source).toBe('third');
    expect(snapshot?.touches.length).toBeGreaterThanOrEqual(2);
  });

  it.each([undefined, '', 'not.a.cookie', 'e30', 'a'.repeat(30_000)])('rejects invalid cookie (case %#) without throwing', (raw) => {
    expect(createTracker().read(raw, START)).toBeNull();
  });

  it('rejects malformed optional fields and replaces a corrupt existing cookie on the next arrival', () => {
    const tracker = createTracker();
    const initial = tracker.capture(input('first'));
    const state = JSON.parse(Buffer.from(initial.cookieValue!, 'base64url').toString()) as AttributionState;
    const corrupted = { ...state, touches: [{ ...state.touches[0], clickIds: ['bad'], landingPath: { nested: true } }] };
    expect(tracker.read(encodeFixture(corrupted), START)).toBeNull();
    const next = tracker.capture(input('fresh'), encodeFixture(corrupted));
    expect(next.snapshot?.firstTouch.source).toBe('fresh');
  });

  it('rejects unknown schema versions, impossible timestamps and inconsistent counts', () => {
    const tracker = createTracker();
    const initial = tracker.capture(input('first'));
    const state = JSON.parse(Buffer.from(initial.cookieValue!, 'base64url').toString()) as AttributionState;
    expect(tracker.read(encodeFixture({ ...state, version: 2 }), START)).toBeNull();
    expect(tracker.read(encodeFixture({ ...state, totalTouchCount: 0 }), START)).toBeNull();
    expect(tracker.read(encodeFixture({ ...state, droppedTouchCount: 1 }), START)).toBeNull();
    expect(tracker.read(encodeFixture({ ...state, touches: [{ ...state.touches[0], timestamp: START + DAY }] }), START)).toBeNull();
    expect(tracker.read(encodeFixture({ ...state, expiresAt: START + 1_000 * DAY }), START)).toBeNull();
  });

  it('returns independent snapshots so consumer mutation cannot corrupt later reads', () => {
    const tracker = createTracker();
    const initial = tracker.capture(input('newsletter'));
    initial.snapshot!.firstTouch.source = 'changed';
    expect(tracker.read(initial.cookieValue, START)?.firstTouch.source).toBe('newsletter');
  });

  it.each([
    { maxTouches: 1 }, { maxTouches: 2.5 }, { maxCookieBytes: 100 },
    { maxCookieBytes: 10_000 }, { ttlDays: 0 }, { ttlDays: Number.NaN },
    { dedupeWindowSeconds: -1 }, { cookieName: 'bad;name' },
    { cookieDomain: 'https://example.com' }, { maxFieldLength: 0 },
  ] satisfies TrackerOptions[])('rejects invalid configuration %j before request handling', (options) => {
    expect(() => createTracker(options)).toThrow();
  });
});
