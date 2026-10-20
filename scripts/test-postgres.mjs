import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createPostgresStore } from '../examples/postgres-store.ts';
import { createStoredTracker } from '../dist/index.js';

// Explicit local test URL only; never select the user's application database.
const connectionString = process.env.TRACKNEXT_TEST_DATABASE_URL;
if (!connectionString || !/^postgres(?:ql)?:\/\/(?:[^@/]+@)?(?:127\.0\.0\.1|localhost):/u.test(connectionString)) {
  throw new Error('Set TRACKNEXT_TEST_DATABASE_URL to an isolated localhost test database');
}
const pool = new Pool({ connectionString, max: 12 });
try {
  await pool.query(await readFile(new URL('../examples/postgres-schema.sql', import.meta.url), 'utf8'));
  const store = createPostgresStore(pool);
  const tracker = createStoredTracker({ store, storeTimeoutMs: 10_000, dedupeWindowSeconds: 0 });
  const input = (source, now = Date.now()) => ({ url: `https://example.com/?utm_source=${source}&utm_medium=email`, now });
  const first = await tracker.capture(input('first'));
  assert.equal(first.persisted, true);
  assert.ok(first.visitorId);
  await Promise.all(Array.from({ length: 10 }, (_, index) =>
    tracker.capture(input(`parallel-${index}`), first.cookieValue, first.visitorId)));
  const recovered = await tracker.read(undefined, first.visitorId);
  assert.equal(recovered?.totalTouchCount, 11);
  assert.equal(recovered?.firstTouch.source, 'first');
  assert.equal(new Set(recovered?.touches.map((touch) => touch.source)).size, 11);
  await tracker.delete(first.visitorId);
  assert.equal(await tracker.read(undefined, first.visitorId), null);
  console.log('PostgreSQL integration passed: 10 concurrent updates retained; ID-only recovery and delete verified.');
} finally {
  await pool.end();
}
