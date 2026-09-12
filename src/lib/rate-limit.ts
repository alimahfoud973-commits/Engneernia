import 'server-only';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getSql } from '@/db';
import { AppError } from '@/lib/errors';

/**
 * Fixed-window rate limiting, backed by PostgreSQL.
 *
 * Deliberately not in-memory. The application may run as several instances,
 * and a per-process counter would let an attacker multiply their allowance by
 * the number of instances — the classic way a rate limit becomes decorative.
 */

export class RateLimitedError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('RATE_LIMITED', 'Too many attempts', 429, { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** Login rules. Both apply: an attacker must beat the per-IP and per-account. */
export const LOGIN_RULES = {
  perIp: { limit: 20, windowSeconds: 300 },
  perAccount: { limit: 10, windowSeconds: 300 },
} as const satisfies Record<string, RateLimitRule>;

/** Account lockout, applied on top of rate limiting. */
export const LOCKOUT = { maxAttempts: 8, lockMinutes: 15 } as const;

function bucketKey(scope: string, value: string): string {
  // Hashed so the table never holds a raw IP or email address.
  return `${scope}:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * Count one attempt against a bucket and throw if the rule is exceeded.
 *
 * The whole read-modify-write happens in one atomic statement, so concurrent
 * requests cannot race past the limit.
 */
export async function consumeRateLimit(
  scope: string,
  value: string,
  rule: RateLimitRule,
): Promise<void> {
  const key = bucketKey(scope, value);
  const client = getSql();

  const rows = await client<Array<{ hits: number; window_started_at: Date }>>`
    INSERT INTO rate_limit_buckets (key, window_started_at, hits)
    VALUES (${key}, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE
        WHEN rate_limit_buckets.window_started_at
             < now() - make_interval(secs => ${rule.windowSeconds})
        THEN 1
        ELSE rate_limit_buckets.hits + 1
      END,
      window_started_at = CASE
        WHEN rate_limit_buckets.window_started_at
             < now() - make_interval(secs => ${rule.windowSeconds})
        THEN now()
        ELSE rate_limit_buckets.window_started_at
      END
    RETURNING hits, window_started_at
  `;

  const row = rows[0];
  if (!row) return;

  if (row.hits > rule.limit) {
    const elapsed = (Date.now() - row.window_started_at.getTime()) / 1000;
    const retryAfter = Math.max(1, Math.ceil(rule.windowSeconds - elapsed));
    throw new RateLimitedError(retryAfter);
  }
}

/** Housekeeping: drop windows that can no longer matter. Run from a job. */
export async function pruneRateLimitBuckets(olderThanSeconds = 86_400): Promise<number> {
  const result = await getSql()`
    DELETE FROM rate_limit_buckets
     WHERE window_started_at < now() - make_interval(secs => ${olderThanSeconds})
  `;
  return result.count;
}

export const __testing = { bucketKey, sql };
