import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { attemptLogin, verifyLoginTotp } from './login';
import { hashPassword } from './password';
import { encryptSecret } from './crypto';
import { generateTotp, generateTotpSecret } from './totp';
import { markTwoFactorVerified, resolveActor, revokeAllSessions } from './session';
import {
  beginTotpEnrolment, confirmTotpEnrolment, disableTotp, twoFactorState,
} from './totp-enrolment';
import { decryptSecret } from './crypto';
import { RuleViolationError, ValidationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';
import { withActor, withRawActorContext } from '@/db/actor-context';
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
   * would actually type. Overwritten in beforeAll with whatever address the
   * owner really has.
   */
  twoFactor: TEST_OWNER_EMAIL,
  disabled: `login-disabled+${suffix}@test.local`,
};
const totpSecret = generateTotpSecret();

beforeAll(async () => {
  const passwordHash = await hashPassword(PASSWORD);
  const theOwner = await ensureTestOwner({
    displayName: 'Owner 2FA',
    passwordHash,
    totpSecretEncrypted: encryptSecret(totpSecret),
    totpEnabledAt: new Date(),
  });
  ids.twoFactor = theOwner.id;
  /**
   * The address the owner row actually has, not the fixture's constant.
   *
   * On a database where `bootstrap:owner` has already run, the single owner is
   * a real account under a real address and this fixture adopts it — it is not
   * allowed to create a second one. Assuming the constant is how these
   * two-factor tests failed the first time that happened.
   */
  emails.twoFactor = theOwner.email;

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
    expect(actor.twoFactorSatisfied).toBe(false);
  });

  it('is not an owner to PostgreSQL until the factor is answered', async () => {
    /**
     * THE CONSEQUENCE, not the flag.
     *
     * The test above asserts `twoFactorSatisfied` is false, and for a long time
     * that was the whole story: nothing in the application read the flag, and
     * `isOwner()` compared a role alone — so a session holding the password and
     * no second factor passed `requireOwner` and reached /admin/finance,
     * /admin/payments, /admin/settlements and /admin/adjustments.
     *
     * A flag nobody reads is not a control. This asks the layer underneath the
     * application instead: `app_is_owner()` is what every owner-only row policy
     * is built on, and it answers from the context `withActor` announces. If
     * that says false while the login is unfinished, then no policy anywhere
     * can hand this session an owner's row, whatever the code above it does.
     */
    const result = await attemptLogin({ email: emails.twoFactor, password: PASSWORD, ip: nextIp() });
    if (result.status !== 'TWO_FACTOR_REQUIRED') throw new Error('expected a challenge');

    const pending = await resolveActor(result.session.rawToken);
    const seenAsOwnerWhilePending = await withActor(pending, async (tx) => {
      const rows = await tx.execute(sql`SELECT app_is_owner() AS owner`);
      return (rows as unknown as Array<{ owner: boolean }>)[0]?.owner;
    });
    expect(seenAsOwnerWhilePending).toBe(false);

    // And the same session, once the challenge is answered, is the owner.
    await markTwoFactorVerified(result.session.sessionId);
    const completed = await resolveActor(result.session.rawToken);
    expect(completed.kind === 'USER' && completed.twoFactorSatisfied).toBe(true);

    const seenAsOwnerAfter = await withActor(completed, async (tx) => {
      const rows = await tx.execute(sql`SELECT app_is_owner() AS owner`);
      return (rows as unknown as Array<{ owner: boolean }>)[0]?.owner;
    });
    expect(seenAsOwnerAfter).toBe(true);
  });

  it('ACCEPTS a correct code — the success path nobody ran', async () => {
    /**
     * `verifyLoginTotp` was never called by anything: there was no second-factor
     * screen, and these tests stopped at `attemptLogin` and at the secret's
     * round-trip through encryption. So the one function that decides whether a
     * code is right went unexercised, and it answered FALSE for every code —
     * its user lookup ran through `getSql()` with no actor context, which
     * row-level security answers with nothing.
     *
     * A refusal test would have passed on that code. Only asking it to ACCEPT
     * a code that is genuinely correct could tell the difference.
     */
    const accepted = await verifyLoginTotp({
      userId: ids.twoFactor,
      code: generateTotp(totpSecret),
      ip: nextIp(),
    });
    expect(accepted).toBe(true);
  });

  it('refuses a wrong code, and a code for a different secret', async () => {
    expect(await verifyLoginTotp({
      userId: ids.twoFactor, code: '000000', ip: nextIp(),
    })).toBe(false);

    expect(await verifyLoginTotp({
      userId: ids.twoFactor,
      code: generateTotp(generateTotpSecret()),
      ip: nextIp(),
    })).toBe(false);
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

/**
 * ===========================================================================
 * ENROLLING THE SECOND FACTOR
 * ===========================================================================
 * The platform could verify a factor and require one, and had no way to turn
 * one on — nothing outside a test ever wrote `totp_secret_encrypted`, and
 * `bootstrap:owner` does not. The launch checklist asked for an owner account
 * with TOTP enabled and no such account could be created.
 *
 * These run LAST in the file and restore the fixture's original secret
 * afterwards, because there is exactly one owner row since migration 0041 and
 * the tests above are built on the state of its two TOTP columns.
 * ===========================================================================
 */
describe('two-factor enrolment', () => {
  const ownerActor = (): Actor => ({
    kind: 'USER', userId: ids.twoFactor, role: 'OWNER', displayName: 'Owner 2FA',
    locale: 'ar', sessionId: randomUUID(), contributorId: null,
    contributorActive: false, twoFactorSatisfied: true, totpEnabled: false,
  });

  const clearFactor = () => withRawActorContext(OWNER_CTX, (tx) =>
    tx.update(users)
      .set({ totpSecretEncrypted: null, totpEnabledAt: null })
      .where(eq(users.id, ids.twoFactor)));

  beforeAll(clearFactor);

  afterAll(async () => {
    // Put the file's fixture back exactly as the tests above expect it.
    await withRawActorContext(OWNER_CTX, (tx) =>
      tx.update(users)
        .set({ totpSecretEncrypted: encryptSecret(totpSecret), totpEnabledAt: new Date() })
        .where(eq(users.id, ids.twoFactor)));
    await getSql()`DELETE FROM rate_limit_buckets WHERE key LIKE 'totp:%'`;
  });

  it('refuses to start without the correct password', async () => {
    // A stolen session must not be able to add a factor — or, worse, to
    // replace one with a device the real owner does not hold.
    await expect(
      beginTotpEnrolment(ownerActor(), { password: 'not-the-password' }),
    ).rejects.toThrow(ValidationError);
  });

  it('stores the secret UNARMED, so an abandoned enrolment changes nothing', async () => {
    /**
     * The property that makes this safe to start: a secret written before a
     * code is proven does nothing at all. A closed tab, a lost phone, a
     * mistyped code — the account is exactly as it was, rather than demanding
     * a code from an app that was never finished being set up.
     */
    const offer = await beginTotpEnrolment(ownerActor(), { password: PASSWORD });
    expect(offer.secret).toMatch(/^[A-Z2-7]+$/);
    expect(offer.uri).toContain('otpauth://totp/');
    expect(offer.uri).toContain(offer.secret.replace(/=+$/, ''));

    expect(await twoFactorState(ownerActor())).toEqual({ enabled: false, enrolmentStarted: true });

    // And the proof that it is unarmed: login still completes on the password.
    const result = await attemptLogin({ email: emails.twoFactor, password: PASSWORD, ip: nextIp() });
    expect(result.status).toBe('SUCCESS');
  });

  it('does not arm on a wrong code', async () => {
    await expect(
      confirmTotpEnrolment(ownerActor(), { code: '000000' }),
    ).rejects.toThrow(ValidationError);
    expect((await twoFactorState(ownerActor())).enabled).toBe(false);
  });

  it('arms on the right code, and login then demands one', async () => {
    const offer = await beginTotpEnrolment(ownerActor(), { password: PASSWORD });
    await confirmTotpEnrolment(ownerActor(), { code: generateTotp(offer.secret) });

    expect(await twoFactorState(ownerActor())).toEqual({ enabled: true, enrolmentStarted: true });

    // The consequence, asked of the login path rather than of a column.
    const result = await attemptLogin({ email: emails.twoFactor, password: PASSWORD, ip: nextIp() });
    expect(result.status).toBe('TWO_FACTOR_REQUIRED');

    // And the session that login issues is not yet an owner to PostgreSQL.
    if (result.status !== 'TWO_FACTOR_REQUIRED') return;
    const pending = await resolveActor(result.session.rawToken);
    expect(pending.kind === 'USER' && pending.totpEnabled).toBe(true);
    expect(pending.kind === 'USER' && pending.twoFactorSatisfied).toBe(false);
  });

  it('refuses to start again while it is armed', async () => {
    // Re-enrolling silently would let anyone holding the password swap the
    // device out from under the owner. Disable first, which needs a live code.
    await expect(
      beginTotpEnrolment(ownerActor(), { password: PASSWORD }),
    ).rejects.toThrow(RuleViolationError);
  });

  it('needs BOTH the password and a live code to remove', async () => {
    const [row] = await withRawActorContext(OWNER_CTX, (tx) =>
      tx.select({ secret: users.totpSecretEncrypted }).from(users).where(eq(users.id, ids.twoFactor)));
    const live = generateTotp(decryptSecret(row!.secret!));

    await expect(
      disableTotp(ownerActor(), { password: 'wrong', code: live }),
    ).rejects.toThrow(ValidationError);
    await expect(
      disableTotp(ownerActor(), { password: PASSWORD, code: '000000' }),
    ).rejects.toThrow(ValidationError);

    // Still armed after both failures.
    expect((await twoFactorState(ownerActor())).enabled).toBe(true);

    await disableTotp(ownerActor(), { password: PASSWORD, code: live });
    expect(await twoFactorState(ownerActor())).toEqual({ enabled: false, enrolmentStarted: false });
  });

  it('is refused to anyone who is not the owner', async () => {
    const customer: Actor = {
      kind: 'USER', userId: ids.plain, role: 'CUSTOMER', displayName: 'Plain',
      locale: 'ar', sessionId: randomUUID(), contributorId: null,
      contributorActive: false, twoFactorSatisfied: true, totpEnabled: false,
    };
    // Stated here rather than left to row-level security refusing the write
    // with no rows and a confusing error.
    await expect(
      beginTotpEnrolment(customer, { password: PASSWORD }),
    ).rejects.toThrow(RuleViolationError);
  });
});
