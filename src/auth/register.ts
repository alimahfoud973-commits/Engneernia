import 'server-only';
import { getSql } from '@/db';
import { withRawActorContext } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { GUEST } from '@/authz/actor';
import { REGISTRATION_RULES, consumeRateLimit } from '@/lib/rate-limit';
import { assertPasswordAcceptable, hashPassword } from './password';

/**
 * ===========================================================================
 * SELF-REGISTRATION (owner decision on OPEN-23, revised by 0056)
 * ===========================================================================
 * Anyone can create a customer account with an address and a password, and
 * sign in with them straight away. There is no confirmation step and no mail
 * at registration — the owner reversed the email confirmation OPEN-23 first
 * chose. That makes this the one path where a stranger can create a row in
 * `users`, so three properties matter more here than anywhere else:
 *
 *   1. THE FORM ANSWERS THE SAME THING EVERY TIME. Whether the address is new
 *      or already has an account, the browser is told the same sentence.
 *      Anything else turns the form into a way to ask whether a given person
 *      buys from this platform (§36).
 *
 *   2. AN EXISTING ACCOUNT IS NEVER CHANGED. Registering an address that is
 *      already taken does nothing at all — no new password, no new name. The
 *      account is usable from its first moment, so replacing anything on it
 *      would hand it to whoever typed the address second.
 *
 *   3. THE ROLE IS NOT AN INPUT. `app_register_customer` hard-codes CUSTOMER.
 *      Nothing on this path can name a role, so no future missing validation
 *      can promote anyone (§32, §46).
 * ===========================================================================
 */

export type RegisterOutcome = 'CREATED' | 'ALREADY_EXISTS';

export interface RegisterRequest {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly locale?: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/**
 * Accepts, or throws. Never returns a value the caller could turn into a
 * different message for the browser — the outcome is returned for the audit
 * log and the tests, and the action deliberately ignores it.
 */
export async function registerCustomer(request: RegisterRequest): Promise<RegisterOutcome> {
  /**
   * Lowercased before anything else.
   *
   * `users.email` is citext and every lookup now casts to it, so matching no
   * longer depends on this. Storing one canonical form anyway keeps the column
   * consistent with the accounts `bootstrap-owner.ts` creates, and keeps the
   * rate-limit bucket for `Ali@x.com` and `ali@x.com` the same bucket — which
   * it would not otherwise be, since the bucket key is a hash of the string.
   */
  const email = request.email.trim().toLowerCase();
  const displayName = request.displayName.trim();

  assertPasswordAcceptable(request.password);

  await consumeRateLimit('register:ip', request.ip ?? 'unknown', REGISTRATION_RULES.perIp);
  await consumeRateLimit('register:address', email, REGISTRATION_RULES.perAddress);

  const passwordHash = await hashPassword(request.password);

  const rows = await getSql()<Array<{ user_id: string; outcome: RegisterOutcome }>>`
    SELECT * FROM app_register_customer(
      ${email},
      ${passwordHash},
      ${displayName},
      ${request.locale ?? 'ar'}
    )
  `;

  const row = rows[0];
  if (!row) throw new Error('app_register_customer returned no row');

  await audit('USER_REGISTERED', row.user_id, request, { outcome: row.outcome });
  return row.outcome;
}

async function audit(
  action: 'USER_REGISTERED' | 'USER_EMAIL_VERIFIED',
  userId: string,
  request: { ip?: string | null; userAgent?: string | null },
  after: Record<string, unknown>,
): Promise<void> {
  // As GUEST: at this moment there is no session, and the audit_logs insert
  // policy permits an unauthenticated append precisely for paths like this.
  await withRawActorContext({ actorId: '', actorRole: 'GUEST' }, (tx) =>
    recordAudit(tx, GUEST, {
      action,
      entityType: 'user',
      entityId: userId,
      after,
      ip: request.ip ?? null,
      userAgent: request.userAgent ?? null,
    }),
  );
}

export const __testing = { audit };
