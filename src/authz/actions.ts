/**
 * Every privileged action in the system, named once.
 *
 * The authorization matrix test enumerates this list against every role, so a
 * new action that nobody wrote a rule for fails CI rather than silently
 * defaulting to allowed or denied in a way nobody reviewed.
 */
export const ACTIONS = [
  // Console access — the route gate (report §F, layer 1)
  'console.admin.access',
  'console.contributor.access',
  'console.customer.access',

  // Users
  'user.read',
  'user.create',
  'user.update',
  'user.changeRole',
  'user.disable',
  'user.changeOwnPassword',

  // Sessions
  'session.readOwn',
  'session.revokeOwn',
  'session.revokeAny',

  // Contributors
  // OPEN-14. The capability is "may submit a rating at all"; WHICH product a
  // person may rate is a resource question, answered by the entitlement in the
  // row policy rather than by a role here.
  'product.rate',
  'contributor.readPublic',
  'contributor.readPrivate',
  'contributor.create',
  'contributor.update',
  'contributor.setActive',
  'contributor.setDraftRights',

  // Financial privacy tier (specification §12, §49) — enforced from phase P6,
  // declared here so the matrix covers it from the start.
  'contributor.readOwnFinancials',
  'contributor.readAnyFinancials',
  'platform.readRevenue',

  // Audit
  'audit.read',
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * What an action is being performed ON. `ownerUserId` and `contributorId`
 * identify who the resource belongs to; a policy compares them to the actor.
 */
export interface ResourceRef {
  readonly ownerUserId?: string | null;
  readonly contributorId?: string | null;
  /** Public-facing resources (e.g. an active contributor profile). */
  readonly isPublic?: boolean;
}
