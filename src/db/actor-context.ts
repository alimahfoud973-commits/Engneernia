import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from './index';
import { actorDatabaseContext, type Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * ACTOR CONTEXT — the bridge between the policy layer and RLS
 * ===========================================================================
 * Every database access happens inside a transaction that first declares WHO
 * is asking. The PostgreSQL policies read that declaration.
 *
 * `set_config(..., true)` scopes the setting to the TRANSACTION. That detail
 * is load-bearing: connections are pooled, and a session-scoped setting would
 * leak one user's identity into the next request that reused the connection.
 * ===========================================================================
 */

export type Transaction = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function declareActor(
  tx: Transaction,
  context: { actorId: string; actorRole: string; contributorId: string },
): Promise<void> {
  // Parameterised, never interpolated: `SET LOCAL` cannot take parameters,
  // which is exactly why set_config() is used instead.
  await tx.execute(sql`
    SELECT set_config('app.actor_id', ${context.actorId}, true),
           set_config('app.actor_role', ${context.actorRole}, true),
           set_config('app.contributor_id', ${context.contributorId}, true)
  `);
}

/**
 * Run a unit of work as this actor.
 *
 * Everything inside — reads, writes, and the audit entry — commits or rolls
 * back together. An audit log that survives a failed action, or an action that
 * survives a failed audit, would both be bugs.
 */
export async function withActor<T>(
  actor: Actor,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const context = actorDatabaseContext(actor);
  return getDb().transaction(async (tx) => {
    await declareActor(tx, context);
    return work(tx);
  });
}

/**
 * Run a unit of work with an explicit raw context.
 *
 * Used by the RLS integration tests to prove that the database enforces
 * isolation on its own — including the case where the application layer is
 * bypassed entirely and an arbitrary context is asserted.
 */
export async function withRawActorContext<T>(
  context: { actorId: string; actorRole: string; contributorId?: string },
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await declareActor(tx, { contributorId: '', ...context });
    return work(tx);
  });
}
