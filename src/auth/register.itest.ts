import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { registerCustomer, resendVerification } from './register';
import { consumeVerificationToken } from './verify-email';
import { attemptLogin } from './login';
import { withRawActorContext } from '@/db/actor-context';
import { closeDb, getSql } from '@/db';
import { users } from '@/db/schema';
import { resetEmailForTests, setEmailForTests, type EmailMessage } from '@/email';

/**
 * Self-registration end to end, against a real database (owner decision on
 * OPEN-23).
 *
 * The verification token is read OUT OF THE SENT EMAIL, never out of the
 * database. Pulling it from the table would exercise a path no customer walks
 * and would pass even if the link in the message were wrong — which is the
 * only part of this that a person actually touches.
 */

const OWNER_CTX = { actorId: randomUUID(), actorRole: 'OWNER' };
const suffix = Date.now();
const PASSWORD = 'a-perfectly-fine-long-password';
const OTHER_PASSWORD = 'another-perfectly-fine-password';

const address = (label: string) => `register-${label}+${suffix}@test.local`;

/** Captures what was sent, so a test can open the link the customer would. */
const outbox: EmailMessage[] = [];

let ipCounter = 0;
/** A fresh IP per call: the per-IP limiter is real and would otherwise bleed. */
const nextIp = () => `10.9.0.${(ipCounter += 1)}`;

function tokenFrom(message: EmailMessage): string {
  const match = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(message.text);
  if (!match?.[1]) throw new Error(`No verification link in: ${message.text}`);
  return match[1];
}

const lastMessage = () => {
  const message = outbox.at(-1);
  if (!message) throw new Error('Nothing was sent');
  return message;
};

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
  await getSql()`DELETE FROM rate_limit_buckets WHERE key LIKE 'register:%' OR key LIKE 'resend:%' OR key LIKE 'login:%'`;
  await closeDb();
});

/**
 * A connection that is allowed to look at `email_verification_tokens`.
 *
 * The application's own role is not, by design — which is why the two tests
 * below need this, and why the first test in the next block asserts that
 * refusal rather than leaving it as an accident of how the suite is written.
 */
function privilegedClient() {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL must be set to inspect the token table');
  return postgres(url, { max: 1 });
}

async function statusOf(email: string) {
  const rows = await withRawActorContext(OWNER_CTX, (tx) =>
    tx.execute(sql`
      SELECT status::text AS status, role::text AS role,
             email_verified_at IS NOT NULL AS verified
        FROM users WHERE email = ${email}::citext
    `),
  );
  return rows[0] as unknown as { status: string; role: string; verified: boolean };
}

describe('the journey a customer actually walks', () => {
  const email = address('journey');

  it('creates a PENDING customer and emails a link', async () => {
    const outcome = await registerCustomer({
      email, password: PASSWORD, displayName: 'زين', ip: nextIp(),
    });

    expect(outcome).toBe('CREATED');
    expect(await statusOf(email)).toMatchObject({
      status: 'PENDING', role: 'CUSTOMER', verified: false,
    });
    expect(lastMessage().to).toBe(email);
  });

  it('refuses the login until the address is proven, and says why', async () => {
    const outcome = await attemptLogin({ email, password: PASSWORD, ip: nextIp() });

    // Not ACCOUNT_DISABLED: the remedy is a link in their own inbox, not the
    // owner's support channel.
    expect(outcome.status).toBe('EMAIL_NOT_VERIFIED');
  });

  it('activates the account when the emailed link is opened', async () => {
    await registerCustomer({ email, password: PASSWORD, displayName: 'زين', ip: nextIp() });

    expect(await consumeVerificationToken({ rawToken: tokenFrom(lastMessage()) })).toBe('VERIFIED');
    expect(await statusOf(email)).toMatchObject({ status: 'ACTIVE', verified: true });
  });

  it('then lets the customer sign in', async () => {
    const outcome = await attemptLogin({ email, password: PASSWORD, ip: nextIp() });
    expect(outcome.status).toBe('SUCCESS');
  });
});

describe('the token', () => {
  it('works once, and a second opening of the same link is not an error', async () => {
    const email = address('replay');
    await registerCustomer({ email, password: PASSWORD, displayName: 'مرة', ip: nextIp() });
    const token = tokenFrom(lastMessage());

    expect(await consumeVerificationToken({ rawToken: token })).toBe('VERIFIED');
    // A mail client that prefetches links, or a person who clicks twice, must
    // not be shown a failure.
    expect(await consumeVerificationToken({ rawToken: token })).toBe('ALREADY_VERIFIED');
  });

  it('is refused once superseded by a newer one', async () => {
    const email = address('superseded');
    await registerCustomer({ email, password: PASSWORD, displayName: 'أولى', ip: nextIp() });
    const first = tokenFrom(lastMessage());

    await registerCustomer({ email, password: PASSWORD, displayName: 'ثانية', ip: nextIp() });
    const second = tokenFrom(lastMessage());
    expect(second).not.toBe(first);

    expect(await consumeVerificationToken({ rawToken: first })).toBe('EXPIRED_OR_SPENT');
    expect(await consumeVerificationToken({ rawToken: second })).toBe('VERIFIED');
  });

  it('is refused when expired', async () => {
    const email = address('expired');
    await registerCustomer({ email, password: PASSWORD, displayName: 'متأخر', ip: nextIp() });
    const token = tokenFrom(lastMessage());

    const privileged = privilegedClient();
    try {
      await privileged`
        UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute'
         WHERE user_id = (SELECT id FROM users WHERE email = ${email}::citext)
      `;
    } finally {
      await privileged.end();
    }

    expect(await consumeVerificationToken({ rawToken: token })).toBe('EXPIRED_OR_SPENT');
    expect(await statusOf(email)).toMatchObject({ status: 'PENDING', verified: false });
  });

  it('rejects a forged token without touching any account', async () => {
    expect(await consumeVerificationToken({ rawToken: 'not-a-real-token' })).toBe('INVALID');
    expect(await consumeVerificationToken({ rawToken: '' })).toBe('INVALID');
  });

  it('is never stored in the clear', async () => {
    const email = address('hashed');
    await registerCustomer({ email, password: PASSWORD, displayName: 'مجزَّأ', ip: nextIp() });
    const token = tokenFrom(lastMessage());

    const privileged = privilegedClient();
    try {
      const rows = await privileged<Array<{ raw: number; total: number }>>`
        SELECT
          count(*) FILTER (WHERE token_hash = ${token})::int AS raw,
          count(*)::int AS total
        FROM email_verification_tokens
      `;
      // The row exists; the string that was emailed is nowhere in it.
      expect(rows[0]?.total).toBeGreaterThan(0);
      expect(rows[0]?.raw).toBe(0);
    } finally {
      await privileged.end();
    }
  });
});

describe('the token table is out of the application\'s reach', () => {
  /**
   * This is the property the whole design rests on, so it is asserted rather
   * than assumed. It was found the honest way: two tests above were written to
   * read the table through the ordinary connection, and the database refused
   * them.
   */
  /**
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

describe('an address that is already taken', () => {
  it('lets the newest applicant take over an account nobody has verified', async () => {
    const email = address('squatted');
    await registerCustomer({ email, password: PASSWORD, displayName: 'الأول', ip: nextIp() });

    const outcome = await registerCustomer({
      email, password: OTHER_PASSWORD, displayName: 'الثاني', ip: nextIp(),
    });
    expect(outcome).toBe('PENDING_REPLACED');

    await consumeVerificationToken({ rawToken: tokenFrom(lastMessage()) });

    // Whoever proves control of the mailbox owns it. The first password is gone.
    expect((await attemptLogin({ email, password: PASSWORD, ip: nextIp() })).status)
      .toBe('INVALID_CREDENTIALS');
    expect((await attemptLogin({ email, password: OTHER_PASSWORD, ip: nextIp() })).status)
      .toBe('SUCCESS');
  });

  it('changes nothing at all when the account is already verified', async () => {
    const email = address('verified-takeover');
    await registerCustomer({ email, password: PASSWORD, displayName: 'المالك', ip: nextIp() });
    await consumeVerificationToken({ rawToken: tokenFrom(lastMessage()) });

    const outcome = await registerCustomer({
      email, password: OTHER_PASSWORD, displayName: 'مهاجم', ip: nextIp(),
    });

    expect(outcome).toBe('ALREADY_VERIFIED');
    // No link was issued: the mail sent is the "you already have an account"
    // notice, which is what keeps the form silent without leaving the real
    // owner uninformed.
    expect(lastMessage().text).not.toContain('verify-email');
    expect((await attemptLogin({ email, password: OTHER_PASSWORD, ip: nextIp() })).status)
      .toBe('INVALID_CREDENTIALS');
    expect((await attemptLogin({ email, password: PASSWORD, ip: nextIp() })).status)
      .toBe('SUCCESS');
  });

  it('treats the address case-insensitively, as the unique index does', async () => {
    const email = address('CaseSensitive');
    await registerCustomer({ email, password: PASSWORD, displayName: 'حالة', ip: nextIp() });

    // Before the citext cast in migration 0039 this second call did not find
    // the row, took the insert branch, and died on users_email_unique.
    const outcome = await registerCustomer({
      email: email.toUpperCase(), password: PASSWORD, displayName: 'حالة', ip: nextIp(),
    });
    expect(outcome).toBe('PENDING_REPLACED');
  });
});

describe('the form cannot be used to ask who has an account', () => {
  it('sends to an unknown address and a pending one without saying which is which', async () => {
    const unknown = address('resend-unknown');
    await resendVerification({ email: unknown, ip: nextIp() });
    expect(outbox).toHaveLength(0);

    const pending = address('resend-pending');
    await registerCustomer({ email: pending, password: PASSWORD, displayName: 'قيد', ip: nextIp() });
    outbox.length = 0;

    await resendVerification({ email: pending, ip: nextIp() });
    expect(outbox).toHaveLength(1);
    expect(await consumeVerificationToken({ rawToken: tokenFrom(lastMessage()) })).toBe('VERIFIED');
  });

  it('stays silent on a resend for an already-verified address', async () => {
    const email = address('resend-verified');
    await registerCustomer({ email, password: PASSWORD, displayName: 'مؤكَّد', ip: nextIp() });
    await consumeVerificationToken({ rawToken: tokenFrom(lastMessage()) });
    outbox.length = 0;

    await resendVerification({ email, ip: nextIp() });
    expect(outbox).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  it('stops a stranger from mail-bombing one address', async () => {
    const email = address('flood');
    const ip = nextIp();

    // The per-address rule is the one under test, so the IP is held constant
    // only because it would trip first otherwise — both rules apply.
    let refused = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await resendVerification({ email, ip });
      } catch {
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
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
    outbox.length = 0;

    const outcome = await registerCustomer({
      email, password: OTHER_PASSWORD, displayName: 'مهاجم', ip: nextIp(),
    });

    expect(outcome).toBe('ALREADY_VERIFIED');
    expect((await statusOf(email)).status).toBe('DISABLED');
    expect(lastMessage().text).not.toContain('verify-email');
  });
});
