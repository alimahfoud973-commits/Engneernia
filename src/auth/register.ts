import 'server-only';
import { getSql } from '@/db';
import { withRawActorContext } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { GUEST } from '@/authz/actor';
import { REGISTRATION_RULES, consumeRateLimit } from '@/lib/rate-limit';
import { serverEnv } from '@/lib/config/env';
import { logger } from '@/lib/logger';
import { getEmail } from '@/email';
import { accountAlreadyExistsEmail, verificationEmail } from '@/email/templates';
import { getPublicSettings } from '@/platform/settings';
import { generateLinkToken, hashLinkToken } from './crypto';
import { assertPasswordAcceptable, hashPassword } from './password';

/**
 * ===========================================================================
 * SELF-REGISTRATION (owner decision on OPEN-23)
 * ===========================================================================
 * The owner chose self-registration with email confirmation. That makes this
 * the first path in the platform where a stranger can create a row in `users`,
 * so three properties matter more here than anywhere else:
 *
 *   1. THE FORM ANSWERS THE SAME THING EVERY TIME. Whether the address is new,
 *      unverified, or already a real customer, the browser is told "check your
 *      email". Anything else turns the form into a way to ask whether a given
 *      person buys from this platform (§36). The difference is carried by
 *      WHICH MAIL IS SENT, to the address itself — where only its owner reads it.
 *
 *   2. THE ROLE IS NOT AN INPUT. `app_register_customer` hard-codes CUSTOMER.
 *      Nothing on this path can name a role, so no future missing validation
 *      can promote anyone (§32, §46).
 *
 *   3. AN ACCOUNT IS NOT USABLE UNTIL THE ADDRESS IS PROVEN. The row is created
 *      PENDING; `attemptLogin` refuses it, and the checkout needs a session.
 * ===========================================================================
 */

/** How long a verification link lives. Long enough to survive a night's sleep. */
export const VERIFICATION_TTL_HOURS = 24;

export type RegisterOutcome = 'CREATED' | 'PENDING_REPLACED' | 'ALREADY_VERIFIED';

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
  const rawToken = generateLinkToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  const rows = await getSql()<Array<{ user_id: string; outcome: RegisterOutcome }>>`
    SELECT * FROM app_register_customer(
      ${email},
      ${passwordHash},
      ${displayName},
      ${request.locale ?? 'ar'},
      ${hashLinkToken(rawToken)},
      ${expiresAt.toISOString()}::timestamptz
    )
  `;

  const row = rows[0];
  if (!row) throw new Error('app_register_customer returned no row');

  const settings = await getPublicSettings();
  const appUrl = serverEnv().APP_URL;

  if (row.outcome === 'ALREADY_VERIFIED') {
    /**
     * No token was issued and nothing was changed. The mail goes to the
     * address itself, so the only person who learns that an account exists is
     * the person who already knew.
     */
    await send(
      accountAlreadyExistsEmail({
        to: email,
        displayName: displayName || email,
        signInUrl: new URL('/login', appUrl).toString(),
        platformName: settings.platformNameAr,
      }),
    );
    await audit('USER_REGISTERED', row.user_id, request, { outcome: row.outcome });
    return row.outcome;
  }

  const url = new URL('/verify-email', appUrl);
  url.searchParams.set('token', rawToken);

  await send(
    verificationEmail({
      to: email,
      displayName: displayName || email,
      url: url.toString(),
      platformName: settings.platformNameAr,
      expiresInHours: VERIFICATION_TTL_HOURS,
    }),
  );

  await audit('USER_REGISTERED', row.user_id, request, { outcome: row.outcome });
  return row.outcome;
}

/**
 * The "send it again" path.
 *
 * Returns nothing in every case. An address with no pending account, and one
 * that is already verified, both produce silence — otherwise this becomes the
 * enumeration oracle that the registration form was carefully not made into.
 */
export async function resendVerification(input: {
  readonly email: string;
  readonly ip?: string | null;
}): Promise<void> {
  const email = input.email.trim().toLowerCase();

  await consumeRateLimit('resend:ip', input.ip ?? 'unknown', REGISTRATION_RULES.perIp);
  await consumeRateLimit('resend:address', email, REGISTRATION_RULES.perAddress);

  const rawToken = generateLinkToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  const rows = await getSql()<Array<{ user_id: string; display_name: string }>>`
    SELECT * FROM app_reissue_email_verification(
      ${email},
      ${hashLinkToken(rawToken)},
      ${expiresAt.toISOString()}::timestamptz
    )
  `;

  const row = rows[0];
  if (!row) return;

  const settings = await getPublicSettings();
  const url = new URL('/verify-email', serverEnv().APP_URL);
  url.searchParams.set('token', rawToken);

  await send(
    verificationEmail({
      to: email,
      displayName: row.display_name || email,
      url: url.toString(),
      platformName: settings.platformNameAr,
      expiresInHours: VERIFICATION_TTL_HOURS,
    }),
  );
}

/**
 * Delivery failures are logged and rethrown.
 *
 * Swallowing one would leave an account that exists, cannot be verified, and
 * whose owner was told to check an inbox that will stay empty. Letting it
 * surface means the person sees a failure they can act on by trying again —
 * and the second attempt finds the account PENDING and simply reissues.
 */
async function send(message: Parameters<ReturnType<typeof getEmail>['send']>[0]): Promise<void> {
  try {
    await getEmail().send(message);
  } catch (error) {
    logger.error({ err: error, subject: message.subject }, 'Registration email failed to send');
    throw error;
  }
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
