import 'server-only';
import { auditLogs } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';
import type { Actor } from '@/authz/actor';
import { hashIp } from '@/auth/crypto';

/**
 * Audit logging (specification §37).
 *
 * Always called with the SAME transaction as the action it describes, so the
 * log and the change are atomic: there is no path that performs a privileged
 * action without recording it, and none that records an action that was
 * rolled back.
 */

export type AuditAction = (typeof auditLogs.action)['enumValues'][number];

/** Field names that must never reach the audit log, at any nesting depth. */
const FORBIDDEN_FIELDS = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'totpSecret',
  'totpSecretEncrypted',
  'totp_secret_encrypted',
  'tokenHash',
  'token_hash',
  'sessionToken',
  'secret',
  'providerConfig',
  'providerConfigEncrypted',
]);

/**
 * Strip secrets before persisting. The audit log is read by staff and exported
 * for review; a credential that lands here has effectively been disclosed.
 */
export function scrubForAudit(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => scrubForAudit(item, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = FORBIDDEN_FIELDS.has(key) ? '[redacted]' : scrubForAudit(item, depth + 1);
  }
  return output;
}

export interface AuditEntry {
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly correlationId?: string | null;
}

export async function recordAudit(
  tx: Transaction,
  actor: Actor,
  entry: AuditEntry,
): Promise<void> {
  await tx.insert(auditLogs).values({
    actorUserId: actor.kind === 'USER' ? actor.userId : null,
    actorRole: actor.kind === 'USER' ? actor.role : null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before === undefined ? null : scrubForAudit(entry.before),
    after: entry.after === undefined ? null : scrubForAudit(entry.after),
    ipHash: hashIp(entry.ip),
    userAgent: entry.userAgent ?? null,
    correlationId: entry.correlationId ?? null,
  });
}

/** Only the fields that actually changed, so diffs stay readable. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T> } {
  const changedBefore: Partial<T> = {};
  const changedAfter: Partial<T> = {};

  for (const key of Object.keys(after) as Array<keyof T>) {
    if (before[key] !== after[key]) {
      changedBefore[key] = before[key];
      changedAfter[key] = after[key];
    }
  }
  return { before: changedBefore, after: changedAfter };
}
