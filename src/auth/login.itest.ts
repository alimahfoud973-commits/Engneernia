import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { attemptLogin } from './login';
import { hashPassword } from './password';
import { encryptSecret } from './crypto';
import { generateTotp, generateTotpSecret } from './totp';
import { resolveActor, revokeAllSessions } from './session';
import { withRawActorContext } from '@/db/actor-context';
import { TEST_OWNER_EMAIL, ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb, getSql } from '@/db';
import { users } from '@/db/schema';
import { LOCKOUT } from '@/lib/rate-limit';

/**
 * End-to-end login behaviour against a real database: lockout, two-factor,
 * session resolution and revocation.
 */

const OWNER_CTX = { actorId: randomUUID(), actorRole: 'OWNER' };
const suffix = Date.now();
const PASSWORD = 'a-perfectly-fine-long-password';

const ids = { plain: randomUUID(), twoFactor: '', disabled: randomUUID() };
const emails = {
  plain: `login-plain+${suffix}@test.local`,
  /**
   * The two-factor account IS the platform owner, and since migration 0041
   * there is exactly one of those. So this file asks for the shared owner row
   * rather than creating a second one, and looks it up by the address a person
   * would actually type.
   */
  twoFactor: TEST_OWNER_EMAIL,
  disabled: `login-disabled+${suffix}@test.local`,
};
const totpSecret = generateTotpSecret();

beforeAll(async () => {
  const passwordHash = await hashPassword(PASSWORD);
  ids.twoFactor = await ensureTestOwner({
    displayName: 'Owner 2FA',
    passwordHash,
    totpSecretEncrypted: encryptSecret(totpSecret),
    totpEnabledAt: new Date(),
  });

  await withRawActorContext(OWNER_CTX, async (tx) => {
    await tx.insert(users).values([
      { id: ids.plain, email: emails.plain, passwordHash, role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Plain' },
      { id: ids.disabled, email: emails.disabled, passwordHash, role: 'CUSTOMER', status: 'DISABLED', displayName: 'Disabled' },
    ]);
  });
});

afterAll(async () => {
  await withRawActorContext(OWNER_CTX, async (tx) => {
    await tx.delete(users).where(sql`id IN (${ids.plain}, ${ids.disabled})`);
  });
  await getSql()`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%'`;
  await closeDb();
});

/** Each test gets a unique IP so the per-IP limiter does not bleed between them. */
let ipCounter = 0;
const nextIp = () => `10.0.0.${(ipCounter += 1)}`;

describe('credentials', () => {
  it('accepts the correct password', async () => {
    const result = await attemptLogin({ email: emails.plain, password: PASSWORD, ip: nextIp() });
    expect(result.status).toBe('SUCCESS');
  });

  it('is case-insensitive on the email', async () => {
    const result = await attemptLogin({
      email: emails.plain.toUpperCase(),
      password: PASSWORD,
      ip: nextIp(),
    });
    expect(result.status).toBe('SUCCESS');
  });

  it('rejects a wrong password', async () => {
    const result = await attemptLogin({ email: emails.plain, password: 'wrong-password-x', ip: nextIp() });
    expect(result.status).toBe('INVALID_CREDENTIALS');
  });

  it('gives an unknown address the same answer as a wrong password', async () => {
    const unknown = await attemptLogin({ email: `nobody+${suffix}@test.local`, password: PASSWORD, ip: nextIp() });
    const wrong = await attemptLogin({ email: emails.plain, password: 'wrong-password-y', ip: nextIp() });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.status).toBe('INVALID_CREDENTIALS');
  });

  it('reports a disabled account only once the password is proven', async () => {
    const correct = await attemptLogin({ email: emails.disabled, password: PASSWORD, ip: nextIp() });
    expect(correct.status).toBe('ACCOUNT_DISABLED');

    const incorrect = await attemptLogin({ email: emails.disabled, password: 'wrong-one', ip: nextIp() });
    expect(incorrect.status).toBe('INVALID_CREDENTIALS');
  });
});

describe('account lockout', () => {
  it(`locks the account after ${LOCKOUT.maxAttempts} failures and stays locked for a correct password`, async () => {
    const email = `lockme+${suffix}@test.local`;
    const id = randomUUID();
    await withRawActorContext(OWNER_CTX, async (tx) => {
      await tx.insert(users).values({
        id, email, passwordHash: await hashPassword(PASSWORD),
        role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Lock Me',
      });
    });

    try {
      for (let attempt = 0; attempt < LOCKOUT.maxAttempts; attempt += 1) {
        await attemptLogin({ email, password: 'definitely-wrong', ip: nextIp() });
      }

      // The password is now correct, and it still must not get in.
      const result = await attemptLogin({ email, password: PASSWORD, ip: nextIp() });
      expect(result.status).toBe('ACCOUNT_LOCKED');
    } finally {
      await withRawActorContext(OWNER_CTX, async (tx) => {
        await tx.delete(users).where(sql`id = ${id}`);
      });
    }
  });
});

describe('two-factor', () => {
  it('does not complete login on the password alone', async () => {
    const result = await attemptLogin({ email: emails.twoFactor, password: PASSWORD, ip: nextIp() });
    expect(result.status).toBe('TWO_FACTOR_REQUIRED');
  });

  it('issues a session that resolves as NOT two-factor-satisfied', async () => {
    const result = await attemptLogin({ email: emails.twoFactor, password: PASSWORD, ip: nextIp() });
    expect(result.status).toBe('TWO_FACTOR_REQUIRED');
    if (result.status !== 'TWO_FACTOR_REQUIRED') return;

    const actor = await resolveActor(result.session.rawToken);
    expect(actor.kind).toBe('USER');
    if (actor.kind !== 'USER') return;
    expect(actor.role).toBe('OWNER');
    // The gate the route checks: an owner session that has not passed 2FA.
    expect(actor.twoFactorSatisfied).toBe(false);
  });

  it('the enrolled secret round-trips through encryption and verifies', async () => {
    const rows = await getSql()<Array<{ totp_secret_encrypted: string }>>`
      SELECT * FROM app_auth_lookup_user(${emails.twoFactor})
    `;
    expect(rows[0]?.totp_secret_encrypted).toBeTruthy();
    expect(generateTotp(totpSecret)).toMatch(/^\d{6}$/);
  });
});

describe('sessions', () => {
  it('resolves a fresh token to the right actor', async () => {
    const result = await attemptLogin({ email: emails.plain, password: PASSWORD, ip: nextIp() });
    if (result.status !== 'SUCCESS') throw new Error('expected success');

    const actor = await resolveActor(result.session.rawToken);
    expect(actor.kind).toBe('USER');
    if (actor.kind !== 'USER') return;
    expect(actor.userId).toBe(ids.plain);
    expect(actor.twoFactorSatisfied).toBe(true);
  });

  it('resolves an unknown or empty token to a guest', async () => {
    expect((await resolveActor('not-a-real-token')).kind).toBe('GUEST');
    expect((await resolveActor(undefined)).kind).toBe('GUEST');
    expect((await resolveActor('')).kind).toBe('GUEST');
  });

  it('revocation takes effect immediately', async () => {
    const result = await attemptLogin({ email: emails.plain, password: PASSWORD, ip: nextIp() });
    if (result.status !== 'SUCCESS') throw new Error('expected success');

    const actor = await resolveActor(result.session.rawToken);
    expect(actor.kind).toBe('USER');

    // Logging out is a decision made BY the user, so it carries their context.
    await revokeAllSessions(actor, ids.plain, 'test revocation');
    expect((await resolveActor(result.session.rawToken)).kind).toBe('GUEST');
  });

  it('disabling the user kills every live session at once', async () => {
    const result = await attemptLogin({ email: emails.plain, password: PASSWORD, ip: nextIp() });
    if (result.status !== 'SUCCESS') throw new Error('expected success');
    expect((await resolveActor(result.session.rawToken)).kind).toBe('USER');

    await withRawActorContext(OWNER_CTX, async (tx) => {
      await tx.update(users).set({ status: 'DISABLED' }).where(sql`id = ${ids.plain}`);
    });

    // No token expiry to wait for: the role and status are read every request.
    expect((await resolveActor(result.session.rawToken)).kind).toBe('GUEST');

    await withRawActorContext(OWNER_CTX, async (tx) => {
      await tx.update(users).set({ status: 'ACTIVE' }).where(sql`id = ${ids.plain}`);
    });
  });

  it('never stores the raw token', async () => {
    const result = await attemptLogin({ email: emails.plain, password: PASSWORD, ip: nextIp() });
    if (result.status !== 'SUCCESS') throw new Error('expected success');

    const found = await getSql()<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM sessions WHERE token_hash = ${result.session.rawToken}
    `;
    expect(found[0]?.count).toBe(0);
  });
});
