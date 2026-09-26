import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { registerCustomer } from './register';
import { consumeVerificationToken } from './verify-email';
import { attemptLogin } from './login';
import { resolveActor } from './session';
import { isFullyAuthenticated, isOwner } from '@/authz/actor';
import { withActor, withRawActorContext } from '@/db/actor-context';
import { closeDb, getSql } from '@/db';
import { users } from '@/db/schema';
import { resetEmailForTests, setEmailForTests, type EmailMessage } from '@/email';

/**
 * Self-registration end to end, against a real database (owner decision on
 * OPEN-23, revised by migration 0056).
 *
 * The owner's rule: an account is usable the moment it is created. Signing in
 * takes the address and the password, and nothing else — no link, no code,
 * no mail. Every test here reads the outcome from the same places a customer
 * meets it: the login answer and the session the browser would hold.
 */

const OWNER_CTX = { actorId: randomUUID(), actorRole: 'OWNER' };
const suffix = Date.now();
const PASSWORD = 'a-perfectly-fine-long-password';
const OTHER_PASSWORD = 'another-perfectly-fine-password';

const address = (label: string) => `register-${label}+${suffix}@test.local`;

/** Captures anything sent. Registration must send nothing at all. */
const outbox: EmailMessage[] = [];

let ipCounter = 0;
/** A fresh IP per call: the per-IP limiter is real and would otherwise bleed. */
const nextIp = () => `10.9.0.${(ipCounter += 1)}`;

beforeAll(() => {
  setEmailForTests({
    name: 'capture',
    async send(message) {
      outbox.push(message);
    },
  });
});

beforeEach(() => {
  outbox.length = 0;
});

afterAll(async () => {
  resetEmailForTests();
  await withRawActorContext(OWNER_CTX, async (tx) => {
    await tx.delete(users).where(sql`email LIKE ${`register-%+${suffix}@test.local`}`);
  });
  await getSql()`DELETE FROM rate_limit_buckets WHERE key LIKE 'register:%' OR key LIKE 'login:%'`;
  await closeDb();
});

async function statusOf(email: string) {
  const rows = await withRawActorContext(OWNER_CTX, (tx) =>
    tx.execute(sql`
      SELECT status::text AS status, role::text AS role, display_name AS name
        FROM users WHERE email = ${email}::citext
    `),
  );
  return rows[0] as unknown as { status: string; role: string; name: string };
}

describe('the journey a customer actually walks', () => {
  const email = address('journey');

  it('creates an ACTIVE customer and sends no email', async () => {
    const outcome = await registerCustomer({
      email, password: PASSWORD, displayName: 'زين', ip: nextIp(),
    });

    expect(outcome).toBe('CREATED');
    expect(await statusOf(email)).toMatchObject({ status: 'ACTIVE', role: 'CUSTOMER' });
    expect(outbox).toHaveLength(0);
  });

  it('signs in straight away with the right password — no code, no second step', async () => {
    const outcome = await attemptLogin({ email, password: PASSWORD, ip: nextIp() });
    expect(outcome.status).toBe('SUCCESS');
    if (outcome.status !== 'SUCCESS') return;

    // The session the browser receives is a complete login: nothing is owed,
    // and PostgreSQL resolves it (app_auth_resolve_session admits ACTIVE only).
    const actor = await resolveActor(outcome.session.rawToken);
    expect(actor.kind).toBe('USER');
    expect(isFullyAuthenticated(actor)).toBe(true);
    expect(outbox).toHaveLength(0);
  });

  it('accepts the address in any letter case', async () => {
    const outcome = await attemptLogin({ email: email.toUpperCase(), password: PASSWORD, ip: nextIp() });
    expect(outcome.status).toBe('SUCCESS');
  });

  it('refuses a wrong password', async () => {
    const outcome = await attemptLogin({ email, password: OTHER_PASSWORD, ip: nextIp() });
    expect(outcome.status).toBe('INVALID_CREDENTIALS');
  });

  it('refuses an address that has no account, with the same answer', async () => {
    const outcome = await attemptLogin({ email: address('nobody'), password: PASSWORD, ip: nextIp() });
    expect(outcome.status).toBe('INVALID_CREDENTIALS');
  });

  it('gives a new customer nothing an owner has', async () => {
    const outcome = await attemptLogin({ email, password: PASSWORD, ip: nextIp() });
    if (outcome.status !== 'SUCCESS') throw new Error('expected a direct sign-in');
    const actor = await resolveActor(outcome.session.rawToken);

    expect(isOwner(actor)).toBe(false);
    const seenAsOwner = await withActor(actor, async (tx) => {
      const rows = await tx.execute(sql`SELECT app_is_owner() AS owner`);
      return (rows as unknown as Array<{ owner: boolean }>)[0]?.owner;
    });
    expect(seenAsOwner).toBe(false);
  });
});

describe('an address that is already taken', () => {
  it('changes nothing on the existing account — no takeover by registering again', async () => {
    const email = address('taken');
    await registerCustomer({ email, password: PASSWORD, displayName: 'المالك', ip: nextIp() });

    const outcome = await registerCustomer({
      email, password: OTHER_PASSWORD, displayName: 'مهاجم', ip: nextIp(),
    });

    expect(outcome).toBe('ALREADY_EXISTS');
    expect((await statusOf(email)).name).toBe('المالك');
    expect((await attemptLogin({ email, password: OTHER_PASSWORD, ip: nextIp() })).status)
      .toBe('INVALID_CREDENTIALS');
    expect((await attemptLogin({ email, password: PASSWORD, ip: nextIp() })).status)
      .toBe('SUCCESS');
    expect(outbox).toHaveLength(0);
  });

  it('treats the address case-insensitively, as the unique index does', async () => {
    const email = address('CaseSensitive');
    await registerCustomer({ email, password: PASSWORD, displayName: 'حالة', ip: nextIp() });

    const outcome = await registerCustomer({
      email: email.toUpperCase(), password: OTHER_PASSWORD, displayName: 'حالة', ip: nextIp(),
    });
    expect(outcome).toBe('ALREADY_EXISTS');
  });

  it('survives two sign-ups for one address at the same moment', async () => {
    const email = address('race');
    const outcomes = await Promise.all([
      registerCustomer({ email, password: PASSWORD, displayName: 'أ', ip: nextIp() }),
      registerCustomer({ email, password: OTHER_PASSWORD, displayName: 'ب', ip: nextIp() }),
    ]);
    expect([...outcomes].sort()).toEqual(['ALREADY_EXISTS', 'CREATED']);
  });
});

describe('what registration must never be able to do', () => {
  it('cannot create anything but a CUSTOMER', async () => {
    const email = address('role');
    await registerCustomer({ email, password: PASSWORD, displayName: 'دور', ip: nextIp() });

    // The role is not a parameter of app_register_customer at all; this test
    // is here so that adding one later fails loudly.
    expect((await statusOf(email)).role).toBe('CUSTOMER');
  });

  it('cannot reactivate an account the owner disabled', async () => {
    const email = address('disabled');
    await registerCustomer({ email, password: PASSWORD, displayName: 'معطّل', ip: nextIp() });
    await withRawActorContext(OWNER_CTX, (tx) =>
      tx.execute(sql`UPDATE users SET status = 'DISABLED' WHERE email = ${email}::citext`),
    );

    const outcome = await registerCustomer({
      email, password: OTHER_PASSWORD, displayName: 'مهاجم', ip: nextIp(),
    });

    expect(outcome).toBe('ALREADY_EXISTS');
    expect((await statusOf(email)).status).toBe('DISABLED');
    expect((await attemptLogin({ email, password: PASSWORD, ip: nextIp() })).status)
      .toBe('ACCOUNT_DISABLED');
  });

  it('has no path left that creates an account waiting for an email', async () => {
    // 0039's six-argument function issued a token and created PENDING; 0056
    // dropped it. Asking for it by that signature must find nothing.
    const rows = await getSql()<Array<{ exists: boolean }>>`
      SELECT to_regprocedure(
        'app_register_customer(text, text, text, text, text, timestamptz)'
      ) IS NOT NULL AS exists
    `;
    expect(rows[0]?.exists).toBe(false);
  });
});

describe('links already sitting in inboxes', () => {
  it('a forged or empty token still touches nothing', async () => {
    expect(await consumeVerificationToken({ rawToken: 'not-a-real-token' })).toBe('INVALID');
    expect(await consumeVerificationToken({ rawToken: '' })).toBe('INVALID');
  });
});

describe('the token table is out of the application\'s reach', () => {
  /**
   * 0039's tokens are no longer issued, but the table and its links remain;
   * the application role still must not read or forge them.
   *
   * Drizzle wraps the driver error in a "Failed query" of its own, so the
   * reason PostgreSQL gave is one level down. Asserting only that the promise
   * rejects would pass on a typo in the table name just as happily.
   */
  async function refusalReason(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause;
      return `${(error as Error).message} ${cause?.message ?? ''}`;
    }
    throw new Error('The database allowed it. It must not.');
  }

  it('refuses the application role a direct read', async () => {
    const reason = await refusalReason(() =>
      withRawActorContext(OWNER_CTX, (tx) =>
        tx.execute(sql`SELECT count(*) FROM email_verification_tokens`),
      ),
    );
    expect(reason).toMatch(/permission denied/i);
  });

  it('refuses the application role a direct write, even as OWNER', async () => {
    const reason = await refusalReason(() =>
      withRawActorContext(OWNER_CTX, (tx) =>
        tx.execute(sql`
          INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
          VALUES (gen_random_uuid(), 'forged', now() + interval '1 day')
        `),
      ),
    );
    expect(reason).toMatch(/permission denied/i);
  });
});
