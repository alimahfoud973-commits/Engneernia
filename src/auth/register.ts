import 'server-only';
import { getSql } from '@/db';
import { withRawActorContext } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { GUEST } from '@/authz/actor';
import { REGISTRATION_RULES, consumeRateLimit } from '@/lib/rate-limit';
import { normalizePhone } from '@/lib/phone';
import { ValidationError } from '@/lib/errors';
import { succeed } from './login';
import type { CreatedSession } from './session';

/**
 * ===========================================================================
 * SUBSCRIBER REGISTRATION (Stage 6, owner decision)
 * ===========================================================================
 * A name, a phone and an email — nothing else. The account is an ACTIVE
 * CUSTOMER from its first moment and is signed in at once, so the subscriber
 * can buy straight away: no approval, no confirmation link, no password.
 *
 * What still holds, because this is the one path where a stranger creates a
 * row in `users`:
 *
 *   1. THE ROLE AND STATUS ARE NOT INPUTS. `app_register_customer` writes
 *      CUSTOMER and ACTIVE itself; nothing here can name either (§32, §46).
 *   2. AN EXISTING ACCOUNT IS NEVER TOUCHED. A phone or an email that already
 *      belongs to someone returns ALREADY_EXISTS and changes nothing — and the
 *      answer does not say which of the two was taken.
 *   3. THE DATABASE VALIDATES TOO. The function refuses a malformed name,
 *      phone or email on its own, and the unique indexes decide two
 *      simultaneous registrations of one number.
 *
 * An existing number cannot be answered like a new one — a new one is signed
 * in, which the caller can see — so "already registered" is visible. The
 * rate limits below are what keep that from being a fast way to test numbers.
 * ===========================================================================
 */

export type RegisterResult =
  | { readonly outcome: 'CREATED'; readonly userId: string; readonly session: CreatedSession }
  | { readonly outcome: 'ALREADY_EXISTS' };

export interface RegisterRequest {
  readonly displayName: string;
  readonly phone: string;
  readonly email: string;
  readonly locale?: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function registerCustomer(request: RegisterRequest): Promise<RegisterResult> {
  const displayName = request.displayName.trim();
  const phone = normalizePhone(request.phone);
  const email = request.email.trim().toLowerCase();

  if (displayName.length < 2 || displayName.length > 80) {
    throw new ValidationError('الاسم بين حرفين وثمانين حرفاً');
  }
  if (!phone) {
    throw new ValidationError('رقم الهاتف غير صالح. اكتبه بالصيغة الدولية مثل +963933123456 أو 00963933123456');
  }
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new ValidationError('البريد الإلكتروني غير صالح');
  }

  await consumeRateLimit('register:ip', request.ip ?? 'unknown', REGISTRATION_RULES.perIp);
  await consumeRateLimit('register:address', phone, REGISTRATION_RULES.perAddress);

  const rows = await getSql()<Array<{ user_id: string | null; outcome: 'CREATED' | 'ALREADY_EXISTS' }>>`
    SELECT * FROM app_register_customer(${displayName}, ${phone}, ${email}, ${request.locale ?? 'ar'})
  `;
  const row = rows[0];
  if (!row) throw new Error('app_register_customer returned no row');

  if (row.outcome !== 'CREATED' || !row.user_id) {
    await audit('already-exists', request, { outcome: 'ALREADY_EXISTS' });
    return { outcome: 'ALREADY_EXISTS' };
  }

  await audit(row.user_id, request, { outcome: 'CREATED', role: 'CUSTOMER', status: 'ACTIVE' });
  const signedIn = await succeed(row.user_id, 'CUSTOMER', request);
  return { outcome: 'CREATED', userId: row.user_id, session: signedIn.session };
}

async function audit(
  entityId: string,
  request: { ip?: string | null; userAgent?: string | null },
  after: Record<string, unknown>,
): Promise<void> {
  // As GUEST: at this moment there is no session, and the audit_logs insert
  // policy permits an unauthenticated append precisely for paths like this.
  await withRawActorContext({ actorId: '', actorRole: 'GUEST' }, (tx) =>
    recordAudit(tx, GUEST, {
      action: 'USER_REGISTERED',
      entityType: 'user',
      entityId,
      after,
      ip: request.ip ?? null,
      userAgent: request.userAgent ?? null,
    }),
  );
}
