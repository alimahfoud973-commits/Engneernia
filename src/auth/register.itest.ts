import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { registerCustomer } from './register';
import { attemptMemberLogin } from './login';
import { resolveActor } from './session';
import { isOwner } from '@/authz/actor';
import { withRawActorContext } from '@/db/actor-context';
import { closeDb, getSql } from '@/db';
import { users } from '@/db/schema';
import { RateLimitedError, REGISTRATION_RULES } from '@/lib/rate-limit';
import { ValidationError } from '@/lib/errors';

/**
 * ===========================================================================
 * SUBSCRIBER REGISTRATION, AGAINST A REAL DATABASE (Stage 6)
 * ===========================================================================
 * The owner's model: a name, a phone and an email; an ACTIVE CUSTOMER at
 * once, signed in, able to buy. No password, no approval, no PENDING.
 * Every assertion reads the row the database kept or the session the browser
 * would hold — not what the function said it did.
 * ===========================================================================
 */

const OWNER_CTX = { actorId: randomUUID(), actorRole: 'OWNER' };
const suffix = Date.now();
const tail = String(suffix).slice(-6);

/** A unique E.164 number per label, for this run. */
let phoneCounter = 10;
const newPhone = () => `+96393${tail}${(phoneCounter += 1)}`;
const address = (label: string) => `register-${label}+${suffix}@test.local`;

let ipCounter = 0;
/** A fresh IP per call: the per-IP limiter is real and would otherwise bleed. */
const nextIp = () => `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter += 1) % 250}`;

afterAll(async () => {
  await withRawActorContext(OWNER_CTX, async (tx) => {
    await tx.delete(users).where(sql`email LIKE ${`register-%+${suffix}@test.local`}`);
  });
  await getSql()`DELETE FROM rate_limit_buckets WHERE key LIKE 'register:%' OR key LIKE 'login:%'`;
  await closeDb();
});

interface StoredUser {
  id: string;
  role: string;
  status: string;
  phone: string | null;
  email: string | null;
  display_name: string;
  password_hash: string | null;
  username: string | null;
}

async function stored(where: { phone?: string; email?: string }): Promise<StoredUser[]> {
  return withRawActorContext(OWNER_CTX, async (tx) => {
    const rows = await tx.execute(sql`
      SELECT id, role::text AS role, status::text AS status, phone, email::text AS email,
             display_name, password_hash, username::text AS username
        FROM users
       WHERE (${where.phone ?? null}::text IS NOT NULL AND phone = ${where.phone ?? null})
          OR (${where.email ?? null}::text IS NOT NULL AND email = ${where.email ?? null}::citext)
    `);
    return rows as unknown as StoredUser[];
  });
}

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

const register = (displayName: string, phone: string, email: string) =>
  registerCustomer({ displayName, phone, email, ip: nextIp() });

describe('a valid registration', () => {
  it('creates an ACTIVE CUSTOMER with the name and phone, and no password', async () => {
    const phone = newPhone();
    const email = address('valid');
    const result = await register('مشترك صحيح', phone, email);
    expect(result.outcome).toBe('CREATED');

    const [row] = await stored({ phone });
    expect(row).toMatchObject({
      role: 'CUSTOMER',
      status: 'ACTIVE',
      phone,
      email,
      display_name: 'مشترك صحيح',
      password_hash: null,
      username: null,
    });
  });

  it('signs the subscriber in at once — no approval step, no email step', async () => {
    const phone = newPhone();
    const result = await register('مشترٍ فوري', phone, address('signed-in'));
    if (result.outcome !== 'CREATED') throw new Error('expected CREATED');

    const actor = await resolveActor(result.session.rawToken);
    expect(actor.kind).toBe('USER');
    if (actor.kind !== 'USER') return;
    expect(actor.userId).toBe(result.userId);
    expect(actor.role).toBe('CUSTOMER');
    expect(isOwner(actor)).toBe(false);
  });

  it('can sign in again later with the phone and the email, and nothing else', async () => {
    const phone = newPhone();
    const email = address('again');
    await register('يعود لاحقاً', phone, email);
    const login = await attemptMemberLogin({ phone, email, ip: nextIp() });
    expect(login.status).toBe('SUCCESS');
  });
});

describe('the phone is normalised to E.164 before it is stored', () => {
  it('reads Arabic-Indic digits and ignores spaces', async () => {
    const phone = newPhone(); // +96393xxxxxxnn
    const arabic = phone
      .replace('+', '00')
      .replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    const spaced = `${arabic.slice(0, 5)} ${arabic.slice(5, 9)} ${arabic.slice(9)}`;
    const result = await register('أرقام عربية', spaced, address('arabic'));
    expect(result.outcome).toBe('CREATED');
    expect((await stored({ phone }))[0]?.phone).toBe(phone);
  });

  it('turns a leading 00963 into +963', async () => {
    const phone = newPhone();
    const result = await register('صفران', phone.replace('+', '00'), address('double-zero'));
    expect(result.outcome).toBe('CREATED');
    expect((await stored({ phone }))[0]?.phone).toBe(phone);
  });

  it.each([
    ['a local number with no country code', '0933123456'],
    ['a number with no prefix at all', '963933123456'],
    ['letters', '+96393abc1234'],
    ['too short', '+9631234'],
    ['too long', '+9639331234567890'],
  ])('refuses %s, and stores nothing', async (_label, phone) => {
    const email = address(`bad-phone-${phone.replace(/\W/g, '')}`);
    await expect(register('هاتف خاطئ', phone, email)).rejects.toBeInstanceOf(ValidationError);
    expect(await stored({ email })).toHaveLength(0);
  });
});

describe('the other fields are validated', () => {
  it('refuses a name shorter than two characters', async () => {
    const phone = newPhone();
    await expect(register('ا', phone, address('short-name'))).rejects.toBeInstanceOf(ValidationError);
    expect(await stored({ phone })).toHaveLength(0);
  });

  it('refuses a malformed email', async () => {
    const phone = newPhone();
    await expect(register('بريد خاطئ', phone, 'not-an-address')).rejects.toBeInstanceOf(ValidationError);
    expect(await stored({ phone })).toHaveLength(0);
  });

  it('the DATABASE refuses bad input on its own, not only the application', async () => {
    const call = (name: string, phone: string, email: string) =>
      getSql()`SELECT * FROM app_register_customer(${name}, ${phone}, ${email}, 'ar')`;
    await expect(call('اسم', '0933123456', address('db-phone'))).rejects.toMatchObject({ code: '23514' });
    await expect(call('اسم', newPhone(), 'nope')).rejects.toMatchObject({ code: '23514' });
    await expect(call('ا', newPhone(), address('db-name'))).rejects.toMatchObject({ code: '23514' });
  });
});

describe('an existing phone or email is never taken over', () => {
  it('a duplicate phone creates nothing and changes nothing', async () => {
    const phone = newPhone();
    const email = address('first-owner');
    await register('الأول', phone, email);

    const second = await register('المتطفل', phone, address('intruder'));
    expect(second.outcome).toBe('ALREADY_EXISTS');
    expect('session' in second).toBe(false);

    const rows = await stored({ phone });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ display_name: 'الأول', email });
    expect(await stored({ email: address('intruder') })).toHaveLength(0);
  });

  it('a duplicate email creates nothing and changes nothing', async () => {
    const phone = newPhone();
    const email = address('email-owner');
    await register('صاحب البريد', phone, email);

    const second = await register('آخر', newPhone(), email.toUpperCase());
    expect(second.outcome).toBe('ALREADY_EXISTS');

    const rows = await stored({ email });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ display_name: 'صاحب البريد', phone });
  });

  it('two registrations of one phone at the same moment make exactly one account', async () => {
    const phone = newPhone();
    const results = await Promise.all([
      register('سباق أ', phone, address('race-a')),
      register('سباق ب', phone, address('race-b')),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['ALREADY_EXISTS', 'CREATED']);
    expect(await stored({ phone })).toHaveLength(1);
  });
});

describe('no path to PENDING, approval, a role or a password', () => {
  it('the database refuses a PENDING user outright', async () => {
    const text = await rejectionText(
      withRawActorContext(OWNER_CTX, (tx) => tx.execute(sql`
        INSERT INTO users (email, phone, role, status, display_name)
        VALUES (${address('pending')}, ${newPhone()}, 'CUSTOMER', 'PENDING', 'معلّق')
      `)),
    );
    expect(text).toContain('users_no_pending');
  });

  it('registration takes no role and no status: the function has four text parameters', async () => {
    const [signature] = await getSql()<Array<{ args: string }>>`
      SELECT pg_get_function_identity_arguments('app_register_customer'::regproc) AS args
    `;
    expect(signature?.args).toBe('p_display_name text, p_phone text, p_email text, p_locale text');
  });
});

describe('abuse', () => {
  it(`refuses the same phone after ${REGISTRATION_RULES.perAddress.limit} attempts, and says how long to wait`, async () => {
    const phone = newPhone();
    const attempt = (n: number) => register('محاولة', phone, address(`limit-${n}`));
    for (let n = 0; n < REGISTRATION_RULES.perAddress.limit; n += 1) await attempt(n);
    const refused = await attempt(99).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RateLimitedError);
    // The value, not only the refusal (CLAUDE.md: the error path itself).
    expect((refused as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('writes neither the phone nor the email into the audit log', async () => {
    const phone = newPhone();
    const email = address('audit');
    const result = await register('تدقيق', phone, email);
    if (result.outcome !== 'CREATED') throw new Error('expected CREATED');

    const rows = await withRawActorContext(OWNER_CTX, (tx) => tx.execute(sql`
      SELECT coalesce(before::text, '') || coalesce(after::text, '') || entity_id AS text
        FROM audit_logs WHERE entity_id = ${result.userId}
    `)) as unknown as Array<{ text: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.text).not.toContain(phone);
      expect(row.text).not.toContain(email);
    }
  });
});
