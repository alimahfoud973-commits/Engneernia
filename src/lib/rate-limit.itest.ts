import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getSql } from '@/db';
import { getDb } from '@/db';
import {
  consumeRateLimit,
  pruneRateLimitBuckets,
  RateLimitedError,
  __testing,
} from './rate-limit';

/**
 * ===========================================================================
 * THE RATE LIMITER, AGAINST A REAL DATABASE
 * ===========================================================================
 * Written in P8 after the limiter was found BROKEN IN PRODUCTION BUILD by
 * signing in a few times too often in a browser. Until then it had no test of
 * any kind, and the shape of the failure is the reason it needed one:
 *
 *   - the limit itself worked — the eleventh attempt was correctly refused;
 *   - refusing it CRASHED, with `window_started_at.getTime is not a function`.
 *
 * The cause is documented at `src/db/index.ts`: constructing the Drizzle client
 * installs type parsers on the shared postgres.js connection that hand back
 * timestamps as STRINGS, because Drizzle maps them itself. Raw SQL issued
 * through `getSql()` therefore does NOT receive a `Date`, no matter what the
 * TypeScript generic on the call claims — and that generic was a claim, not a
 * check, so the compiler was satisfied and the code threw at runtime.
 *
 * The effect on the platform was worse than a broken message: a tripped limit
 * produced a generic "sign-in failed" and a 500-level log line instead of
 * "try again in N seconds", so a locked-out customer had no way to know that
 * waiting was the remedy — and the operator's log filled with stack traces
 * that looked like a defect elsewhere.
 *
 * Every test below is written against BEHAVIOUR AT THE BOUNDARY of the limit,
 * which is the only place this class of bug shows.
 * ===========================================================================
 */

// A distinct value per run, so a re-run never inherits a previous window.
const uniqueValue = () => `subject-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const RULE = { limit: 3, windowSeconds: 300 } as const;

async function bucketRow(scope: string, value: string) {
  const key = __testing.bucketKey(scope, value);
  const rows = await getSql()<Array<{ hits: number }>>`
    SELECT hits FROM rate_limit_buckets WHERE key = ${key}
  `;
  return rows[0] ?? null;
}

describe('consumeRateLimit', () => {
  beforeEach(async () => {
    // Make sure the Drizzle client — and therefore its type parsers — is
    // installed before the raw client is used, exactly as in the running app.
    getDb();
  });

  it('allows attempts up to the limit', async () => {
    const value = uniqueValue();
    for (let i = 0; i < RULE.limit; i += 1) {
      await expect(consumeRateLimit('test:allow', value, RULE)).resolves.toBeUndefined();
    }
  });

  it('refuses the attempt after the limit — with a usable retry time', async () => {
    const value = uniqueValue();
    for (let i = 0; i < RULE.limit; i += 1) {
      await consumeRateLimit('test:refuse', value, RULE);
    }

    /**
     * THE REGRESSION. Before the fix this rejected with a TypeError rather
     * than a RateLimitedError, so asserting only "it rejects" would have
     * passed against the broken code. The assertion has to reach the retry
     * value, because that is what the broken path could not produce.
     */
    await expect(consumeRateLimit('test:refuse', value, RULE)).rejects.toBeInstanceOf(
      RateLimitedError,
    );

    let caught: unknown;
    try {
      await consumeRateLimit('test:refuse', value, RULE);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RateLimitedError);
    const retry = (caught as RateLimitedError).retryAfterSeconds;
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(RULE.windowSeconds);
  });

  it('counts a refused attempt too, so hammering does not reset the window', async () => {
    const value = uniqueValue();
    for (let i = 0; i < RULE.limit; i += 1) {
      await consumeRateLimit('test:counts', value, RULE);
    }
    await expect(consumeRateLimit('test:counts', value, RULE)).rejects.toBeInstanceOf(
      RateLimitedError,
    );

    const row = await bucketRow('test:counts', value);
    expect(row?.hits).toBe(RULE.limit + 1);
  });

  it('separates buckets by scope', async () => {
    const value = uniqueValue();
    for (let i = 0; i < RULE.limit; i += 1) {
      await consumeRateLimit('test:scope-a', value, RULE);
    }
    // The same subject under a different scope starts fresh.
    await expect(consumeRateLimit('test:scope-b', value, RULE)).resolves.toBeUndefined();
  });

  it('separates buckets by subject', async () => {
    const first = uniqueValue();
    for (let i = 0; i < RULE.limit; i += 1) {
      await consumeRateLimit('test:subject', first, RULE);
    }
    await expect(consumeRateLimit('test:subject', uniqueValue(), RULE)).resolves.toBeUndefined();
  });

  it('starts a new window once the old one has passed', async () => {
    const value = uniqueValue();
    const shortRule = { limit: 2, windowSeconds: 1 } as const;

    await consumeRateLimit('test:window', value, shortRule);
    await consumeRateLimit('test:window', value, shortRule);
    await expect(consumeRateLimit('test:window', value, shortRule)).rejects.toBeInstanceOf(
      RateLimitedError,
    );

    // Age the window rather than sleeping through it.
    const key = __testing.bucketKey('test:window', value);
    await getSql()`
      UPDATE rate_limit_buckets
         SET window_started_at = now() - make_interval(secs => 5)
       WHERE key = ${key}
    `;

    await expect(consumeRateLimit('test:window', value, shortRule)).resolves.toBeUndefined();
    const row = await bucketRow('test:window', value);
    expect(row?.hits).toBe(1);
  });

  it('never holds the raw subject — only a hash of it', async () => {
    const value = 'victim@example.com';
    await consumeRateLimit('test:privacy', value, RULE);

    const rows = await getSql()<Array<{ key: string }>>`
      SELECT key FROM rate_limit_buckets WHERE key LIKE 'test:privacy:%'
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.key).not.toContain(value);
      expect(row.key).not.toContain('victim');
    }
  });
});

describe('pruneRateLimitBuckets', () => {
  it('removes only windows older than the cutoff', async () => {
    const stale = uniqueValue();
    const fresh = uniqueValue();
    await consumeRateLimit('test:prune', stale, RULE);
    await consumeRateLimit('test:prune', fresh, RULE);

    await getSql()`
      UPDATE rate_limit_buckets
         SET window_started_at = now() - make_interval(secs => 7200)
       WHERE key = ${__testing.bucketKey('test:prune', stale)}
    `;

    await pruneRateLimitBuckets(3600);

    expect(await bucketRow('test:prune', stale)).toBeNull();
    expect(await bucketRow('test:prune', fresh)).not.toBeNull();
  });
});

afterAll(async () => {
  await getSql()`DELETE FROM rate_limit_buckets WHERE key LIKE 'test:%'`;
});
