/**
 * setupRedisReset.ts — Jest setupFilesAfterFramework entry point
 *
 * Runs inside the Jest worker after the test framework has been initialised
 * but BEFORE any test file executes.
 *
 * WHY THIS EXISTS (D-003 Root Cause)
 * ────────────────────────────────────
 * The IORedis client in src/config/redis.ts is a module-level singleton.
 * When Jest runs multiple test suites in one worker process (the default with
 * --runInBand, or when workers are reused), the singleton from suite N may
 * already be in a non-writable/closed state by the time suite N+1 starts.
 *
 * With `enableOfflineQueue: false` and `retryStrategy: null` (test mode),
 * every subsequent Redis call throws "Stream isn't writeable", which causes
 * the fail-closed rate limiters to return 503 SECURITY_LIMITER_UNAVAILABLE,
 * blocking all HTTP authentication tests from exercising the real logic.
 *
 * The fix: before each test FILE starts, reset the singleton so that
 * getRedisClient() creates a brand-new connection.  Each suite that hits
 * security-sensitive HTTP endpoints will then have a live Redis connection
 * for the duration of that suite.
 *
 * This does NOT change fail-closed behaviour: if Redis is genuinely
 * unreachable (wrong host, wrong password), the new connection will also
 * fail and the 503 behaviour remains correct.  It merely ensures we do not
 * carry over a dead socket from a previous suite.
 */

import { resetRedisClientForTesting, waitForRedisReady, closeRedisConnections, getRedisClient } from '../src/config/redis';

beforeAll(async () => {
  // Reset the singleton before each test file so a fresh connection is
  // established.
  resetRedisClientForTesting();
  try {
    await waitForRedisReady(5000);
    const client = getRedisClient();
    const keys = await client.keys('ratelimit:*');
    if (keys.length > 0) {
      await client.del(...keys);
    }
  } catch {
    // If Redis is unavailable or unconfigured, subsequent tests will fail-closed as intended
  }
});

beforeEach(async () => {
  try {
    const client = getRedisClient();
    if (client.status === 'ready') {
      const keys = await client.keys('ratelimit:*');
      if (keys.length > 0) {
        await client.del(...keys);
      }
    }
  } catch {
    // Ignore in tests where Redis isn't used
  }
});

afterAll(async () => {
  await closeRedisConnections();
});


