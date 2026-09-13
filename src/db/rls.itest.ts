import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { withRawActorContext } from './actor-context';
import { closeDb, getDb } from './index';
import { auditLogs, contributors, sessions, users } from './schema';

/**
 * ===========================================================================
 * ROW-LEVEL SECURITY, PROVEN AGAINST A REAL DATABASE — P1 exit criterion
 * ===========================================================================
 * Every query below is written the way a BUGGY application would write it:
 * no WHERE clause, no scoping, no policy check. The application-layer
 * protections are deliberately absent.
 *
 * If these tests pass, a forgotten filter anywhere in the codebase leaks
 * nothing, because the database refuses to return the rows at all.
 * ===========================================================================
 */


/**
 * Drizzle wraps driver errors, so the PostgreSQL message lives on `cause`.
 * Asserting on the root cause proves WHICH protection fired, rather than
 * merely that something went wrong.
 */
async function rootCauseOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    let current: unknown = error;
    const messages: string[] = [];
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      messages.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return messages.join(' | ');
  }
}

/**
 * The owner context is a transaction setting, not a row: RLS reads
 * `app_actor_role()`, never `users.role`. This file used to seed an OWNER
 * user as well and never once referred to it — which migration 0041, the
 * single-owner index, made visible by refusing the second one.
 */
const OWNER_CTX = { actorId: randomUUID(), actorRole: 'OWNER' };
const GUEST_CTX = { actorId: '', actorRole: 'GUEST' };

const ids = {
  userA: randomUUID(),
  userB: randomUUID(),
  userInactive: randomUUID(),
  contribA: randomUUID(),
  contribB: randomUUID(),
  contribInactive: randomUUID(),
};

const suffix = Date.now();

function contributorCtx(userId: string, contributorId: string) {
  return { actorId: userId, actorRole: 'CONTRIBUTOR', contributorId };
}

beforeAll(async () => {
  await withRawActorContext(OWNER_CTX, async (tx) => {
    await tx.insert(users).values([
      { id: ids.userA, email: `a+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer A' },
      { id: ids.userB, email: `b+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer B' },
      { id: ids.userInactive, email: `c+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer C' },
    ]);

    await tx.insert(contributors).values([
      { id: ids.contribA, userId: ids.userA, publicSlug: `eng-a-${suffix}`, settlementCode: `ENGA${suffix}`, displayName: 'Engineer A', isActive: true },
      { id: ids.contribB, userId: ids.userB, publicSlug: `eng-b-${suffix}`, settlementCode: `ENGB${suffix}`, displayName: 'Engineer B', isActive: true },
      { id: ids.contribInactive, userId: ids.userInactive, publicSlug: `eng-c-${suffix}`, settlementCode: `ENGC${suffix}`, displayName: 'Engineer C', isActive: false },
    ]);

    await tx.insert(sessions).values([
      { userId: ids.userA, tokenHash: `hash-a-${suffix}`, expiresAt: new Date(Date.now() + 3_600_000) },
      { userId: ids.userB, tokenHash: `hash-b-${suffix}`, expiresAt: new Date(Date.now() + 3_600_000) },
    ]);

    await tx.insert(auditLogs).values([
      { action: 'LOGIN_SUCCEEDED', entityType: 'user', entityId: ids.userA, actorUserId: ids.userA, actorRole: 'CONTRIBUTOR' },
      { action: 'LOGIN_SUCCEEDED', entityType: 'user', entityId: ids.userB, actorUserId: ids.userB, actorRole: 'CONTRIBUTOR' },
    ]);
  });
});

afterAll(async () => {
  await withRawActorContext(OWNER_CTX, async (tx) => {
    await tx.delete(sessions).where(sql`user_id IN (${ids.userA}, ${ids.userB})`);
    await tx.delete(contributors).where(sql`id IN (${ids.contribA}, ${ids.contribB}, ${ids.contribInactive})`);
    await tx.delete(users).where(sql`id IN (${ids.userA}, ${ids.userB}, ${ids.userInactive})`);
  });
  await closeDb();
});

describe('users table', () => {
  it('the owner sees every user', async () => {
    const rows = await withRawActorContext(OWNER_CTX, (tx) => tx.select().from(users));
    const emails = rows.map((r) => r.email);
    expect(emails).toContain(`a+${suffix}@test.local`);
    expect(emails).toContain(`b+${suffix}@test.local`);
  });

  it('a contributor querying WITHOUT a filter still sees only themselves', async () => {
    const rows = await withRawActorContext(contributorCtx(ids.userA, ids.contribA), (tx) =>
      tx.select().from(users),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ids.userA);
  });

  it('a contributor naming another user explicitly gets nothing', async () => {
    const rows = await withRawActorContext(contributorCtx(ids.userA, ids.contribA), (tx) =>
      tx.select().from(users).where(eq(users.id, ids.userB)),
    );
    expect(rows).toHaveLength(0);
  });

  it('a guest sees no users at all', async () => {
    const rows = await withRawActorContext(GUEST_CTX, (tx) => tx.select().from(users));
    expect(rows).toHaveLength(0);
  });

  it('a contributor cannot modify another user', async () => {
    await withRawActorContext(contributorCtx(ids.userA, ids.contribA), async (tx) => {
      await tx.update(users).set({ displayName: 'HACKED' }).where(eq(users.id, ids.userB));
    });
    const [victim] = await withRawActorContext(OWNER_CTX, (tx) =>
      tx.select().from(users).where(eq(users.id, ids.userB)),
    );
    expect(victim?.displayName).toBe('Engineer B');
  });

  it('a contributor cannot escalate their own role', async () => {
    await withRawActorContext(contributorCtx(ids.userA, ids.contribA), async (tx) => {
      await tx.update(users).set({ role: 'OWNER' }).where(eq(users.id, ids.userA));
    });
    const [self] = await withRawActorContext(OWNER_CTX, (tx) =>
      tx.select().from(users).where(eq(users.id, ids.userA)),
    );
    expect(self?.role).toBe('CONTRIBUTOR');
  });
});

describe('sessions table', () => {
  it('a contributor sees only their own sessions', async () => {
    const rows = await withRawActorContext(contributorCtx(ids.userA, ids.contribA), (tx) =>
      tx.select().from(sessions),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(ids.userA);
  });

  it('a contributor cannot read another contributor session token hash', async () => {
    const rows = await withRawActorContext(contributorCtx(ids.userA, ids.contribA), (tx) =>
      tx.select().from(sessions).where(eq(sessions.tokenHash, `hash-b-${suffix}`)),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('contributors table — specification §31', () => {
  it('a guest sees active public profiles', async () => {
    const rows = await withRawActorContext(GUEST_CTX, (tx) => tx.select().from(contributors));
    const slugs = rows.map((r) => r.publicSlug);
    expect(slugs).toContain(`eng-a-${suffix}`);
    expect(slugs).toContain(`eng-b-${suffix}`);
  });

  it('a guest does NOT see an inactive profile', async () => {
    const rows = await withRawActorContext(GUEST_CTX, (tx) =>
      tx.select().from(contributors).where(eq(contributors.id, ids.contribInactive)),
    );
    expect(rows).toHaveLength(0);
  });

  it('an inactive contributor can still see their own profile', async () => {
    const rows = await withRawActorContext(
      contributorCtx(ids.userInactive, ids.contribInactive),
      (tx) => tx.select().from(contributors).where(eq(contributors.id, ids.contribInactive)),
    );
    expect(rows).toHaveLength(1);
  });

  it('a contributor cannot activate themselves', async () => {
    await withRawActorContext(
      contributorCtx(ids.userInactive, ids.contribInactive),
      async (tx) => {
        await tx
          .update(contributors)
          .set({ isActive: true, canSubmitDrafts: true })
          .where(eq(contributors.id, ids.contribInactive));
      },
    );
    const [row] = await withRawActorContext(OWNER_CTX, (tx) =>
      tx.select().from(contributors).where(eq(contributors.id, ids.contribInactive)),
    );
    expect(row?.isActive).toBe(false);
    expect(row?.canSubmitDrafts).toBe(false);
  });

  it('a contributor cannot create a contributor profile', async () => {
    const cause = await rootCauseOf(
      withRawActorContext(contributorCtx(ids.userA, ids.contribA), async (tx) => {
        await tx.insert(contributors).values({
          userId: ids.userA,
          publicSlug: `sneaky-${suffix}`,
          settlementCode: `SNEAK${suffix}`,
          displayName: 'Sneaky',
          isActive: true,
        });
      }),
    );
    expect(cause).toMatch(/row-level security/i);
  });
});

describe('audit_logs table', () => {
  it('the owner can read the audit log', async () => {
    const rows = await withRawActorContext(OWNER_CTX, (tx) => tx.select().from(auditLogs));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('a contributor cannot read the audit log, not even their own entries', async () => {
    const rows = await withRawActorContext(contributorCtx(ids.userA, ids.contribA), (tx) =>
      tx.select().from(auditLogs),
    );
    expect(rows).toHaveLength(0);
  });

  /**
   * Append-only is defended twice, and both layers are tested separately so
   * that neither can quietly become dead code.
   *
   * Layer 1 — GRANTS: the application role was never given UPDATE or DELETE,
   * so PostgreSQL refuses before any trigger runs. This is what actually
   * protects production.
   *
   * Layer 2 — TRIGGER: catches a privileged role (a migration, an operator
   * with a psql session) that does hold the grant. Tested below with the
   * migration role, because the application role never gets that far.
   */
  it('layer 1 — the application role is denied UPDATE outright', async () => {
    const cause = await rootCauseOf(
      withRawActorContext(OWNER_CTX, async (tx) => {
        await tx.update(auditLogs).set({ entityType: 'tampered' });
      }),
    );
    expect(cause).toMatch(/permission denied/i);
  });

  it('layer 1 — the application role is denied DELETE outright', async () => {
    const cause = await rootCauseOf(
      withRawActorContext(OWNER_CTX, async (tx) => {
        await tx.delete(auditLogs).where(eq(auditLogs.entityType, 'user'));
      }),
    );
    expect(cause).toMatch(/permission denied/i);
  });

  /**
   * Layer 2 exists for exactly one threat: a session that BYPASSES RLS.
   *
   * A role subject to RLS never reaches the trigger — with no UPDATE policy on
   * audit_logs, PostgreSQL filters every row out and the statement affects
   * nothing. So the trigger's real job is to stop a superuser or a role with
   * BYPASSRLS — a DBA at a psql prompt, a maintenance script — from quietly
   * rewriting history. That is what this test reproduces.
   */
  it('layer 2 — the trigger stops even a superuser from rewriting history', async () => {
    const superuserUrl = process.env.DATABASE_SUPERUSER_URL;
    expect(
      superuserUrl,
      'DATABASE_SUPERUSER_URL must be set so the append-only trigger is actually exercised',
    ).toBeTruthy();

    const privileged = postgres(superuserUrl as string, { max: 1 });
    try {
      // A superuser sees every row, RLS notwithstanding — the dangerous case.
      const visible = await privileged`SELECT count(*)::int AS count FROM audit_logs`;
      expect(visible[0]?.count).toBeGreaterThan(0);

      await expect(
        privileged`UPDATE audit_logs SET entity_type = 'tampered'`,
      ).rejects.toThrow(/append-only/i);

      await expect(privileged`DELETE FROM audit_logs`).rejects.toThrow(/append-only/i);

      // And the rows are still there, unchanged.
      const after = await privileged`SELECT count(*)::int AS count FROM audit_logs
                                      WHERE entity_type = 'tampered'`;
      expect(after[0]?.count).toBe(0);
    } finally {
      await privileged.end({ timeout: 5 });
    }
  });

  it('the audit log survives the tampering attempts intact', async () => {
    const rows = await withRawActorContext(OWNER_CTX, (tx) => tx.select().from(auditLogs));
    expect(rows.every((r) => r.entityType !== 'tampered')).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Connections are pooled. If the actor context outlived its transaction, one
 * user's identity would bleed into the next request that reused the
 * connection — a catastrophic and very quiet bug.
 */
describe('actor context is transaction-scoped', () => {
  it('does not leak into a later transaction on the same pooled connection', async () => {
    await withRawActorContext(OWNER_CTX, (tx) => tx.select().from(users));

    // No context declared: simulates a code path that forgot to set one.
    const leaked = await getDb().execute(sql`SELECT count(*)::int AS count FROM users`);
    const rows = leaked as unknown as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(0);
  });

  it('a fresh transaction starts as a guest, not as whoever ran last', async () => {
    await withRawActorContext(contributorCtx(ids.userA, ids.contribA), (tx) =>
      tx.select().from(users),
    );
    const rows = await withRawActorContext(GUEST_CTX, (tx) => tx.select().from(users));
    expect(rows).toHaveLength(0);
  });
});

/**
 * A structural invariant, not a behaviour: no table may exist without
 * Row-Level Security. Adding a table in a later phase and forgetting its
 * policies fails here, before it ever holds financial data.
 */
describe('schema invariant — every table has RLS', () => {
  it('no table in the public schema is unprotected', async () => {
    const rows = await withRawActorContext(OWNER_CTX, (tx) =>
      tx.execute(sql`
        SELECT c.relname AS table_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND c.relname NOT LIKE '\_\_%'
           AND NOT c.relrowsecurity
      `),
    );
    const unprotected = (rows as unknown as Array<{ table_name: string }>).map((r) => r.table_name);
    expect(unprotected, `tables without RLS: ${unprotected.join(', ')}`).toEqual([]);
  });

  it('every RLS-enabled table has at least one policy', async () => {
    const rows = await withRawActorContext(OWNER_CTX, (tx) =>
      tx.execute(sql`
        SELECT c.relname AS table_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND c.relrowsecurity
           AND NOT EXISTS (
             SELECT 1 FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = c.relname
           )
      `),
    );
    const policyless = (rows as unknown as Array<{ table_name: string }>).map((r) => r.table_name);
    expect(policyless, `RLS on but no policies: ${policyless.join(', ')}`).toEqual([]);
  });
});
