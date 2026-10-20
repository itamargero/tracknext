# Contributing to TrackNext

TrackNext is a small server-side marketing attribution library. Contributions should keep installation simple, acquisition rules explicit, and cookie/storage behavior predictable. It does not aim to become a pageview tracker, product analytics SDK, or hosted analytics service.

## Setup

Use Node.js **22.18.0 or newer** and npm to build/contribute. The consumer runtime floor remains Node.js 20.9.0; the higher contribution floor comes from development tooling.

```sh
npm ci
npm run check
```

The package is ESM. The pure core must remain independent of Next.js, browsers, databases, and runtime dependencies. Next.js-specific integration belongs in the separate `tracknext/next` entry point.

## Working locally

```sh
npm run test:watch
npm run dev:example
```

The example lives under `examples/next-app`. It is an integration fixture and a practical way to inspect attribution during local development. To test the same package a consumer installs:

```sh
npm pack
# In a separate Next.js application:
npm install /absolute/path/to/tracknext/tracknext-0.1.0.tgz
```

Do not commit tarballs, generated `dist/` files, `.env` files, browser traces containing personal data, or `node_modules/`. Keep `package-lock.json` updated when dependencies intentionally change.

## Validation

```sh
npm run typecheck
npm test
npm run build
npm run test:package
npx playwright install chromium
npm run build:example
npm run test:e2e
```

`npm run check` combines typechecking, unit tests, and the library build. The browser suite exercises the real Next.js example. On Linux, Playwright may also need system dependencies; use `npx playwright install --with-deps chromium` in CI.

`npm run test:package` installs the built tarball into an isolated consumer and checks standalone core imports, the installed Next.js adapter, and declaration resolution under TypeScript's NodeNext mode.

The compatibility matrix uses Next.js 16.0.0 and 16.4.2 on Node.js 22.18.0+. Test a change that affects Proxy, cookies, redirects, request filtering, or package imports against both versions:

```sh
npm install --no-save --package-lock=false --legacy-peer-deps next@16.0.0
npm run check
npm run build:example
npm run test:e2e

npm ci
```

Use a current patched Next.js release in production. The older matrix entry tests the compatibility floor.

The compatibility swap uses `--legacy-peer-deps` to avoid npm's optional-peer resolver crash (`edgesOut`) while changing test versions. Normal `npm ci` and consumer tarball installs do not need this flag.

## PostgreSQL integration test

Use a dedicated, isolated PostgreSQL database on localhost. The test applies the example schema and writes/deletes test visitor data; do not point it at an application database. The script requires an explicit localhost URL and never selects `DATABASE_URL` implicitly.

```sh
TRACKNEXT_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/tracknext_test' npm run test:postgres
```

`npm run test:postgres` builds the package and tests the real SQL adapter, including ten concurrent updates to one visitor, ID-only recovery, and deletion. The local test database must already exist. CI provides an ephemeral PostgreSQL 16 service with test-only credentials.

## Change expectations

For behavior changes, add a regression case that demonstrates the original problem before changing the implementation. Favor meaningful scenarios over tests that mirror private helpers.

Review these boundaries when relevant:

- Internal navigation, prefetch, Flight, assets, and auth/payment returns must not create marketing touches.
- Partial UTMs, conflicting click IDs, lookalike domains, Unicode values, and malformed cookies must produce predictable results.
- Retention and byte budgets must preserve the first and latest touch while making omissions visible.
- Existing response cookies, redirects, and rewrites must survive proxy composition.
- Durable storage must handle missing rows and concurrent known-ID updates atomically. Failure paths must have bounded waits and preserve the backup-cookie behavior.
- Conversion examples must use the data available in the incoming request, without assuming a new response cookie is already readable.

Update the README when public behavior or types change. Explain the problem, resulting behavior, validation, and relevant limitations in a contribution description. Avoid unrelated refactors or generated churn.

## Reporting issues

Include the Next.js/Node.js versions, cookie or durable mode, relevant configuration, and a small reproduction. Explain expected and observed attribution. Replace real campaign IDs, personal data, credentials, cookies, and production visitor records with synthetic values before sharing them.

There is no public repository or security-reporting address configured in this initial local release. Use the repository's issue and security reporting mechanisms once the project has been shared.

## Release preparation

Before publishing, confirm the npm package name and maintainers, add the actual repository metadata, review the packed file list with `npm pack --dry-run`, and run the full validation matrix. Publishing is a separate maintainer action; CI does not publish packages automatically.
