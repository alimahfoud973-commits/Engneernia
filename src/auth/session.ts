import 'server-only';
import { getSql, toDate } from '@/db';
import { sql as drizzleSql } from 'drizzle-orm';
import type { Actor, AuthenticatedActor, Role } from '@/authz/actor';
import { GUEST } from '@/authz/actor';
import { authorize } from '@/authz/policy';
import { withActor } from '@/db/actor-context';
import { generateSessionToken, hashSessionToken, hashIp } from './crypto';

/**
 * Database-backed sessions.
 *
 * The role and status are read from the database on EVERY request, through
 * `app_auth_resolve_session`. That single decision buys three properties a
 * JWT cannot offer:
 *   - disabling a user takes effect immediately, not at token expiry;
 *   - a role change cannot be replayed from an old token;
 *   - a stolen token dies the moment the owner revokes the session.
 */

/** Absolute lifetime: a session dies at this point regardless of activity. */
export const SESSION_ABSOLUTE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
/** Idle lifetime: an untouched session expires sooner. */
export const SESSION_IDLE_TIMEOUT_MS = 3 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = '__Host-em_session';

/** Cookie attributes. `__Host-` prefix requires Secure, path=/ and no Domain. */
export function sessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProduction,
    path: '/',
    maxAge: Math.floor(SESSION_ABSOLUTE_LIFETIME_MS / 1000),
  };
}

export interface CreatedSession {
  readonly sessionId: string;
  /** Returned exactly once. Only its hash is persisted. */
  readonly rawToken: string;
  readonly expiresAt: Date;
}

export async function createSession(input: {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  twoFactorVerified: boolean;
}): Promise<CreatedSession> {
  const rawToken = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS);

  const rows = await getSql()<Array<{ app_auth_create_session: string }>>`
    SELECT app_auth_create_session(
      ${input.userId}::uuid,
      ${hashSessionToken(rawToken)},
      ${expiresAt.toISOString()}::timestamptz,
      ${hashIp(input.ip)},
      ${input.userAgent ?? null},
      ${input.twoFactorVerified}
    )
  `;

  const sessionId = rows[0]?.app_auth_create_session;
  if (!sessionId) throw new Error('Session creation returned no id');

  return { sessionId, rawToken, expiresAt };
}

interface ResolvedRow {
  session_id: string;
  user_id: string;
  role: Role;
  status: string;
  display_name: string;
  locale: string;
  contributor_id: string | null;
  contributor_active: boolean;
  // Timestamps arrive as Date or ISO string depending on the connection —
  // always read them through toDate(). See src/db/index.ts.
  two_factor_verified_at: Date | string | null;
  totp_enabled_at: Date | string | null;
  expires_at: Date | string;
  last_used_at: Date | string;
}

/**
 * Resolve a raw cookie token to an Actor.
 *
 * Returns GUEST for anything that is not a live session: unknown, expired,
 * revoked, idle-timed-out, or belonging to a disabled user. The caller never
 * has to distinguish those cases, which keeps the failure mode uniform.
 */
export async function resolveActor(rawToken: string | undefined | null): Promise<Actor> {
  if (!rawToken) return GUEST;

  const rows = await getSql()<ResolvedRow[]>`
    SELECT * FROM app_auth_resolve_session(${hashSessionToken(rawToken)})
  `;
  const row = rows[0];
  if (!row) return GUEST;

  // Idle timeout is enforced here rather than in SQL so the policy lives with
  // the rest of the session rules.
  const lastUsedAt = toDate(row.last_used_at);
  if (lastUsedAt && Date.now() - lastUsedAt.getTime() > SESSION_IDLE_TIMEOUT_MS) {
    await expireSession(row.session_id, 'idle timeout');
    return GUEST;
  }

  // Two-factor is satisfied if the account has no TOTP enrolled, or if this
  // session completed the challenge.
  const twoFactorSatisfied =
    toDate(row.totp_enabled_at) === null || toDate(row.two_factor_verified_at) !== null;

  const actor: AuthenticatedActor = {
    kind: 'USER',
    userId: row.user_id,
    role: row.role,
    displayName: row.display_name,
    locale: row.locale,
    sessionId: row.session_id,
    contributorId: row.contributor_id,
    contributorActive: row.contributor_active,
    twoFactorSatisfied,
    totpEnabled: toDate(row.totp_enabled_at) !== null,
  };
  return actor;
}

export async function touchSession(sessionId: string): Promise<void> {
  await getSql()`SELECT app_auth_touch_session(${sessionId}::uuid)`;
}

export async function markTwoFactorVerified(sessionId: string): Promise<void> {
  await getSql()`SELECT app_auth_mark_two_factor(${sessionId}::uuid)`;
}

/**
 * Ends ONE session as a system action — an idle timeout during resolution.
 * No actor check: it runs before an actor exists, and it only ever removes
 * access. See migration 0002 for why this is separate from revocation.
 */
export async function expireSession(sessionId: string, reason: string): Promise<void> {
  await getSql()`SELECT app_expire_session(${sessionId}::uuid, ${reason})`;
}

/**
 * Revokes every live session for a user, as a DECISION by someone.
 *
 * Authorised twice: the policy layer decides here, and the SQL function
 * refuses again if the actor is neither the owner nor the user themselves.
 */
export async function revokeAllSessions(
  actor: Actor,
  userId: string,
  reason: string,
): Promise<number> {
  authorize(actor, actor.kind === 'USER' && actor.userId === userId
    ? 'session.revokeOwn'
    : 'session.revokeAny', { ownerUserId: userId });

  return withActor(actor, async (tx) => {
    const result = await tx.execute(
      drizzleSql`SELECT app_revoke_sessions(${userId}::uuid, ${reason}) AS revoked`,
    );
    const rows = result as unknown as Array<{ revoked: number }>;
    return rows[0]?.revoked ?? 0;
  });
}
