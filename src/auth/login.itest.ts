import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { attemptMemberLogin, attemptOwnerLogin } from './login';
import { hashPassword } from './password';
import { resolveActor, revokeAllSessions, SESSION_IDLE_TIMEOUT_MS } from './session';
import { isOwner } from '@/authz/actor';
import { withActor, withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb, getSql } from '@/db';
import { users } from '@/db/schema';
import { LOCKOUT, LOGIN_RULES, RateLimitedError } from '@/lib/rate-limit';

/**
 * ===========================================================================
 * SIGNING IN, AGAINST A REAL DATABASE (Stage 6)
 * ===========================================================================
 * Two doors. Subscribers and engineers: phone + email, no password. The
 * owner: username + password, no second factor. Then the session rules both
 * doors share: resolution, revocation, expiry, idle timeout.
 * ===========================================================================
 */

const OWNER_CTX = { actorId: randomUUID(), actorRole: 'OWNER' };
const suffix = Date.now();
const tail = String(suffix).slice(-6);
const PASSWORD = 'a-perfectly-fine-long-password';

const phones = {
  customer: `+96394${tail}01`,
  engineer: `+96394${tail}02`,
  disabled: `+96394${tail}03`,
  withHash: `+96394${tail}04`,
  owner: `+96394${tail}05`,
};
const emails = {
  customer: `login-customer+${suffix}@test.local`,
  engineer: `login-engineer+${suffix}@test.local`,
  disabled: `login-disabled+${suffix}@test.local`,
  withHash: `login-withhash+${suffix}@test.local`,
};
const ids = {
  customer: randomUUID(), engineer: randomUUID(), disabled: randomUUID(), withHash: randomUUID(),
  owner: '',
};
let ownerUsername = '';
let ownerPhoneBefore: string | null = null;

let ipCounter = 0;
/** A fresh IP per call so the per-IP limiter does not bleed between tests. */
const nextIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter += 1) % 250}`;

beforeAll(async () => {
  const theOwner = await ensureTestOwner({ displayName: 'Owner', passwordHash: await hashPassword(PASSWORD) });
  ids.owner = theOwner.id;
  ownerUsername = theOwner.username;

  await withRawActorContext(OWNER_CTX, async (tx) => {
    const [row] = await tx.execute(sql`SELECT phone FROM users WHERE id = ${ids.owner}::uuid`) as unknown as Array<{ phone: string | null }>;
    ownerPhoneBefore = row?.phone ?? null;

    await tx.insert(users).values([
      { id: ids.customer, email: emails.customer, phone: phones.customer, role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Customer' },
      { id: ids.engineer, email: emails.engineer, phone: phones.engineer, role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
      { id: ids.disabled, email: emails.disabled, phone: phones.disabled, role: 'CUSTOMER', status: 'DISABLED', displayName: 'Disabled' },
      /**
       * A subscriber carrying a password hash AND a username — a state no path
       * creates, planted here to prove the owner door still refuses it: that
       * door answers for the OWNER role and nothing else.
       */
      {
        id: ids.withHash, email: emails.withHash, phone: phones.withHash, role: 'CUSTOMER', status: 'ACTIVE',
        displayName: 'Planted', username: `planted-${tail}`, passwordHash: await hashPassword(PASSWORD),
      },
    ]);
  });
});

afterAll(async () => {
  await withRawActorContext(OWNER_CTX, async (tx) => {
    await tx.delete(users).where(sql`id IN (${ids.customer}, ${ids.engineer}, ${ids.disabled}, ${ids.withHash})`);
    await tx.execute(sql`
      UPDATE users SET phone = ${ownerPhoneBefore}, failed_login_count = 0, locked_until = NULL
       WHERE id = ${ids.owner}::uuid
    `);
  });
  await getSql()`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%'`;
  await closeDb();
});

const member = (phone: string, email: string) => attemptMemberLogin({ phone, email, ip: nextIp() });
const owner = (username: string, password: string) => attemptOwnerLogin({ username, password, ip: nextIp() });

describe('subscriber and engineer sign-in: phone + email', () => {
  it('a customer signs in with the right pair — and no password exists to ask for', async () => {
    const result = await member(phones.customer, emails.customer);
    expect(result.status).toBe('SUCCESS');
    if (result.status !== 'SUCCESS') return;
    expect(result.role).toBe('CUSTOMER');

    const actor = await resolveActor(result.session.rawToken);
    expect(actor.kind === 'USER' && actor.userId).toBe(ids.customer);
    expect(isOwner(actor)).toBe(false);
  });

  it('an engineer signs in the same way', async () => {
    const result = await member(phones.engineer, emails.engineer);
    expect(result.status).toBe('SUCCESS');
    if (result.status === 'SUCCESS') expect(result.role).toBe('CONTRIBUTOR');
  });

  it('accepts the phone as people type it, and the email in any case', async () => {
    const typed = `00${phones.customer.slice(1, 4)} ${phones.customer.slice(4, 8)} ${phones.customer.slice(8)}`
      .replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    expect((await member(typed, emails.customer.toUpperCase())).status).toBe('SUCCESS');
  });

  it('one answer for a known phone with the wrong email and for a phone nobody has', async () => {
    const wrongEmail = await member(phones.customer, emails.engineer);
    const unknownPhone = await member(`+96394${tail}99`, emails.customer);
    const malformed = await member('0933123456', emails.customer);
    expect(wrongEmail.status).toBe('INVALID_CREDENTIALS');
    expect(unknownPhone).toEqual(wrongEmail);
    expect(malformed).toEqual(wrongEmail);
  });

  it('says an account is disabled only to whoever presented both of its credentials', async () => {
    expect((await member(phones.disabled, emails.disabled)).status).toBe('ACCOUNT_DISABLED');
    expect((await member(phones.disabled, emails.customer)).status).toBe('INVALID_CREDENTIALS');
  });

  it('can never open the owner row, whatever phone and email the owner carries', async () => {
    const [row] = await withRawActorContext(OWNER_CTX, (tx) => tx.execute(sql`
      UPDATE users SET phone = ${phones.owner} WHERE id = ${ids.owner}::uuid RETURNING email::text AS email
    `)) as unknown as Array<{ email: string | null }>;
    const ownerEmail = row?.email ?? `owner-${suffix}@test.local`;
    if (!row?.email) {
      await withRawActorContext(OWNER_CTX, (tx) => tx.execute(sql`
        UPDATE users SET email = ${ownerEmail} WHERE id = ${ids.owner}::uuid`));
    }
    // The full, correct pair for the owner row — and still no.
    expect((await member(phones.owner, ownerEmail)).status).toBe('INVALID_CREDENTIALS');
    const direct = await getSql()`SELECT * FROM app_auth_lookup_member(${phones.owner}, ${ownerEmail})`;
    expect(direct).toHaveLength(0);
  });

  it(`refuses a phone after ${LOGIN_RULES.perAccount.limit} attempts, however many IPs they come from`, async () => {
    const target = `+96394${tail}77`;
    for (let n = 0; n < LOGIN_RULES.perAccount.limit; n += 1) await member(target, `x${n}@test.local`);
    const refused = await member(target, 'y@test.local').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RateLimitedError);
    expect((refused as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('owner sign-in: username + password, no second factor', () => {
  it('opens a session that IS the owner — no challenge step exists', async () => {
    const result = await owner(ownerUsername, PASSWORD);
    expect(result.status).toBe('SUCCESS');
    if (result.status !== 'SUCCESS') return;
    expect(result.role).toBe('OWNER');

    const actor = await resolveActor(result.session.rawToken);
    expect(isOwner(actor)).toBe(true);

    // And PostgreSQL agrees, through the same declaration every query makes.
    const [answer] = await withActor(actor, (tx) => tx.execute(sql`SELECT app_is_owner() AS owner`)) as unknown as Array<{ owner: boolean }>;
    expect(answer?.owner).toBe(true);
  });

  it('is case-insensitive on the username', async () => {
    expect((await owner(ownerUsername.toUpperCase(), PASSWORD)).status).toBe('SUCCESS');
  });

  it('one answer for a wrong password and an unknown username', async () => {
    const wrong = await owner(ownerUsername, 'wrong-password-entirely');
    const unknown = await owner(`nobody-${tail}`, PASSWORD);
    expect(wrong.status).toBe('INVALID_CREDENTIALS');
    expect(unknown).toEqual(wrong);
  });

  it('never opens for a non-owner, even one planted with a username and a password', async () => {
    expect((await owner(`planted-${tail}`, PASSWORD)).status).toBe('INVALID_CREDENTIALS');
  });

  it(`locks after ${LOCKOUT.maxAttempts} wrong passwords, and stays locked for the right one`, async () => {
    // Fresh buckets: the tests above already spent part of the per-account
    // rate limit, which would otherwise refuse before the lockout is reached.
    await getSql()`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%'`;
    try {
      for (let n = 0; n < LOCKOUT.maxAttempts; n += 1) await owner(ownerUsername, 'definitely-wrong');
      const result = await owner(ownerUsername, PASSWORD);
      expect(result.status).toBe('ACCOUNT_LOCKED');
    } finally {
      await withRawActorContext(OWNER_CTX, (tx) => tx.execute(sql`
        UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ${ids.owner}::uuid`));
      await getSql()`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%'`;
    }
  });
});

describe('sessions', () => {
  const signIn = async () => {
    const result = await member(phones.customer, emails.customer);
    if (result.status !== 'SUCCESS') throw new Error('expected success');
    return result.session.rawToken;
  };

  it('resolves an unknown or empty token to a guest', async () => {
    expect((await resolveActor('not-a-real-token')).kind).toBe('GUEST');
    expect((await resolveActor(undefined)).kind).toBe('GUEST');
    expect((await resolveActor('')).kind).toBe('GUEST');
  });

  it('an expired session is a guest', async () => {
    const token = await signIn();
    await withRawActorContext(OWNER_CTX, (tx) => tx.execute(sql`
      UPDATE sessions SET expires_at = now() - interval '1 second'
       WHERE user_id = ${ids.customer}::uuid AND revoked_at IS NULL`));
    expect((await resolveActor(token)).kind).toBe('GUEST');
  });

  it('an idle session is a guest', async () => {
    const token = await signIn();
    const idle = new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - 60_000).toISOString();
    await withRawActorContext(OWNER_CTX, (tx) => tx.execute(sql`
      UPDATE sessions SET last_used_at = ${idle}::timestamptz
       WHERE user_id = ${ids.customer}::uuid AND revoked_at IS NULL AND expires_at > now()`));
    expect((await resolveActor(token)).kind).toBe('GUEST');
  });

  it('revocation takes effect immediately', async () => {
    const token = await signIn();
    const actor = await resolveActor(token);
    expect(actor.kind).toBe('USER');
    await revokeAllSessions(actor, ids.customer, 'test revocation');
    expect((await resolveActor(token)).kind).toBe('GUEST');
  });

  it('disabling the user kills every live session at once', async () => {
    const token = await signIn();
    await withRawActorContext(OWNER_CTX, (tx) =>
      tx.update(users).set({ status: 'DISABLED' }).where(sql`id = ${ids.customer}`));
    try {
      expect((await resolveActor(token)).kind).toBe('GUEST');
    } finally {
      await withRawActorContext(OWNER_CTX, (tx) =>
        tx.update(users).set({ status: 'ACTIVE' }).where(sql`id = ${ids.customer}`));
    }
  });

  it('never stores the raw token', async () => {
    const token = await signIn();
    const found = await getSql()<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM sessions WHERE token_hash = ${token}
    `;
    expect(found[0]?.count).toBe(0);
  });
});
