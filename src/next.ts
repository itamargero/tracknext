import { NextRequest, NextResponse } from 'next/server.js';
import { createTracker } from './tracker.js';
import { createStoredTracker } from './store.js';
import type { AttributionCookieOptions, AttributionSnapshot, CookieReader, StoredTrackerOptions, TrackerOptions } from './types.js';

export interface NextAttribution {
  /** Standalone Next.js proxy. Compose with capture() when another proxy exists. */
  proxy(request: NextRequest): NextResponse;
  /** Adds attribution to an existing response without replacing its other behavior. */
  capture(request: NextRequest, response: NextResponse): NextResponse;
  /** Reads a previously returned browser cookie, including await cookies(). */
  read(store: CookieReader): AttributionSnapshot | null;
  clear(response: NextResponse): NextResponse;
}

export interface StoredNextAttribution {
  proxy(request: NextRequest): Promise<NextResponse>;
  capture(request: NextRequest, response: NextResponse): Promise<NextResponse>;
  read(store: CookieReader): Promise<AttributionSnapshot | null>;
  /** Deletes the server record identified by the browser's visitor cookie. */
  clear(response: NextResponse, store: CookieReader): Promise<NextResponse>;
}

const METADATA_PATH = /\/(?:favicon\.ico|robots\.txt|sitemap(?:-index)?\.xml|manifest\.(?:json|webmanifest)|(?:opengraph-image|twitter-image|apple-icon|icon)(?:\.(?:ico|png|jpg|jpeg|svg|webp))?)$/i;

/** NextURL canonicalizes loopback IPs; retain the actual responding Host. */
function arrivalUrl(request: NextRequest): URL {
  const url = new URL(request.nextUrl.href);
  const rawHost = request.headers.get('host');
  if (rawHost) {
    try {
      const host = new URL(`${url.protocol}//${rawHost}`);
      if (host.pathname === '/' && !host.username && !host.password && !host.search && !host.hash) url.host = host.host;
    } catch { /* A malformed Host must not make attribution break page delivery. */ }
  }
  return url;
}

/** Only top-level document arrivals can create marketing touches. */
function isDocumentArrival(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  if (request.method !== 'GET' || pathname === '/api' || pathname.startsWith('/api/') ||
      pathname === '/_next' || pathname.startsWith('/_next/') || METADATA_PATH.test(pathname)) {
    return false;
  }

  const headers = request.headers;
  const accept = headers.get('accept')?.toLowerCase() ?? '';
  // Flight headers may be stripped by Next.js Proxy; fetch metadata and Accept
  // are still checked so filtering does not rely on these headers alone.
  if (headers.has('rsc') || headers.has('next-router-prefetch') || accept.includes('text/x-component')) {
    return false;
  }
  if (/(?:prefetch|prerender)/i.test(`${headers.get('purpose') ?? ''} ${headers.get('sec-purpose') ?? ''}`)) {
    return false;
  }

  const destination = headers.get('sec-fetch-dest')?.toLowerCase();
  const mode = headers.get('sec-fetch-mode')?.toLowerCase();
  if (destination !== undefined && destination !== 'document') return false;
  if (mode !== undefined && mode !== 'navigate') return false;
  if (destination === 'document' && mode === 'navigate') return true;

  // Older clients may omit fetch metadata. Requiring HTML is conservative and
  // avoids treating generic fetches, scripts, or image loads as new arrivals.
  return accept.split(',').some((part) => /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/.test(part.trim()));
}

function setJourneyCookie(
  request: NextRequest,
  response: NextResponse,
  cookie: Readonly<AttributionCookieOptions>,
  value: string,
  expiresAt: number,
  now: number,
): void {
  // Use the journey's original expiry, rather than renewing the TTL each
  // time another marketing touch is recorded.
  response.cookies.set({
    ...cookie,
    value,
    secure: cookie.secure ?? request.nextUrl.protocol === 'https:',
    maxAge: Math.max(0, Math.floor((expiresAt - now) / 1000)),
    expires: new Date(expiresAt),
  });
}

/** Creates a reusable Next.js adapter backed by the dependency-free tracker. */
export function createAttribution(options: TrackerOptions = {}): NextAttribution {
  const tracker = createTracker(options);
  const clock = options.now ?? Date.now;

  function capture(request: NextRequest, response: NextResponse): NextResponse {
    // A redirect's Set-Cookie belongs to this responding origin, even when its
    // Location points to an external auth provider. Keep the original arrival.
    if (!isDocumentArrival(request) || response.status >= 400) return response;

    const now = clock();
    const result = tracker.capture({
      url: arrivalUrl(request),
      referrer: request.headers.get('referer'),
      now,
    }, request.cookies.get(tracker.cookie.name)?.value);

    if (result.cookieValue !== undefined && result.snapshot !== null) {
      setJourneyCookie(request, response, tracker.cookie, result.cookieValue, result.snapshot.expiresAt, now);
    }
    return response;
  }

  return {
    proxy(request) {
      return capture(request, NextResponse.next());
    },
    capture,
    read(store) {
      return tracker.read(store.get(tracker.cookie.name)?.value);
    },
    clear(response) {
      // Deletion must match the cookie's path/domain, including shared-domain
      // configurations. Unrelated authentication cookies stay on this response.
      response.cookies.set({ ...tracker.cookie, value: '', maxAge: 0, expires: new Date(0) });
      return response;
    },
  };
}

/**
 * Adds optional durable history while retaining the same bounded cookie fallback.
 * Storage work is awaited only for eligible arrivals and explicit server reads.
 */
export function createStoredAttribution(options: StoredTrackerOptions): StoredNextAttribution {
  const tracker = createStoredTracker(options);
  const clock = options.now ?? Date.now;

  async function capture(request: NextRequest, response: NextResponse): Promise<NextResponse> {
    if (!isDocumentArrival(request) || response.status >= 400) return response;

    const now = clock();
    const result = await tracker.capture({
      url: arrivalUrl(request),
      referrer: request.headers.get('referer'),
      now,
    }, request.cookies.get(tracker.cookie.name)?.value, request.cookies.get(tracker.visitorCookie.name)?.value);

    if (result.snapshot !== null) {
      // Storage may take time. Cookie lifetime starts when the response is
      // written, so subtract that elapsed time from the fixed journey expiry.
      const writeTime = clock();
      if (result.cookieValue !== undefined) {
        setJourneyCookie(request, response, tracker.cookie, result.cookieValue, result.snapshot.expiresAt, writeTime);
      }
      // Keep the recovery ID even when persistence fails or times out: a late
      // store completion may still be recoverable on the visitor's next request.
      if (result.visitorId !== undefined) {
        setJourneyCookie(request, response, tracker.visitorCookie, result.visitorId, result.snapshot.expiresAt, writeTime);
      }
    }
    return response;
  }

  return {
    proxy(request) {
      return capture(request, NextResponse.next());
    },
    capture,
    read(store) {
      return tracker.read(store.get(tracker.cookie.name)?.value, store.get(tracker.visitorCookie.name)?.value);
    },
    async clear(response, store) {
      await tracker.delete(store.get(tracker.visitorCookie.name)?.value);
      for (const cookie of [tracker.cookie, tracker.visitorCookie]) {
        response.cookies.set({ ...cookie, value: '', maxAge: 0, expires: new Date(0) });
      }
      return response;
    },
  };
}

export type { AttributionSnapshot, AttributionStore, CookieReader, StoredTrackerOptions, TrackerOptions } from './types.js';
