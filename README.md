# TrackNext

[![CI](https://github.com/itamargero/tracknext/actions/workflows/ci.yml/badge.svg)](https://github.com/itamargero/tracknext/actions/workflows/ci.yml)

**First, middle, and last marketing touch attribution for Next.js.**

TrackNext captures marketing arrivals on your server and makes their attribution available when someone signs up, submits a lead, or starts checkout. Keep the data in your own database. No tracking service or browser SDK is required.

```text
Google search → newsletter → LinkedIn campaign → direct return → signup
     first          middle           last
```

TrackNext records acquisition evidence, rather than pageviews, internal navigation, or product events. It does not send data to analytics or advertising providers. The core has no runtime dependencies; the Next.js adapter uses your installed Next.js.

This is an initial, unpublished release. The `tracknext` npm name is provisional and its availability has not been verified.

## Requirements

- Next.js **16.0.0 or newer within version 16** for `tracknext/next`.
- Node.js **20.9.0+** in the consuming application. Contributing/building this checkout requires Node.js **22.18.0+** because of its development tooling; this does not raise the consuming-library runtime floor.
- TypeScript or JavaScript with ESM imports.

The integration uses Next.js 16's `proxy.ts` convention. Next.js 15 and older are outside this release's supported range. Use a current patched Next.js release in production; the minimum version defines the compatibility floor.

## Install locally

Until a package is published, build a tarball from this checkout:

```sh
git clone https://github.com/itamargero/tracknext.git
cd tracknext
npm ci
npm pack

# In your Next.js application; adjust the tarball path
npm install ../tracknext/tracknext-0.1.0.tgz
```

`npm pack` builds the package automatically. After publication under the final package name, installation will be `npm install tracknext` if that name is retained.

## Quick start

### 1. Create your tracker

```ts
// src/lib/attribution.ts
import { createAttribution } from 'tracknext/next';

export const attribution = createAttribution({
  siteHosts: ['example.com'],
});
```

An owned apex includes its subdomains. The current request hostname also counts as owned automatically. Set `siteHosts` explicitly if the application uses multiple domains or moves visitors between subdomains.

### 2. Add Proxy

```ts
// src/proxy.ts
import { attribution } from '@/lib/attribution';

export const proxy = attribution.proxy;

// Next.js must statically analyze this literal in your proxy file.
export const config = {
  matcher: ['/((?!api(?:/|$)|_next(?:/|$)|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$).*)'],
};
```

For a project without `src/`, put these files in `lib/` and `proxy.ts` at the project root instead. Adjust the import alias to match your application.

### 3. Save attribution at conversion

Read the cookie in a Server Action or Route Handler, after validating the submitted data. Reading `cookies()` during rendering can make a route dynamic, so a root-layout reader is unnecessary.

```ts
// src/actions/create-lead.ts
'use server';

import { cookies } from 'next/headers';
import { attribution } from '@/lib/attribution';
import { db } from '@/lib/db'; // Your application's existing database client.

export async function createLead(formData: FormData) {
  const email = formData.get('email');
  if (typeof email !== 'string' || !email.trim()) {
    throw new Error('Email is required');
  }

  // Apply your application's complete email/form validation here.
  const snapshot = attribution.read(await cookies());

  await db.lead.create({
    data: { email: email.trim(), attribution: snapshot },
  });
}
```

The database call illustrates an application with a JSON attribution column and a compatible client. TrackNext does not provide a database schema or a `db` client. Use your existing validated signup, lead, or checkout flow and persist the snapshot there. A new landing cookie becomes available after the browser receives the response; it is not automatically added to the current incoming request's cookie store.

For checkout, save the snapshot alongside your checkout record before redirecting to the payment provider. Link the later webhook to that record; a payment-provider webhook does not carry the visitor's browser cookies.

## Already have a proxy?

Call `capture` on the response produced by your existing proxy. It preserves that response's headers, auth cookies, redirect, or rewrite.

```ts
// src/proxy.ts
import { NextRequest, NextResponse } from 'next/server';
import { attribution } from '@/lib/attribution';

export function proxy(request: NextRequest) {
  // Replace this with your existing auth/i18n response-producing logic.
  const response = NextResponse.next();
  return attribution.capture(request, response);
}

export const config = {
  matcher: ['/((?!api(?:/|$)|_next(?:/|$)|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$).*)'],
};
```

For an async auth or internationalization proxy, await its response before passing it to `capture`. Keep the existing provider's matcher where required, and pass the final response through capture once. Capture runs only on eligible HTML document GET arrivals; it filters API/assets, Flight requests, fetches, prefetches, and prerenders, and skips error responses. Redirect responses can retain the original arrival.

## What counts as a touch?

TrackNext applies these rules in order:

1. Ignore owned-site referrers and excluded payment/authentication referrers, even if the URL carries UTMs.
2. Use any nonempty UTM field as explicit campaign evidence.
3. Otherwise infer the source from a recognized click ID.
4. Otherwise classify the external referrer.
5. With no identifiable evidence, create a direct touch only for a new journey.

Direct return visits do not replace existing marketing attribution. An initial direct touch remains the first touch if a later marketing arrival occurs. `lastTouch` is the latest recorded touch, and `lastNonDirectTouch` is `null` when the journey contains only an initial direct touch.

Within 30 minutes of the latest recorded touch, the same attribution evidence is suppressed as a duplicate. The landing path does not distinguish duplicates. This reduces reload duplication, but cannot perfectly distinguish a reload from a separate arrival carrying the same evidence. After that window the same campaign can create a new touch. Set `dedupeWindowSeconds: 0` to disable suppression. Raw click IDs distinguish arrivals only when `captureClickIds` is enabled.

The built-in classifier recognizes search engines, social networks, AI assistants, Android app referrers, and ordinary referrals. Search classification restricts known search front-ends: Google Docs and Gmail web referrers are ordinary referrals. Referrer-domain matching requires a domain-label boundary.

### Campaigns and click IDs

The original sanitized UTM values retain their case under `touch.utm`. Derived `source` and `medium` are normalized separately. For example, `utm_source=NewsLetter&utm_medium=EMAIL` produces `source: 'newsletter'` and `medium: 'email'`, while retaining `NewsLetter` and `EMAIL` as campaign evidence.

| URL parameter | Snapshot field |
| --- | --- |
| `utm_source` | `utm.source` |
| `utm_medium` | `utm.medium` |
| `utm_campaign` | `utm.campaign` |
| `utm_term` | `utm.term` |
| `utm_content` | `utm.content` |
| `utm_id` | `utm.id` |
| `utm_source_platform` | `utm.sourcePlatform` |
| `utm_creative_format` | `utm.creativeFormat` |
| `utm_marketing_tactic` | `utm.marketingTactic` |

Parameter names are case-insensitive; the first occurrence wins when a parameter repeats. Partial UTMs remain campaign evidence, with missing source/medium represented as `'(not set)'`. Missing values are not filled from conflicting click IDs or referrers. Recognized source aliases may supply a default medium.

Recognized click IDs are `gclid`, `gbraid`, `wbraid`, `dclid`, `msclkid`, `ttclid`, `twclid`, `li_fat_id`, and `fbclid`. Raw values are not stored by default. Oversized raw identifiers are omitted and `fieldsTruncated` is set; shortened identifiers would be unusable for conversion uploads. `fbclid` identifies social traffic, which can be organic or paid; it alone does not prove an advertisement. A selected Google click ID takes precedence over a Facebook decoration.

Channels are `direct`, `organic_search`, `paid_search`, `paid_social`, `social`, `email`, `referral`, `ai_referral`, `display`, and `unknown`. These are rule-based classifications, rather than an ad-platform reporting guarantee.

## Configuration

```ts
import { createAttribution } from 'tracknext/next';

export const attribution = createAttribution({
  siteHosts: ['example.com', 'other-owned-domain.com'],
  ignoredReferrers: ['payments.example.net'],
  ttlDays: 90,
  maxTouches: 5,
  maxCookieBytes: 3600,
  dedupeWindowSeconds: 1800,
  maxFieldLength: 150,
  captureClickIds: false,
  cookieName: 'tracknext',
  // cookieDomain: 'example.com', // Share across this domain's subdomains.
  // secure: true,              // Otherwise inferred from request HTTPS.
  sourceAliases: {
    partner: { source: 'partner_newsletter', medium: 'email' },
  },
  referrerRules: [
    { hostname: 'community.example.net', source: 'community', medium: 'referral' },
  ],
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `siteHosts` | Current request host | Additional owned domains; an apex includes subdomains. |
| `ignoredReferrers` | `[]` plus built-ins | Additional domains whose return visits are ignored. |
| `ttlDays` | `90` | Fixed lifetime starting at the journey's first touch. New touches do not renew it. |
| `maxTouches` | `5` | Cookie history limit: first touch plus up to four latest touches; accepted range 2–20. |
| `maxCookieBytes` | `3600` | Serialized cookie budget with a conservative attribute allowance; accepted range 1024–3800. |
| `dedupeWindowSeconds` | `1800` | Duplicate suppression window; 0 disables it. |
| `maxFieldLength` | `150` | Sanitized field limit; accepted range 1–200. |
| `captureClickIds` | `false` | Retain raw recognized click-ID values. |
| `cookieName` | `'tracknext'` | Attribution cookie name. |
| `cookieDomain` | Host-only | Explicitly share cookies across related subdomains. |
| `secure` | Inferred from HTTPS | Override the cookie's Secure attribute. |
| `sourceAliases` | Built-in AI aliases | Override normalized UTM sources and provide default media/channels. |
| `referrerRules` | Built-in classifications | First matching custom rule wins before built-in classification. |
| `now` | `Date.now` | Injectable clock, primarily for tests. |

Cookies use `HttpOnly`, `SameSite=Lax`, and `Path=/`. Domain configuration changes cookie scope; listing a domain in `siteHosts` only changes attribution classification. No automatic cross-domain linking is performed.

Built-in excluded referrers include PayPal, Stripe, Google Pay, Google Accounts, Microsoft login, Apple ID, and Auth0. Extend the list for your own login, payment, or email-verification providers.

### Cookie limits

Cookie history is bounded. When necessary, TrackNext removes the oldest intermediate touches while preserving the first and latest touches. If those still exceed the budget, it trims fields and can remove optional fields, including raw click IDs and UTM details.

`totalTouchCount` counts recorded touches after deduplication. `droppedTouchCount` counts touches omitted from the retained history. `historyTruncated` reports missing touches; individual `fieldsTruncated` flags report reduced field detail. A journey can have truncated fields without having lost an entire touch.

## Snapshot shape

A read returns `AttributionSnapshot | null`. An absent, malformed, or expired cookie yields `null`. Timestamps are Unix milliseconds.

```ts
import type { AttributionSnapshot, AttributionTouch } from 'tracknext';

const first: AttributionTouch = {
  id: '11111111-1111-4111-8111-111111111111',
  source: 'google', medium: 'organic', channel: 'organic_search',
  evidence: 'referrer', timestamp: 1800000000000,
  referrer: 'google.com', landingPath: '/guide',
};
const middle: AttributionTouch = {
  id: '22222222-2222-4222-8222-222222222222',
  source: 'newsletter', medium: 'email', channel: 'email',
  evidence: 'utm', timestamp: 1800086400000,
  utm: { source: 'NewsLetter', medium: 'EMAIL', campaign: 'Autumn' },
  landingPath: '/offer',
};
const last: AttributionTouch = {
  id: '33333333-3333-4333-8333-333333333333',
  source: 'linkedin', medium: 'paid_social', channel: 'paid_social',
  evidence: 'click_id', timestamp: 1800172800000,
  referrer: 'linkedin.com', landingPath: '/signup',
};
const snapshot: AttributionSnapshot = {
  version: 1,
  touches: [first, middle, last],
  totalTouchCount: 3,
  droppedTouchCount: 0,
  expiresAt: 1807776000000,
  firstTouch: first,
  middleTouches: [middle],
  lastTouch: last,
  lastNonDirectTouch: last,
  historyTruncated: false,
};
```

Optional touch fields are `id`, `utm`, `referrer`, `landingPath`, `clickIds`, and `fieldsTruncated`. The tracker assigns a stable UUID `id` when recording each touch and retains it across cookie trimming and store recovery. The parser alone does not assign IDs; older state can omit them. Landing data contains only a path, with a 250-character initial limit. Referrers contain only a normalized hostname or Android package name. Arbitrary landing query parameters, URL fragments, and referrer paths/queries are not retained. Campaign fields can still contain personal data supplied by a link creator; treat all captured values as untrusted input and escape them when displaying them.

## Optional durable server storage

Use durable storage when you need more history or recovery after the attribution payload cookie disappears. Cookie-only mode is the default and needs no database.

```ts
// src/lib/attribution.ts
import { createStoredAttribution } from 'tracknext/next';
import { attributionStore } from '@/lib/attribution-store';

export const attribution = createStoredAttribution({
  siteHosts: ['example.com'],
  store: attributionStore,
  serverMaxTouches: 1000,
  storeTimeoutMs: 1000,
  onStoreError(error, operation) {
    console.error(`Attribution store ${operation} failed`, error);
  },
});
```

The durable API is asynchronous: `await attribution.capture(request, response)` and `await attribution.read(await cookies())`. Its async `proxy` can be exported directly. It keeps a bounded attribution backup cookie plus an opaque `tracknext_id` visitor cookie. The server history defaults to at most 1,000 retained touches; it retains the first and latest touches when that limit is reached. Configure storage retention/cleanup in your application.

| Durable option | Default | Meaning |
| --- | --- | --- |
| `store` | Required | Your `AttributionStore` implementation. |
| `visitorCookieName` | Attribution cookie name + `'_id'` | Recovery ID cookie; must differ from the payload cookie. |
| `serverMaxTouches` | `1000` | Retained server-history limit; accepted range 2–10000. |
| `storeTimeoutMs` | `1000` | Maximum wait per store operation; accepted range 1–10000 ms. |
| `onStoreError` | No callback | Receives the error and `'read'`, `'update'`, or `'delete'` operation. |

Implement this ORM-independent contract, exported from `tracknext`:

```ts
import type { AttributionState, AttributionStore } from 'tracknext';

interface StoreContract extends AttributionStore {
  read(visitorId: string): Promise<AttributionState | null>;
  update(
    visitorId: string,
    updater: (current: AttributionState | null) => AttributionState | null,
  ): Promise<AttributionState | null>;
  delete(visitorId: string): Promise<void>;
}
```

**`update` must be atomic for a visitor ID.** Within a database transaction plus a per-ID lock, an advisory lock, or a correct compare-and-swap retry loop, read the current state, invoke `updater`, persist its result, and return that result. A returned `null` means remove/leave absent. This protection must also cover IDs whose row does not exist yet; a lock on an existing row alone does not solve concurrent inserts. Never implement this as an unlocked `read` followed by `write`. Do not use a process-local memory map as a production adapter across serverless instances.

Store only validated state and enforce expiry/retention in your own cleanup jobs. The library checks state and journey expiry on read. A valid surviving visitor ID can recover history if only the payload cookie was removed. If both cookies are gone, the library cannot reconnect an anonymous visitor to the previous history. Atomic storage protects concurrent updates for a known ID; simultaneous first visits before any ID cookie exists can still establish separate IDs.

Store operations have a default 1,000 ms timeout and fall back to bounded cookie data on failure. A timeout cannot cancel a database operation already in flight. Recovery matches stable touch IDs and a shared first-touch anchor, which helps deduplicate retries and recover backup touches despite trimmed campaign fields. A complete server history can accept previously unseen older touches. If the server history has already dropped touches, an unmatched older backup touch may already have been counted and evicted; recovery leaves that ambiguous older touch out. Legacy state without IDs relies on stricter evidence/timestamp matching. A bounded backup can also omit outage touches entirely. This is best-effort recovery, rather than guaranteed exactly-once delivery.

### PostgreSQL recipe

The source checkout includes an optional [node-postgres adapter](examples/postgres-store.ts) and [SQL schema](examples/postgres-schema.sql). Copy the adapter into your application and apply the SQL through your normal migration workflow. The library never applies migrations automatically. Prisma and Drizzle integrations can implement the same `AttributionStore` contract.

Install `pg` in the consuming application only if you use this recipe (`npm install pg`, plus `npm install --save-dev @types/pg` for TypeScript). It is not a TrackNext runtime dependency. Configure database timeouts as well as the library's response timeout:

```ts
import { Pool } from 'pg';
import { createPostgresStore } from '@/lib/postgres-store';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const pool = new Pool({
  connectionString,
  connectionTimeoutMillis: 500,
  query_timeout: 900,
  statement_timeout: 750,
  options: '-c lock_timeout=500ms',
});

export const attributionStore = createPostgresStore(pool);
```

Choose timeout values and connection-pool limits for your deployment. Connection, query, statement, and lock limits bound underlying waits; TrackNext's `storeTimeoutMs` only bounds the library's wait and cannot cancel a database operation already in flight. The recipe locks the logical visitor ID with a PostgreSQL transaction advisory lock, including before the first row exists. Configure an expiry cleanup job in your application.

### Clear attribution

Clear cookie-only attribution on a response returned to the browser:

```ts
import { NextResponse } from 'next/server';
import { attribution } from '@/lib/attribution';

const response = NextResponse.json({ cleared: true });
attribution.clear(response);
```

For durable mode, supply the incoming cookie store so its server record can also be deleted:

```ts
await attribution.clear(response, await cookies());
```

Route Handlers are a convenient place to return these responses. Protect any application endpoint according to your own requirements. Durable deletion errors are reported through `onStoreError`; cookie clearing does not guarantee deletion from an unavailable store, so use your own retention/deletion workflow when needed.

## Framework-independent core

```ts
import { createTracker, parseAttribution } from 'tracknext/core';

const decision = parseAttribution({
  url: 'https://example.com/?utm_source=Newsletter&utm_medium=email',
  referrer: null,
});

const tracker = createTracker({ siteHosts: ['example.com'] });
const result = tracker.capture({ url: 'https://example.com/?gclid=example' });
// Persist result.cookieValue using tracker.cookie when present.
const snapshot = tracker.read(result.cookieValue);
```

`parseAttribution` returns a `touch`, `direct`, or `ignore` decision. `createTracker` manages serialization, history, expiry, and deduplication; it does not filter HTTP request types or send cookies. Use the Next.js adapter for those responsibilities. The core does not require Next.js.

## Limits and data handling

- Attribution describes evidence observed by this browser journey. Missing referrers, blocked/cleared cookies, redirect chains that remove query data before Proxy runs, and browser restrictions can reduce it.
- Cookie-only updates are best effort across simultaneous requests or tabs; competing responses can overwrite one another. Use atomic durable storage for known-ID concurrency.
- There is no cross-device identity, fingerprinting, automatic user linking, automatic cross-domain tracking, or revenue-allocation model. Persist snapshots against your own records at conversion time.
- Cookies and campaign claims are unsigned, user-controlled marketing input. Never use them for authorization, billing decisions, fraud prevention, or proof that an advertisement occurred.
- Tracking has no built-in consent gate. Site owners control their integration, disclosures, and retention policies. First-party storage does not itself establish a universal compliance guarantee.
- TrackNext does not capture interactions, session replays, or pageview events. No client JavaScript is injected and no data is uploaded to a third-party endpoint.

## Development

```sh
npm ci
npm run check
npx playwright install chromium
npm run build:example
npm run test:e2e
```

Run `npm run dev:example` for the local Next.js example. See [CONTRIBUTING.md](CONTRIBUTING.md) for the test and compatibility workflow.

## License

[MIT](LICENSE).
