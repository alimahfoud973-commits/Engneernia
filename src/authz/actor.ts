/**
 * The Actor is the single answer to "who is making this request".
 *
 * It is built once per request from the database session (never from a token
 * claim) and is passed explicitly into every policy check and every repository
 * call. Nothing in the codebase reads the current user from ambient state,
 * which is what makes the authorization matrix test able to enumerate every
 * combination exhaustively.
 */

export type Role = 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'CUSTOMER';

export interface AuthenticatedActor {
  readonly kind: 'USER';
  readonly userId: string;
  readonly role: Role;
  readonly displayName: string;
  readonly locale: string;
  readonly sessionId: string;
  /** The contributor profile id, if this user has one at all. */
  readonly contributorId: string | null;
  /** A contributor whose profile the owner has deactivated keeps no powers. */
  readonly contributorActive: boolean;
  /** True once the second factor has been satisfied for this session. */
  readonly twoFactorSatisfied: boolean;
  /**
   * Whether this ACCOUNT has a second factor armed at all — distinct from
   * whether this SESSION has satisfied it.
   *
   * An owner with no factor enrolled satisfies `twoFactorSatisfied` trivially,
   * because there is nothing to satisfy. That is the state the route gate has
   * to tell apart in order to send them to enrol, and no other field can: it
   * looks identical to a completed challenge.
   */
  readonly totpEnabled: boolean;
}

export interface GuestActor {
  readonly kind: 'GUEST';
}

export type Actor = AuthenticatedActor | GuestActor;

export const GUEST: GuestActor = Object.freeze({ kind: 'GUEST' });

export function isAuthenticated(actor: Actor): actor is AuthenticatedActor {
  return actor.kind === 'USER';
}

/**
 * Has this session finished authenticating?
 *
 * The cookie is issued when the PASSWORD is accepted, not when the login is
 * complete: `TWO_FACTOR_REQUIRED` sets it exactly as `SUCCESS` does. So a
 * session can be real, resolvable, and still owe a factor.
 */
export function isFullyAuthenticated(actor: Actor): actor is AuthenticatedActor {
  return actor.kind === 'USER' && actor.twoFactorSatisfied;
}

/**
 * THE SECOND FACTOR IS PART OF BEING THE OWNER, not a separate check.
 *
 * This compared a role and nothing else, and it is the gate in eight places —
 * settlements, adjustments, product writes, the balance report, the admin
 * console. A session holding the owner's password and no second factor passed
 * every one of them: /admin/finance, /admin/payments, /admin/settlements,
 * /admin/adjustments, all of it, on a password alone. A comment in login.ts
 * claimed a route gate refused such a session; no such gate existed, and
 * `twoFactorSatisfied` was read by no code outside tests.
 *
 * Folding the requirement in here closes all eight at once, and closes the
 * ones nobody has written yet — which is the point: the next `if (isOwner…)`
 * inherits it without its author having to know this happened.
 */
export function isOwner(actor: Actor): boolean {
  return isFullyAuthenticated(actor) && actor.role === 'OWNER';
}

/**
 * The contributor identity to scope queries by — null unless this actor is an
 * ACTIVE contributor. A deactivated contributor can still sign in and see
 * their account, but resolves to no contributor scope.
 */
export function activeContributorId(actor: Actor): string | null {
  // An unfinished login is not an identity to scope anything by.
  if (!isFullyAuthenticated(actor)) return null;
  if (!actor.contributorActive) return null;
  return actor.contributorId;
}

/** The values written into the PostgreSQL session for RLS to read. */
export function actorDatabaseContext(actor: Actor): {
  actorId: string;
  actorRole: string;
  contributorId: string;
} {
  /**
   * A pending session is announced to PostgreSQL as a guest.
   *
   * The policy layer already refuses it, and this is the layer underneath: row
   * policies read these three settings, so a half-authenticated session sees
   * what an anonymous visitor sees even if some future code path skips the
   * policy check entirely. Defence in depth means the layers do not share an
   * assumption — so this one is written from `isFullyAuthenticated`, not from
   * a caller having remembered.
   */
  if (!isFullyAuthenticated(actor)) {
    return { actorId: '', actorRole: 'GUEST', contributorId: '' };
  }
  return {
    actorId: actor.userId,
    actorRole: actor.role,
    contributorId: activeContributorId(actor) ?? '',
  };
}
