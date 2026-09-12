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
}

export interface GuestActor {
  readonly kind: 'GUEST';
}

export type Actor = AuthenticatedActor | GuestActor;

export const GUEST: GuestActor = Object.freeze({ kind: 'GUEST' });

export function isAuthenticated(actor: Actor): actor is AuthenticatedActor {
  return actor.kind === 'USER';
}

export function isOwner(actor: Actor): boolean {
  return actor.kind === 'USER' && actor.role === 'OWNER';
}

/**
 * The contributor identity to scope queries by — null unless this actor is an
 * ACTIVE contributor. A deactivated contributor can still sign in and see
 * their account, but resolves to no contributor scope.
 */
export function activeContributorId(actor: Actor): string | null {
  if (actor.kind !== 'USER') return null;
  if (!actor.contributorActive) return null;
  return actor.contributorId;
}

/** The values written into the PostgreSQL session for RLS to read. */
export function actorDatabaseContext(actor: Actor): {
  actorId: string;
  actorRole: string;
  contributorId: string;
} {
  if (actor.kind !== 'USER') {
    return { actorId: '', actorRole: 'GUEST', contributorId: '' };
  }
  return {
    actorId: actor.userId,
    actorRole: actor.role,
    contributorId: activeContributorId(actor) ?? '',
  };
}
