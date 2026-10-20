import { NextRequest, NextResponse } from 'next/server.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAttribution, createStoredAttribution } from '../src/next.js';
import type { AttributionState, AttributionStore } from '../src/types.js';

const START = Date.UTC(2026, 9, 20, 12);

function documentRequest(path = '/', headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest(`https://shop.example${path}`, {
    method,
    headers: { accept: 'text/html,application/xhtml+xml', ...headers },
  });
}

describe('Next.js adapter', () => {
  it('recognizes a loopback Host referrer when NextURL canonicalizes the IP to localhost', () => {
    const attribution = createAttribution({ now: () => START });
    const request = new NextRequest('http://127.0.0.1:3187/pricing?utm_source=internal_banner', {
      headers: { host: '127.0.0.1:3187', referer: 'http://127.0.0.1:3187/', accept: 'text/html' },
    });
    expect(attribution.proxy(request).cookies.get('tracknext')).toBeUndefined();
  });
  afterEach(() => vi.restoreAllMocks());
  it('captures a document arrival and reads the browser-returned cookie', () => {
    const attribution = createAttribution({ now: () => START });
    const response = attribution.proxy(documentRequest('/offer?utm_source=Newsletter&utm_medium=email'));
    const cookie = response.cookies.get('tracknext');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 90 * 86400 });
    expect(attribution.read(response.cookies)?.firstTouch).toMatchObject({
      source: 'newsletter', medium: 'email', landingPath: '/offer',
    });
    // Response cookies become request cookies only after the browser returns them.
    expect(attribution.read(documentRequest().cookies)).toBeNull();
    const returning = documentRequest('/', { cookie: `tracknext=${cookie?.value}` });
    expect(attribution.read(returning.cookies)?.totalTouchCount).toBe(1);
  });

  it('records later campaigns while ignoring direct returns and internal UTMs', () => {
    let now = START;
    const attribution = createAttribution({ now: () => now });
    const first = attribution.proxy(documentRequest('/?utm_source=google&utm_medium=organic'));
    const initialCookie = first.cookies.get('tracknext')?.value;
    now += 86400000;
    const second = attribution.proxy(documentRequest('/?utm_source=newsletter&utm_medium=email', { cookie: `tracknext=${initialCookie}` }));
    const updatedCookie = second.cookies.get('tracknext')?.value;
    const snapshot = attribution.read(second.cookies);
    expect(snapshot?.touches).toHaveLength(2);
    expect(snapshot?.firstTouch.source).toBe('google');
    expect(snapshot?.lastTouch.source).toBe('newsletter');
    for (const request of [
      documentRequest('/about', { cookie: `tracknext=${updatedCookie}` }),
      documentRequest('/about?utm_source=internal&utm_medium=email', { cookie: `tracknext=${updatedCookie}`, referer: 'https://shop.example/' }),
    ]) {
      expect(attribution.proxy(request).cookies.get('tracknext')).toBeUndefined();
    }
  });

  it.each([
    ['/api', {}, 'GET'],
    ['/api/leads', {}, 'GET'],
    ['/_next/static/chunk.js', {}, 'GET'],
    ['/robots.txt', {}, 'GET'],
    ['/sitemap.xml', {}, 'GET'],
    ['/favicon.ico', {}, 'GET'],
    ['/manifest.webmanifest', {}, 'GET'],
    ['/offers', { accept: 'application/json' }, 'GET'],
    ['/offers', { accept: '' }, 'GET'],
    ['/offers', { accept: 'text/x-component' }, 'GET'],
    ['/offers', { rsc: '1' }, 'GET'],
    ['/offers', { 'next-router-prefetch': '1' }, 'GET'],
    ['/offers', { purpose: 'prefetch' }, 'GET'],
    ['/offers', { 'sec-purpose': 'prefetch;prerender' }, 'GET'],
    ['/offers', { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' }, 'GET'],
    ['/offers', { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }, 'GET'],
    ['/offers', { 'sec-fetch-dest': 'image' }, 'GET'],
    ['/offers', {}, 'POST'],
    ['/offers', {}, 'HEAD'],
  ] as const)('does not capture non-document request %s %j %s', (path, headers, method) => {
    const attribution = createAttribution({ now: () => START });
    const response = attribution.proxy(documentRequest(`${path}?utm_source=newsletter&utm_medium=email`, headers, method));
    expect(response.cookies.get('tracknext')).toBeUndefined();
  });

  it('accepts verified top-level documents and legitimate dotted routes', () => {
    const attribution = createAttribution({ now: () => START });
    const response = attribution.proxy(documentRequest('/releases/v1.2?utm_source=newsletter', {
      accept: '*/*', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate',
    }));
    expect(attribution.read(response.cookies)?.firstTouch.landingPath).toBe('/releases/v1.2');
  });

  it('preserves existing response identity, auth cookies, redirects, and rewrites', () => {
    const attribution = createAttribution({ now: () => START });
    const request = documentRequest('/?utm_source=newsletter');
    for (const response of [
      NextResponse.redirect(new URL('/welcome', request.url)),
      NextResponse.rewrite(new URL('/localized', request.url)),
    ]) {
      response.cookies.set('session', 'existing', { httpOnly: true });
      response.headers.set('x-custom', 'keep');
      const originalHeaders = new Headers(response.headers);
      expect(attribution.capture(request, response)).toBe(response);
      expect(response.cookies.get('session')?.value).toBe('existing');
      expect(response.cookies.get('tracknext')).toBeDefined();
      for (const name of ['location', 'x-middleware-rewrite', 'x-custom']) {
        expect(response.headers.get(name)).toBe(originalHeaders.get(name));
      }
    }
  });

  it('keeps acquisition on an external OAuth redirect without forwarding attribution', () => {
    const attribution = createAttribution({ now: () => START });
    const location = 'https://accounts.example/login?return_to=https%3A%2F%2Fshop.example';
    const response = NextResponse.redirect(location);
    response.cookies.set('auth_state', 'existing', { httpOnly: true });
    expect(attribution.capture(documentRequest('/?utm_source=newsletter&utm_medium=email'), response)).toBe(response);
    expect(attribution.read(response.cookies)?.firstTouch.source).toBe('newsletter');
    expect(response.cookies.get('auth_state')?.value).toBe('existing');
    expect(response.headers.get('location')).toBe(location);
    expect(response.headers.has('x-middleware-request-cookie')).toBe(false);
  });

  it('does not create new attribution on an excluded authentication return', () => {
    const attribution = createAttribution({ now: () => START, ignoredReferrers: ['accounts.example'] });
    const response = NextResponse.rewrite('https://shop.example/account');
    response.cookies.set('session', 'new');
    attribution.capture(documentRequest('/callback?utm_source=oauth', { referer: 'https://accounts.example/login' }), response);
    expect(response.cookies.get('tracknext')).toBeUndefined();
    expect(response.cookies.get('session')?.value).toBe('new');
    expect(response.headers.get('x-middleware-rewrite')).toBe('https://shop.example/account');
  });

  it('skips error responses', () => {
    const attribution = createAttribution({ now: () => START });
    const request = documentRequest('/?utm_source=newsletter');
    for (const response of [
      new NextResponse(null, { status: 500 }),
      new NextResponse(null, { status: 404 }),
    ]) {
      expect(attribution.capture(request, response)).toBe(response);
      expect(response.cookies.get('tracknext')).toBeUndefined();
    }
  });

  it('sets fixed expiry instead of extending the journey on later campaigns', () => {
    let now = START;
    // Next's cookie API derives Expires from Date.now() when Max-Age is set.
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const attribution = createAttribution({ ttlDays: 2, now: () => now });
    const first = attribution.proxy(documentRequest('/?utm_source=first'));
    now += 86400000;
    const second = attribution.proxy(documentRequest('/?utm_source=second', { cookie: `tracknext=${first.cookies.get('tracknext')?.value}` }));
    expect(second.cookies.get('tracknext')?.maxAge).toBe(86400);
    expect(new Date(second.cookies.get('tracknext')?.expires ?? 0).getTime()).toBe(START + 2 * 86400000);
    now += 86400001;
    expect(attribution.read(second.cookies)).toBeNull();
  });

  it('detects HTTPS automatically and honors an explicit secure override', () => {
    const request = new NextRequest('http://localhost:3000/?utm_source=dev', { headers: { accept: 'text/html' } });
    expect(createAttribution().proxy(request).cookies.get('tracknext')?.secure).toBeFalsy();
    expect(createAttribution({ secure: true }).proxy(request).cookies.get('tracknext')?.secure).toBe(true);
    expect(createAttribution({ secure: false }).proxy(documentRequest()).cookies.get('tracknext')?.secure).toBeFalsy();
  });

  it('clears only its configured cookie using the same path and domain', () => {
    const attribution = createAttribution({ cookieName: 'campaign', cookieDomain: '.shop.example', secure: true });
    const response = NextResponse.json({ ok: true });
    response.cookies.set('session', 'keep');
    expect(attribution.clear(response)).toBe(response);
    expect(response.cookies.get('campaign')).toMatchObject({ value: '', path: '/', domain: '.shop.example', maxAge: 0, secure: true });
    expect(response.cookies.get('session')?.value).toBe('keep');
    expect(response.status).toBe(200);
  });
});

function memoryStore() {
  const records = new Map<string, AttributionState>();
  const store: AttributionStore = {
    read: vi.fn(async (id: string) => structuredClone(records.get(id) ?? null)),
    update: vi.fn(async (id: string, updater: (current: AttributionState | null) => AttributionState | null) => {
      const next = updater(structuredClone(records.get(id) ?? null));
      if (next) records.set(id, structuredClone(next));
      else records.delete(id);
      return structuredClone(next);
    }),
    delete: vi.fn(async (id: string) => { records.delete(id); }),
  };
  return { store, records };
}

function returnedCookies(response: NextResponse): string {
  return response.cookies.getAll().map(({ name, value }) => `${name}=${value}`).join('; ');
}

describe('stored Next.js adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retains more touches than the bounded cookie and recovers history using only the visitor ID', async () => {
    const { store } = memoryStore();
    let now = START;
    const attribution = createStoredAttribution({ store, visitorCookieName: 'visitor', now: () => now });
    let response = NextResponse.next();
    for (let index = 0; index < 8; index++) {
      response = await attribution.proxy(documentRequest(`/?utm_source=campaign${index}&utm_medium=email`, { cookie: returnedCookies(response) }));
      now += 3600000;
    }
    expect((await attribution.read(response.cookies))?.touches).toHaveLength(8);
    expect(createAttribution({ now: () => now }).read(response.cookies)?.touches).toHaveLength(5);
    const id = response.cookies.get('visitor')?.value;
    expect(id).toBeTruthy();
    // A browser may lose the payload cookie while retaining the compact ID.
    const idOnlyRequest = documentRequest('/?utm_source=recovered', { cookie: `visitor=${id}` });
    expect((await attribution.read(idOnlyRequest.cookies))?.touches).toHaveLength(8);
    const recovered = await attribution.proxy(idOnlyRequest);
    const snapshot = await attribution.read(recovered.cookies);
    expect(snapshot?.touches).toHaveLength(9);
    expect(snapshot?.firstTouch.source).toBe('campaign0');
    expect(snapshot?.lastTouch.source).toBe('recovered');
    expect(recovered.cookies.get('tracknext')).toBeDefined();
  });

  it('writes both fallback cookies during a storage outage and reads their payload', async () => {
    const fail = async () => { throw new Error('Database unavailable'); };
    const store: AttributionStore = { read: fail, update: fail, delete: fail };
    const onStoreError = vi.fn();
    const attribution = createStoredAttribution({ store, visitorCookieName: 'visitor', now: () => START, onStoreError });
    const response = await attribution.proxy(documentRequest('/?utm_source=newsletter&utm_medium=email'));
    expect(response.cookies.get('visitor')?.value).toBeTruthy();
    expect(response.cookies.get('tracknext')?.value).toBeTruthy();
    expect((await attribution.read(response.cookies))?.firstTouch.source).toBe('newsletter');
    expect(onStoreError).toHaveBeenCalled();
  });

  it('reads an awaited server cookie store asynchronously', async () => {
    const { store } = memoryStore();
    const attribution = createStoredAttribution({ store, visitorCookieName: 'visitor', now: () => START });
    const response = await attribution.proxy(documentRequest('/?utm_source=partner'));
    const serverCookies = await Promise.resolve({ get: (name: string) => response.cookies.get(name) });
    expect((await attribution.read(serverCookies))?.firstTouch.source).toBe('partner');
  });

  it('clears the server record and both matching cookies while preserving an auth response', async () => {
    const { store, records } = memoryStore();
    const attribution = createStoredAttribution({
      store, cookieName: 'campaign', visitorCookieName: 'visitor', cookieDomain: '.shop.example', secure: true, now: () => START,
    });
    const first = await attribution.proxy(documentRequest('/?utm_source=newsletter'));
    const id = first.cookies.get('visitor')?.value;
    expect(records.has(id ?? '')).toBe(true);
    const response = NextResponse.redirect('https://accounts.example/logout');
    response.cookies.set('session', 'keep');
    expect(await attribution.clear(response, first.cookies)).toBe(response);
    expect(store.delete).toHaveBeenCalledWith(id);
    expect(records.has(id ?? '')).toBe(false);
    for (const name of ['campaign', 'visitor']) {
      expect(response.cookies.get(name)).toMatchObject({ value: '', path: '/', domain: '.shop.example', secure: true, maxAge: 0 });
    }
    expect(response.cookies.get('session')?.value).toBe('keep');
    expect(response.headers.get('location')).toBe('https://accounts.example/logout');
  });

  it('does not access storage for background requests or failed responses', async () => {
    const { store } = memoryStore();
    const attribution = createStoredAttribution({ store, now: () => START });
    for (const request of [
      documentRequest('/api/lead?utm_source=ignored'),
      documentRequest('/?utm_source=ignored', { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }),
      documentRequest('/?utm_source=ignored', { purpose: 'prefetch' }),
      documentRequest('/?utm_source=ignored', { accept: 'text/x-component' }),
    ]) {
      expect((await attribution.proxy(request)).cookies.get('tracknext')).toBeUndefined();
    }
    await attribution.capture(documentRequest('/?utm_source=ignored'), new NextResponse(null, { status: 500 }));
    expect(store.read).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it('preserves OAuth redirects and ignores internal attribution without a server update', async () => {
    const { store } = memoryStore();
    const attribution = createStoredAttribution({ store, now: () => START });
    const response = NextResponse.redirect('https://accounts.example/login');
    response.cookies.set('auth_state', 'keep');
    expect(await attribution.capture(documentRequest('/?utm_source=newsletter'), response)).toBe(response);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://accounts.example/login');
    expect(response.cookies.get('auth_state')?.value).toBe('keep');
    expect(response.cookies.get('tracknext')).toBeDefined();
    vi.mocked(store.update).mockClear();
    const internal = await attribution.proxy(documentRequest('/?utm_source=internal', {
      cookie: returnedCookies(response), referer: 'https://shop.example/',
    }));
    expect(internal.cookies.get('tracknext')).toBeUndefined();
    expect(store.update).not.toHaveBeenCalled();
  });

  it('gives both cookies the same fixed journey expiry', async () => {
    const { store } = memoryStore();
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const attribution = createStoredAttribution({ store, visitorCookieName: 'visitor', ttlDays: 2, now: () => now });
    const first = await attribution.proxy(documentRequest('/?utm_source=first'));
    now += 86400000;
    const second = await attribution.proxy(documentRequest('/?utm_source=second', { cookie: returnedCookies(first) }));
    for (const name of ['tracknext', 'visitor']) {
      expect(second.cookies.get(name)?.maxAge).toBe(86400);
      expect(new Date(second.cookies.get(name)?.expires ?? 0).getTime()).toBe(START + 2 * 86400000);
    }
  });

  it('subtracts storage latency from both cookies remaining lifetime', async () => {
    const { store } = memoryStore();
    let now = START;
    const originalUpdate = store.update;
    store.update = async (id, updater) => {
      const state = await originalUpdate(id, updater);
      now += 3000;
      return state;
    };
    const attribution = createStoredAttribution({ store, visitorCookieName: 'visitor', ttlDays: 1, now: () => now });
    const response = await attribution.proxy(documentRequest('/?utm_source=first'));
    for (const name of ['tracknext', 'visitor']) {
      expect(response.cookies.get(name)?.maxAge).toBe(86400 - 3);
    }
  });
});
