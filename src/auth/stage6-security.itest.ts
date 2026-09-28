import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { hashSessionToken } from './crypto';
import { createSession } from './session';
import type { Actor } from '@/authz/actor';
import { withActor, withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import { users } from '@/db/schema';
import { serverEnv } from '@/lib/config/env';

/**
 * ===========================================================================
 * STAGE 6 — WHAT THE DATABASE GUARANTEES ABOUT AUTHENTICATION
 * ===========================================================================
 * Every case here goes to PostgreSQL directly: the properties are meant to
 * hold for any caller, not only for the code paths that remember them.
 * ===========================================================================
 */

const OWNER_CTX = { actorId: randomUUID(), actorRole: 'OWNER' };
const suffix = Date.now();
const tail = String(suffix).slice(-6);
const ids = { a: randomUUID(), b: randomUUID(), owner: '' };

const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's' } as const;
const customerA: Actor = { ...base, userId: ids.a, role: 'CUSTOMER', contributorId: null, contributorActive: false };

/** Every message and constraint name down a drizzle error's cause chain. */
async function rejectionText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      const constraint = (current as { constraint_name?: unknown }).constraint_name;
      if (typeof constraint === 'string') parts.push(constraint);
      current = current.cause;
    }
    return parts.join(' | ');
  }
}

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  await withRawActorContext(OWNER_CTX, (tx) => tx.insert(users).values([
    { id: ids.a, email: `s6-a+${suffix}@test.local`, phone: `+96396${tail}01`, role: 'CUSTOMER', status: 'ACTIVE', displayName: 'A' },
    { id: ids.b, email: `s6-b+${suffix}@test.local`, phone: `+96396${tail}02`, role: 'CUSTOMER', status: 'ACTIVE', displayName: 'B' },
  ]));
});

afterAll(async () => {
  await withRawActorContext(OWNER_CTX, (tx) => tx.delete(users).where(sql`id IN (${ids.a}, ${ids.b})`));
  await closeDb();
});

describe('the removed paths are gone, not dormant', () => {
  it.each([
    'app_consume_email_verification(text)',
    'app_reissue_email_verification(text,text,timestamptz)',
    'app_prune_email_verification_tokens(integer)',
    'app_auth_lookup_user(text)',
    'app_auth_lookup_user_by_id(uuid)',
    'app_auth_mark_two_factor(uuid)',
    'app_change_own_password(text)',
  ])('%s does not exist', async (signature) => {
    const [row] = await withRawActorContext(OWNER_CTX, (tx) =>
      tx.execute(sql`SELECT to_regprocedure(${signature}) IS NULL AS gone`)) as unknown as Array<{ gone: boolean }>;
    expect(row?.gone).toBe(true);
  });

  it('the verification-token table, the TOTP columns and the session factor column are gone', async () => {
    const [row] = await withRawActorContext(OWNER_CTX, (tx) => tx.execute(sql`
      SELECT to_regclass('email_verification_tokens') IS NULL AS table_gone,
             (SELECT count(*)::int FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND ((table_name = 'users' AND column_name IN ('totp_secret_encrypted', 'totp_enabled_at', 'email_verified_at'))
                   OR (table_name = 'sessions' AND column_name = 'two_factor_verified_at'))) AS columns_left
    `)) as unknown as Array<{ table_gone: boolean; columns_left: number }>;
    expect(row).toEqual({ table_gone: true, columns_left: 0 });
  });
});

describe('the owner row', () => {
  it('cannot lose its password or its username — it must always be able to sign in', async () => {
    for (const column of ['password_hash', 'username'] as const) {
      const text = await rejectionText(withRawActorContext(OWNER_CTX, (tx) =>
        tx.execute(sql`UPDATE users SET ${sql.raw(column)} = NULL WHERE id = ${ids.owner}::uuid`)));
      expect(text, column).toContain('users_owner_credentials');
    }
  });

  it('a subscriber cannot make itself the owner, nor create one', async () => {
    const updated = await withActor(customerA, (tx) =>
      tx.execute(sql`UPDATE users SET role = 'OWNER' WHERE id = ${ids.a}::uuid RETURNING id`)) as unknown as unknown[];
    expect(updated).toHaveLength(0); // RLS: no row is writable to a subscriber

    const inserted = await rejectionText(withActor(customerA, (tx) => tx.execute(sql`
      INSERT INTO users (username, password_hash, role, status, display_name)
      VALUES (${`usurper-${tail}`}, 'x', 'OWNER', 'ACTIVE', 'Usurper')`)));
    expect(inserted).toMatch(/row-level security/);

    const [role] = await withRawActorContext(OWNER_CTX, (tx) =>
      tx.execute(sql`SELECT role::text AS role FROM users WHERE id = ${ids.a}::uuid`)) as unknown as Array<{ role: string }>;
    expect(role?.role).toBe('CUSTOMER');
  });
});

describe('one subscriber cannot reach another', () => {
  it('reads its own row and no one else\'s — phone and email included', async () => {
    const rows = await withActor(customerA, (tx) =>
      tx.execute(sql`SELECT id, phone FROM users`)) as unknown as Array<{ id: string; phone: string }>;
    expect(rows.map((r) => r.id)).toEqual([ids.a]);

    const other = await withActor(customerA, (tx) =>
      tx.execute(sql`SELECT phone FROM users WHERE id = ${ids.b}::uuid`)) as unknown as unknown[];
    expect(other).toHaveLength(0);
  });

  it('cannot change another account, nor its own status', async () => {
    const other = await withActor(customerA, (tx) =>
      tx.execute(sql`UPDATE users SET phone = '+963000000000' WHERE id = ${ids.b}::uuid RETURNING id`)) as unknown as unknown[];
    const self = await withActor(customerA, (tx) =>
      tx.execute(sql`UPDATE users SET status = 'DISABLED' WHERE id = ${ids.a}::uuid RETURNING id`)) as unknown as unknown[];
    expect(other).toHaveLength(0);
    expect(self).toHaveLength(0);
  });

  it("cannot see, nor end, another subscriber's session", async () => {
    await createSession({ userId: ids.b });
    const seen = await withActor(customerA, (tx) =>
      tx.execute(sql`SELECT id FROM sessions WHERE user_id = ${ids.b}::uuid`)) as unknown as unknown[];
    expect(seen).toHaveLength(0);

    const [asOwner] = await withRawActorContext(OWNER_CTX, (tx) => tx.execute(sql`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${ids.b}::uuid AND revoked_at IS NULL`)) as unknown as Array<{ n: number }>;
    expect(asOwner?.n).toBeGreaterThan(0); // control: the session is really there

    const revoked = await rejectionText(withActor(customerA, (tx) =>
      tx.execute(sql`SELECT app_revoke_sessions(${ids.b}::uuid, 'not yours')`)));
    expect(revoked).toMatch(/Not permitted/);
  });
});

describe('identity constraints', () => {
  it.each([
    ['a local number', '0933123456'],
    ['a number without +', '963933123456'],
    ['letters', '+963abc'],
  ])('refuses %s as a stored phone', async (_label, phone) => {
    const text = await rejectionText(withRawActorContext(OWNER_CTX, (tx) =>
      tx.execute(sql`UPDATE users SET phone = ${phone} WHERE id = ${ids.b}::uuid`)));
    expect(text).toContain('users_phone_e164');
  });

  it('refuses a second account with the same phone', async () => {
    const text = await rejectionText(withRawActorContext(OWNER_CTX, (tx) =>
      tx.execute(sql`UPDATE users SET phone = ${`+96396${tail}01`} WHERE id = ${ids.b}::uuid`)));
    expect(text).toContain('users_phone_unique');
  });
});

describe('every SECURITY DEFINER function resolves pg_temp last', () => {
  it('none in the schema is missing it', async () => {
    const rows = await withRawActorContext(OWNER_CTX, (tx) => tx.execute(sql`
      SELECT p.proname
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
         AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
                          WHERE c = 'search_path=public, pg_temp')
    `)) as unknown as Array<{ proname: string }>;
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  /*
   * A FRESH connection, not the pool: PL/pgSQL and SQL functions cache plans
   * per session, so a pooled connection that already ran these would keep
   * resolving the real tables and pass even with pg_temp first (Stage 4).
   */
  async function inFreshSession<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    const client = postgres(serverEnv().DATABASE_URL, { max: 1, onnotice: () => undefined });
    try {
      return await client.begin(work) as T;
    } finally {
      await client.end();
    }
  }

  it('a temporary `sessions` + `users` pair cannot forge an owner session', async () => {
    const token = `forged-${randomUUID()}`;
    const resolved = await inFreshSession(async (tx) => {
      await tx`CREATE TEMP TABLE users (id uuid, role user_role, status user_status, display_name text,
                 locale text) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE sessions (id uuid, user_id uuid, token_hash text, expires_at timestamptz,
                 last_used_at timestamptz, revoked_at timestamptz) ON COMMIT DROP`;
      const fake = randomUUID();
      await tx`INSERT INTO users VALUES (${fake}::uuid, 'OWNER', 'ACTIVE', 'Forged', 'ar')`;
      await tx`INSERT INTO sessions VALUES (${randomUUID()}::uuid, ${fake}::uuid, ${hashSessionToken(token)},
                 now() + interval '1 day', now(), NULL)`;
      return tx`SELECT * FROM app_auth_resolve_session(${hashSessionToken(token)})`;
    });
    expect(resolved).toHaveLength(0);
  });

  it('a temporary `users` table cannot answer a sign-in', async () => {
    const found = await inFreshSession(async (tx) => {
      await tx`CREATE TEMP TABLE users (id uuid, role user_role, status user_status, display_name text,
                 phone text, email citext, username citext, password_hash text,
                 locked_until timestamptz, failed_login_count int) ON COMMIT DROP`;
      await tx`INSERT INTO users VALUES (${randomUUID()}::uuid, 'CUSTOMER', 'ACTIVE', 'Forged',
                 '+96399999999999', 'forged@test.local', 'forged-owner', 'x', NULL, 0)`;
      await tx`UPDATE users SET role = 'OWNER' WHERE username = 'forged-owner'`;
      await tx`INSERT INTO users VALUES (${randomUUID()}::uuid, 'CUSTOMER', 'ACTIVE', 'Forged 2',
                 '+96399999999998', 'forged2@test.local', NULL, NULL, NULL, 0)`;
      const member = await tx`SELECT * FROM app_auth_lookup_member('+96399999999998', 'forged2@test.local')`;
      const owner = await tx`SELECT * FROM app_auth_lookup_owner('forged-owner')`;
      return member.length + owner.length;
    });
    expect(found).toBe(0);
  });
});
