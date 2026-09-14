import 'server-only';
import { getSql, toDate } from '@/db';
import { withRawActorContext } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { GUEST, type Role } from '@/authz/actor';
import { LOCKOUT, LOGIN_RULES, consumeRateLimit } from '@/lib/rate-limit';
import { verifyPassword, wasteTimeLikeAVerification } from './password';
import { createSession, type CreatedSession } from './session';
import { decryptSecret } from './crypto';
import { verifyTotp } from './totp';

/**
 * ===========================================================================
 * LOGIN
 * ===========================================================================
 * Three defences layered, because each covers what the others miss:
 *
 *   1. RATE LIMIT per IP and per account — blunts distributed guessing.
 *   2. ACCOUNT LOCKOUT after repeated failures — blunts targeted guessing.
 *   3. UNIFORM TIMING AND MESSAGING — an attempt against an unknown address
 *      costs the same time and returns the same answer as one against a known
 *      address, so the login form cannot be used to enumerate the user table.
 * ===========================================================================
 */

export type LoginOutcome =
  | { readonly status: 'SUCCESS'; readonly userId: string; readonly role: Role; readonly session: CreatedSession }
  | { readonly status: 'TWO_FACTOR_REQUIRED'; readonly userId: string; readonly session: CreatedSession }
  | { readonly status: 'INVALID_CREDENTIALS' }
  | { readonly status: 'ACCOUNT_LOCKED'; readonly until: Date }
  | { readonly status: 'ACCOUNT_DISABLED' }
  | { readonly status: 'EMAIL_NOT_VERIFIED' };

interface LookupRow {
  id: string;
  password_hash: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED' | 'PENDING';
  display_name: string;
  locked_until: Date | string | null;
  failed_login_count: number;
  totp_secret_encrypted: string | null;
  totp_enabled_at: Date | string | null;
}

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly correlationId?: string | null;
}

export async function attemptLogin(request: LoginRequest): Promise<LoginOutcome> {
  const email = request.email.trim().toLowerCase();

  // Defence 1. Throws RateLimitedError, which the route turns into a 429.
  await consumeRateLimit('login:ip', request.ip ?? 'unknown', LOGIN_RULES.perIp);
  await consumeRateLimit('login:account', email, LOGIN_RULES.perAccount);

  const rows = await getSql()<LookupRow[]>`SELECT * FROM app_auth_lookup_user(${email})`;
  const user = rows[0];

  // Defence 3. An unknown address still pays for a password verification.
  if (!user) {
    await wasteTimeLikeAVerification(request.password);
    await audit(null, null, 'LOGIN_FAILED', 'unknown-email', request);
    return { status: 'INVALID_CREDENTIALS' };
  }

  // Defence 2.
  const lockedUntil = toDate(user.locked_until);
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    await audit(user.id, user.role, 'LOGIN_LOCKED_OUT', user.id, request);
    return { status: 'ACCOUNT_LOCKED', until: lockedUntil };
  }

  const passwordOk = await verifyPassword(user.password_hash, request.password);

  if (!passwordOk) {
    await getSql()`
      SELECT app_auth_record_failure(${user.id}::uuid, ${LOCKOUT.maxAttempts}, ${LOCKOUT.lockMinutes})
    `;
    await audit(user.id, user.role, 'LOGIN_FAILED', user.id, request);
    return { status: 'INVALID_CREDENTIALS' };
  }

  // The password was right, so telling them WHY they cannot get in is useful
  // rather than a disclosure — they already proved they own the credentials.
  //
  // PENDING and DISABLED are separated because the remedy is not the same, and
  // since self-registration exists (OPEN-23) PENDING is the common case: an
  // account waiting on its verification link. Telling that person to "contact
  // the platform" — as this did when PENDING was unreachable — sends them to
  // the owner's inbox for something a link in their own inbox already solves.
  if (user.status === 'PENDING') {
    await audit(user.id, user.role, 'LOGIN_FAILED', user.id, request);
    return { status: 'EMAIL_NOT_VERIFIED' };
  }

  if (user.status !== 'ACTIVE') {
    await audit(user.id, user.role, 'LOGIN_FAILED', user.id, request);
    return { status: 'ACCOUNT_DISABLED' };
  }

  await getSql()`SELECT app_auth_record_success(${user.id}::uuid)`;

  const twoFactorRequired = toDate(user.totp_enabled_at) !== null;
  const session = await createSession({
    userId: user.id,
    ip: request.ip ?? null,
    userAgent: request.userAgent ?? null,
    twoFactorVerified: !twoFactorRequired,
  });

  if (twoFactorRequired) {
    // The session exists but is not yet trusted: `twoFactorSatisfied` is false
    // until the challenge is answered, and the route gate refuses it.
    return { status: 'TWO_FACTOR_REQUIRED', userId: user.id, session };
  }

  await audit(user.id, user.role, 'LOGIN_SUCCEEDED', user.id, request);
  return { status: 'SUCCESS', userId: user.id, role: user.role, session };
}

/** Second step for accounts with TOTP enrolled. */
export async function verifyLoginTotp(input: {
  userId: string;
  /**
   * Resolved through a TRUSTED lookup, not an ordinary query.
   *
   * This read `(SELECT email FROM users WHERE id = …)` through `getSql()`,
   * which carries no actor context: `app_actor_id()` is empty, `users_select`
   * admits nothing, the subquery yielded NULL, and the trusted function was
   * handed NULL — so this answered FALSE for every code ever submitted, and
   * the second factor could not be passed at all.
   *
   * The caller cannot look the address up either: a session that has not yet
   * answered its factor is announced to PostgreSQL as a guest, which is the
   * point of that rule. So the lookup is by id, through a SECURITY DEFINER
   * function, exactly as `attemptLogin` reaches the one by email. Migration
   * 0044.
   *
   * Nothing caught this: no screen called it, and no test did either — the
   * two-factor tests exercised `attemptLogin` and the secret's round-trip
   * through encryption, and stopped short of the one function that decides
   * whether a code is right.
   */
  code: string;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}): Promise<boolean> {
  await consumeRateLimit('login:totp', input.userId, LOGIN_RULES.perAccount);

  const rows = await getSql()<LookupRow[]>`
    SELECT * FROM app_auth_lookup_user_by_id(${input.userId}::uuid)
  `;
  const user = rows[0];
  if (!user?.totp_secret_encrypted) return false;

  const secret = decryptSecret(user.totp_secret_encrypted);
  const ok = verifyTotp(secret, input.code);

  await audit(
    user.id,
    user.role,
    ok ? 'LOGIN_SUCCEEDED' : 'LOGIN_FAILED',
    user.id,
    input,
  );
  return ok;
}

/**
 * Audit writes for the login path run as GUEST: at this moment there is no
 * session, and the audit_logs insert policy deliberately permits an
 * unauthenticated append so that failed attempts are still recorded.
 */
async function audit(
  userId: string | null,
  role: Role | null,
  action: 'LOGIN_FAILED' | 'LOGIN_SUCCEEDED' | 'LOGIN_LOCKED_OUT',
  entityId: string,
  request: { ip?: string | null; userAgent?: string | null; correlationId?: string | null },
): Promise<void> {
  const actor =
    userId && role
      ? ({
          kind: 'USER' as const,
          userId,
          role,
          displayName: '',
          locale: 'ar',
          sessionId: '',
          contributorId: null,
          contributorActive: false,
          twoFactorSatisfied: false, totpEnabled: false,
        })
      : GUEST;

  await withRawActorContext({ actorId: '', actorRole: 'GUEST' }, (tx) =>
    recordAudit(tx, actor, {
      action,
      entityType: 'user',
      entityId,
      ip: request.ip ?? null,
      userAgent: request.userAgent ?? null,
      correlationId: request.correlationId ?? null,
    }),
  );
}
