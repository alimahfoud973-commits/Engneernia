import 'server-only';
import { getSql, toDate } from '@/db';
import { withRawActorContext } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { GUEST, type Role } from '@/authz/actor';
import { LOCKOUT, LOGIN_RULES, consumeRateLimit } from '@/lib/rate-limit';
import { normalizePhone } from '@/lib/phone';
import { verifyPassword, wasteTimeLikeAVerification } from './password';
import { createSession, type CreatedSession } from './session';

/**
 * ===========================================================================
 * SIGNING IN — TWO DOORS (Stage 6, owner decision)
 * ===========================================================================
 * A SUBSCRIBER or ENGINEER signs in with their phone AND their email. There
 * is no password: both must belong to the same account, and the database
 * answers only on a full match (`app_auth_lookup_member`). That function
 * cannot return the owner — the OWNER role is excluded in SQL, so knowing the
 * owner's phone and email opens nothing.
 *
 * The OWNER signs in with a username and a password, through a function that
 * can return the owner row and nothing else (`app_auth_lookup_owner`).
 *
 * Neither phone nor email is a secret. The owner accepted that (DECISIONS.md,
 * Stage 6); what this file adds is what can still be added:
 *   1. RATE LIMITS per IP and per identifier, counted BEFORE the lookup, so an
 *      unknown identifier costs exactly what a known one does;
 *   2. ONE ANSWER for every mismatch — an unknown phone, a known phone with
 *      another email, an unknown username and a wrong password all read the
 *      same. Only a caller who presented the account's full credentials learns
 *      that it is disabled;
 *   3. for the owner's password, the ACCOUNT LOCKOUT and uniform timing the
 *      password path always had.
 * ===========================================================================
 */

export type LoginOutcome =
  | { readonly status: 'SUCCESS'; readonly userId: string; readonly role: Role; readonly session: CreatedSession }
  | { readonly status: 'INVALID_CREDENTIALS' }
  | { readonly status: 'ACCOUNT_LOCKED'; readonly until: Date }
  | { readonly status: 'ACCOUNT_DISABLED' };

interface RequestContext {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly correlationId?: string | null;
}

export interface MemberLoginRequest extends RequestContext {
  readonly phone: string;
  readonly email: string;
}

interface MemberRow {
  id: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED' | 'PENDING';
  display_name: string;
}

/** A subscriber or an engineer: phone + email, one account. */
export async function attemptMemberLogin(request: MemberLoginRequest): Promise<LoginOutcome> {
  const phone = normalizePhone(request.phone);
  const email = request.email.trim().toLowerCase();

  // Counted before anything is looked up, and keyed on what was TYPED when it
  // is not a number at all — a malformed phone is still an attempt.
  await consumeRateLimit('login:ip', request.ip ?? 'unknown', LOGIN_RULES.perIp);
  await consumeRateLimit('login:member', phone ?? request.phone.trim(), LOGIN_RULES.perAccount);

  if (!phone || email.length === 0) {
    await audit(null, null, 'LOGIN_FAILED', 'unknown-member', request);
    return { status: 'INVALID_CREDENTIALS' };
  }

  const rows = await getSql()<MemberRow[]>`
    SELECT * FROM app_auth_lookup_member(${phone}, ${email})
  `;
  const user = rows[0];

  if (!user) {
    await audit(null, null, 'LOGIN_FAILED', 'unknown-member', request);
    return { status: 'INVALID_CREDENTIALS' };
  }

  // Both credentials matched, so saying WHY they cannot get in is a remedy,
  // not a disclosure.
  if (user.status !== 'ACTIVE') {
    await audit(user.id, user.role, 'LOGIN_FAILED', user.id, request);
    return { status: 'ACCOUNT_DISABLED' };
  }

  return succeed(user.id, user.role, request);
}

export interface OwnerLoginRequest extends RequestContext {
  readonly username: string;
  readonly password: string;
}

interface OwnerRow {
  id: string;
  password_hash: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED' | 'PENDING';
  display_name: string;
  locked_until: Date | string | null;
  failed_login_count: number;
}

/** The owner: username + password. No second factor (owner decision). */
export async function attemptOwnerLogin(request: OwnerLoginRequest): Promise<LoginOutcome> {
  const username = request.username.trim().toLowerCase();

  await consumeRateLimit('login:ip', request.ip ?? 'unknown', LOGIN_RULES.perIp);
  await consumeRateLimit('login:owner', username, LOGIN_RULES.perAccount);

  const rows = await getSql()<OwnerRow[]>`SELECT * FROM app_auth_lookup_owner(${username})`;
  const user = rows[0];

  // An unknown username still pays for a password verification.
  if (!user) {
    await wasteTimeLikeAVerification(request.password);
    await audit(null, null, 'LOGIN_FAILED', 'unknown-owner', request);
    return { status: 'INVALID_CREDENTIALS' };
  }

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

  if (user.status !== 'ACTIVE') {
    await audit(user.id, user.role, 'LOGIN_FAILED', user.id, request);
    return { status: 'ACCOUNT_DISABLED' };
  }

  return succeed(user.id, user.role, request);
}

/** The one place either door opens a session. */
export async function succeed(
  userId: string,
  role: Role,
  request: RequestContext,
): Promise<LoginOutcome & { status: 'SUCCESS' }> {
  await getSql()`SELECT app_auth_record_success(${userId}::uuid)`;
  const session = await createSession({
    userId,
    ip: request.ip ?? null,
    userAgent: request.userAgent ?? null,
  });
  await audit(userId, role, 'LOGIN_SUCCEEDED', userId, request);
  return { status: 'SUCCESS', userId, role, session };
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
