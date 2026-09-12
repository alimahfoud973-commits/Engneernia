import { NotFoundError, UnauthenticatedError } from '@/lib/errors';
import { activeContributorId, isOwner, type Actor } from './actor';
import type { Action, ResourceRef } from './actions';

/**
 * ===========================================================================
 * THE POLICY LAYER (architecture report §F, layer 2)
 * ===========================================================================
 * One function decides every permission question in the application. It is
 * pure: no database, no request context, no I/O. That is what lets the
 * authorization matrix test enumerate every role against every action
 * exhaustively, in milliseconds, on every push.
 *
 * Two rules shape the design:
 *
 *   - DENY BY DEFAULT. The switch is exhaustive over `Action`; adding an
 *     action without a rule is a TypeScript error, not a silent allow.
 *
 *   - UNAUTHORIZED LOOKS LIKE NON-EXISTENT. `authorize` throws NotFound, not
 *     Forbidden, for an authenticated actor. Confirming that another
 *     contributor's settlement exists is itself a disclosure.
 * ===========================================================================
 */

export function can(actor: Actor, action: Action, resource: ResourceRef = {}): boolean {
  // The owner is the platform (specification §2.1). One explicit early exit,
  // rather than repeating an owner branch in twenty rules.
  if (isOwner(actor)) return true;

  const isSelf =
    actor.kind === 'USER' &&
    resource.ownerUserId != null &&
    resource.ownerUserId === actor.userId;

  const contributorId = activeContributorId(actor);

  /**
   * Financial scope: ACTIVE contributors only. A contributor the owner has
   * deactivated keeps no claim on earnings data.
   */
  const isOwnContributorFinancials =
    contributorId != null &&
    resource.contributorId != null &&
    resource.contributorId === contributorId;

  /**
   * Profile ownership: compares the contributor profile ids directly, active
   * or not, so a deactivated contributor can still see their own profile.
   *
   * Both sides must be non-null. Comparing a customer's absent profile to a
   * resource's absent profile would otherwise match null to null and hand
   * every customer a contributor profile they do not have.
   */
  const ownsContributorProfile =
    actor.kind === 'USER' &&
    actor.contributorId != null &&
    resource.contributorId != null &&
    actor.contributorId === resource.contributorId;

  switch (action) {
    // --- console access -------------------------------------------------
    case 'console.admin.access':
      // ADMIN is reserved and unassigned by owner decision (OPEN-3 resolved).
      return false;
    case 'console.contributor.access':
      // Deactivated contributors lose the console, not their account.
      return contributorId !== null;
    case 'console.customer.access':
      return actor.kind === 'USER';

    // --- users -----------------------------------------------------------
    case 'user.read':
      return isSelf;
    case 'user.changeOwnPassword':
      return isSelf;
    case 'user.create':
    case 'user.update':
    case 'user.changeRole':
    case 'user.disable':
      // Owner-only; already returned true above if the actor is the owner.
      return false;

    // --- sessions ---------------------------------------------------------
    case 'session.readOwn':
    case 'session.revokeOwn':
      return isSelf;
    case 'session.revokeAny':
      return false;

    // --- contributors ------------------------------------------------------
    case 'contributor.readPublic':
      // Specification §31: active profiles are public. Inactive ones are
      // visible only to the owner and to the contributor themselves.
      return resource.isPublic === true || ownsContributorProfile;
    case 'contributor.readPrivate':
      return ownsContributorProfile;
    case 'contributor.create':
    case 'contributor.update':
    case 'contributor.setActive':
    case 'contributor.setDraftRights':
      // Specification §32/§46: only the owner creates or authorises a
      // contributor. Registering never grants these.
      return false;

    // --- financial privacy (specification §12, §49) -----------------------
    case 'contributor.readOwnFinancials':
      return isOwnContributorFinancials;
    case 'contributor.readAnyFinancials':
    case 'platform.readRevenue':
      // Platform-wide financial performance is owner-only, without exception.
      return false;

    // --- audit -------------------------------------------------------------
    case 'audit.read':
      return false;
  }
}

/**
 * Enforce a permission.
 *
 * An unauthenticated caller gets 401 — they have somewhere to go: sign in.
 * An authenticated caller who simply may not touch this resource gets 404,
 * so the response is indistinguishable from the resource not existing.
 */
export function authorize(actor: Actor, action: Action, resource: ResourceRef = {}): void {
  if (can(actor, action, resource)) return;

  if (actor.kind === 'GUEST') {
    throw new UnauthenticatedError();
  }
  throw new NotFoundError('Resource not found', { action });
}

/**
 * Narrow a query to what this actor may see.
 *
 * Repositories call this and apply the result as a filter, so the policy
 * decision and the SQL filter can never drift apart. RLS enforces the same
 * rule independently underneath — see the integration tests.
 */
export type ContributorScope =
  | { readonly kind: 'ALL' }
  | { readonly kind: 'SINGLE'; readonly contributorId: string }
  | { readonly kind: 'NONE' };

export function contributorScopeFor(actor: Actor): ContributorScope {
  if (isOwner(actor)) return { kind: 'ALL' };
  const contributorId = activeContributorId(actor);
  return contributorId ? { kind: 'SINGLE', contributorId } : { kind: 'NONE' };
}
