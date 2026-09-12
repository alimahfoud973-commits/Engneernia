import { bigserial, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, utcTimestamp } from './columns';
import { auditActionEnum, userRoleEnum } from './enums';

/**
 * Audit log (specification §37).
 *
 * APPEND-ONLY, enforced at two levels independent of application code:
 *   - a trigger rejects UPDATE and DELETE;
 *   - the application database role is not granted UPDATE or DELETE on it.
 *
 * `before` / `after` hold the changed fields only, already scrubbed of
 * secrets by `src/audit/log.ts` — a password hash or TOTP secret must never
 * reach this table.
 *
 * Note: tamper-evidence against someone with direct database access (a hash
 * chain) arrives in phase P6 alongside the financial ledger, where the value
 * is highest — see TD-10 in docs/DECISIONS.md.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    /** Monotonic, so the log has an unambiguous order independent of clocks. */
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),

    actorUserId: uuid('actor_user_id'),
    actorRole: userRoleEnum('actor_role'),

    action: auditActionEnum('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),

    before: jsonb('before'),
    after: jsonb('after'),

    /** Hashed, never raw: the log is queried by staff and exported. */
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    /** Ties every row written during one request together. */
    correlationId: text('correlation_id'),

    createdAt: createdAt(),
  },
  (table) => [
    index('audit_logs_actor_idx').on(table.actorUserId, table.createdAt),
    index('audit_logs_entity_idx').on(table.entityType, table.entityId),
    index('audit_logs_action_idx').on(table.action, table.createdAt),
    index('audit_logs_correlation_idx').on(table.correlationId),
  ],
);

/**
 * Fixed-window rate limiting, backed by PostgreSQL.
 *
 * Deliberately not in-memory: the application may run as several instances
 * behind a load balancer, and an in-memory counter would let an attacker
 * multiply their allowance by the instance count.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    /** e.g. "login:ip:<hash>" or "login:email:<hash>" */
    key: text('key').primaryKey(),
    windowStartedAt: utcTimestamp('window_started_at').notNull().defaultNow(),
    hits: integer('hits').notNull().default(0),
  },
  (table) => [index('rate_limit_window_idx').on(table.windowStartedAt)],
);
