import { describe, it, expect } from 'vitest';
import { ACTIONS, type Action } from './actions';
import { can, authorize, contributorScopeFor } from './policy';
import { GUEST, type Actor } from './actor';
import { NotFoundError, UnauthenticatedError } from '@/lib/errors';

/**
 * ===========================================================================
 * THE AUTHORIZATION MATRIX — phase P1 exit criterion
 * ===========================================================================
 * Every action, against every kind of actor, for both their own resource and
 * someone else's. The expectation table is typed as `Record<Action, ...>`, so
 * adding an action to the catalogue without deciding its permissions is a
 * COMPILE ERROR — the rule cannot be forgotten.
 * ===========================================================================
 */

const OWNER_USER = 'user-owner';
const CUSTOMER_USER = 'user-customer';
const CONTRIB_A_USER = 'user-contributor-a';
const CONTRIB_B_USER = 'user-contributor-b';
const INACTIVE_USER = 'user-contributor-inactive';

const CONTRIB_A = 'contributor-a';
const CONTRIB_B = 'contributor-b';
const CONTRIB_INACTIVE = 'contributor-inactive';

const base = {
  kind: 'USER',
  displayName: 'Test',
  locale: 'ar',
  sessionId: 'session-1',
  twoFactorSatisfied: true, totpEnabled: false,
} as const;

const owner: Actor = { ...base, userId: OWNER_USER, role: 'OWNER', contributorId: null, contributorActive: false };
const customer: Actor = { ...base, userId: CUSTOMER_USER, role: 'CUSTOMER', contributorId: null, contributorActive: false };
const contributorA: Actor = { ...base, userId: CONTRIB_A_USER, role: 'CONTRIBUTOR', contributorId: CONTRIB_A, contributorActive: true };
const contributorB: Actor = { ...base, userId: CONTRIB_B_USER, role: 'CONTRIBUTOR', contributorId: CONTRIB_B, contributorActive: true };
const inactiveContributor: Actor = { ...base, userId: INACTIVE_USER, role: 'CONTRIBUTOR', contributorId: CONTRIB_INACTIVE, contributorActive: false };

interface Expectation {
  readonly owner: boolean;
  /** Acting on a resource belonging to themselves. */
  readonly customerOwn: boolean;
  readonly customerOther: boolean;
  readonly contributorOwn: boolean;
  /** Contributor A acting on Contributor B's resource — the privacy rule. */
  readonly contributorOther: boolean;
  /** A contributor the owner has deactivated, on their own resource. */
  readonly inactiveOwn: boolean;
  readonly guest: boolean;
}

const DENY_ALL_BUT_OWNER: Expectation = {
  owner: true,
  customerOwn: false,
  customerOther: false,
  contributorOwn: false,
  contributorOther: false,
  inactiveOwn: false,
  guest: false,
};

const SELF_ONLY: Expectation = {
  owner: true,
  customerOwn: true,
  customerOther: false,
  contributorOwn: true,
  contributorOther: false,
  inactiveOwn: true,
  guest: false,
};

const EXPECTATIONS: Record<Action, Expectation> = {
  // --- console access ---
  'console.admin.access': { ...DENY_ALL_BUT_OWNER },
  'console.contributor.access': {
    owner: true,
    customerOwn: false,
    customerOther: false,
    contributorOwn: true,
    contributorOther: true, // access to the console, not to another's data
    inactiveOwn: false, // deactivated contributors lose console access
    guest: false,
  },
  'console.customer.access': {
    owner: true,
    customerOwn: true,
    customerOther: true,
    contributorOwn: true,
    contributorOther: true,
    inactiveOwn: true,
    guest: false,
  },

  // --- users ---
  'user.read': { ...SELF_ONLY },
  'user.changeOwnPassword': { ...SELF_ONLY },
  'user.create': { ...DENY_ALL_BUT_OWNER },
  'user.update': { ...DENY_ALL_BUT_OWNER },
  'user.changeRole': { ...DENY_ALL_BUT_OWNER },
  'user.disable': { ...DENY_ALL_BUT_OWNER },

  // --- sessions ---
  'session.readOwn': { ...SELF_ONLY },
  'session.revokeOwn': { ...SELF_ONLY },
  'session.revokeAny': { ...DENY_ALL_BUT_OWNER },

  // --- contributors ---
  'contributor.readPublic': {
    owner: true,
    customerOwn: false, // a non-public profile, acting as a plain user
    customerOther: false,
    contributorOwn: true,
    contributorOther: false,
    inactiveOwn: true, // via the owning user id, not the contributor scope
    guest: false,
  },
  'contributor.readPrivate': {
    owner: true,
    customerOwn: false,
    customerOther: false,
    contributorOwn: true,
    contributorOther: false,
    inactiveOwn: true,
    guest: false,
  },
  'contributor.create': { ...DENY_ALL_BUT_OWNER },
  'contributor.update': { ...DENY_ALL_BUT_OWNER },
  'contributor.setActive': { ...DENY_ALL_BUT_OWNER },
  'contributor.setDraftRights': { ...DENY_ALL_BUT_OWNER },

  // --- financial privacy (specification §12, §49) ---
  'contributor.readOwnFinancials': {
    owner: true,
    customerOwn: false,
    customerOther: false,
    contributorOwn: true,
    contributorOther: false, // THE rule: engineers never see each other
    inactiveOwn: false,
    guest: false,
  },
  'contributor.readAnyFinancials': { ...DENY_ALL_BUT_OWNER },
  'platform.readRevenue': { ...DENY_ALL_BUT_OWNER },

  // --- audit ---
  'audit.read': { ...DENY_ALL_BUT_OWNER },
};

/** Resource belonging to the actor themselves. */
function ownResource(actor: Actor) {
  if (actor.kind !== 'USER') return {};
  return {
    ownerUserId: actor.userId,
    contributorId: actor.contributorId,
    isPublic: false,
  };
}

/** Resource belonging to contributor B / another user. */
const OTHER_RESOURCE = {
  ownerUserId: CONTRIB_B_USER,
  contributorId: CONTRIB_B,
  isPublic: false,
};

describe('authorization matrix', () => {
  it('covers every declared action', () => {
    expect(Object.keys(EXPECTATIONS).sort()).toEqual([...ACTIONS].sort());
  });

  for (const action of ACTIONS) {
    const expected = EXPECTATIONS[action];

    describe(action, () => {
      it(`owner: ${expected.owner}`, () => {
        expect(can(owner, action, ownResource(owner))).toBe(expected.owner);
      });

      it(`customer on own: ${expected.customerOwn}`, () => {
        expect(can(customer, action, ownResource(customer))).toBe(expected.customerOwn);
      });

      it(`customer on another's: ${expected.customerOther}`, () => {
        expect(can(customer, action, OTHER_RESOURCE)).toBe(expected.customerOther);
      });

      it(`contributor on own: ${expected.contributorOwn}`, () => {
        expect(can(contributorA, action, ownResource(contributorA))).toBe(expected.contributorOwn);
      });

      it(`contributor on another contributor's: ${expected.contributorOther}`, () => {
        expect(can(contributorA, action, OTHER_RESOURCE)).toBe(expected.contributorOther);
      });

      it(`deactivated contributor on own: ${expected.inactiveOwn}`, () => {
        expect(can(inactiveContributor, action, ownResource(inactiveContributor))).toBe(
          expected.inactiveOwn,
        );
      });

      it(`guest: ${expected.guest}`, () => {
        expect(can(GUEST, action, OTHER_RESOURCE)).toBe(expected.guest);
      });
    });
  }
});

/**
 * Specification §12 in its own words: a Civil engineer must not see a
 * Mechanical engineer's figures. Stated as its own test so that a future
 * change to the generic matrix cannot quietly weaken it.
 */
describe('§12 contributor financial privacy', () => {
  const financialActions: readonly Action[] = [
    'contributor.readOwnFinancials',
    'contributor.readAnyFinancials',
    'contributor.readPrivate',
    'platform.readRevenue',
  ];

  it('no contributor can reach another contributor by any financial action', () => {
    for (const action of financialActions) {
      expect(can(contributorA, action, { contributorId: CONTRIB_B, ownerUserId: CONTRIB_B_USER })).toBe(false);
      expect(can(contributorB, action, { contributorId: CONTRIB_A, ownerUserId: CONTRIB_A_USER })).toBe(false);
    }
  });

  it('no contributor can read platform-wide revenue', () => {
    for (const actor of [contributorA, contributorB, inactiveContributor, customer, GUEST]) {
      expect(can(actor, 'platform.readRevenue')).toBe(false);
    }
  });

  it('a contributor CAN read their own figures', () => {
    expect(can(contributorA, 'contributor.readOwnFinancials', { contributorId: CONTRIB_A })).toBe(true);
  });

  it('the owner can read everything', () => {
    for (const action of ACTIONS) {
      expect(can(owner, action, OTHER_RESOURCE)).toBe(true);
    }
  });
});

describe('authorize() error shape', () => {
  it('throws 401 for a guest — they have somewhere to go', () => {
    expect(() => authorize(GUEST, 'audit.read')).toThrow(UnauthenticatedError);
  });

  it('throws 404, never 403, for an authenticated actor', () => {
    // A 403 would confirm the resource exists. See CLAUDE.md rule 5.
    expect(() => authorize(contributorA, 'audit.read')).toThrow(NotFoundError);
    expect(() =>
      authorize(contributorA, 'contributor.readOwnFinancials', { contributorId: CONTRIB_B }),
    ).toThrow(NotFoundError);
  });

  it('does not throw when permitted', () => {
    expect(() => authorize(owner, 'audit.read')).not.toThrow();
    expect(() =>
      authorize(contributorA, 'contributor.readOwnFinancials', { contributorId: CONTRIB_A }),
    ).not.toThrow();
  });
});

describe('query scoping', () => {
  it('gives the owner an unscoped view', () => {
    expect(contributorScopeFor(owner)).toEqual({ kind: 'ALL' });
  });

  it('pins a contributor to their own id', () => {
    expect(contributorScopeFor(contributorA)).toEqual({ kind: 'SINGLE', contributorId: CONTRIB_A });
  });

  it('gives customers, guests and deactivated contributors nothing', () => {
    expect(contributorScopeFor(customer)).toEqual({ kind: 'NONE' });
    expect(contributorScopeFor(GUEST)).toEqual({ kind: 'NONE' });
    expect(contributorScopeFor(inactiveContributor)).toEqual({ kind: 'NONE' });
  });
});

/**
 * ===========================================================================
 * A SESSION THAT HAS NOT ANSWERED ITS SECOND FACTOR AUTHORISES NOTHING
 * ===========================================================================
 * The login flow issues the session cookie as soon as the password is
 * accepted — the `TWO_FACTOR_REQUIRED` branch sets it exactly like `SUCCESS`
 * does — and `twoFactorSatisfied` is false until the challenge is answered.
 *
 * Nothing read that flag. `isOwner()` compares a role and nothing else, so
 * `requireOwner` admitted a session that had shown a password and no more,
 * and a comment in login.ts said "the route gate refuses it" about a gate
 * that was never written. Password alone reached /admin/finance,
 * /admin/settlements, /admin/payments and /admin/adjustments — the account
 * that approves payments, pays engineers and writes ledger corrections.
 *
 * Enumerated here rather than asserted once, because the property has to hold
 * for EVERY action: a rule added later must not be able to forget it.
 * ===========================================================================
 */
describe('a pending second factor', () => {
  const pendingOwner: Actor = {
    ...base,
    twoFactorSatisfied: false, totpEnabled: false,
    userId: OWNER_USER,
    role: 'OWNER',
    contributorId: null,
    contributorActive: false,
  };
  const pendingContributor: Actor = {
    ...base,
    twoFactorSatisfied: false, totpEnabled: false,
    userId: CONTRIB_A_USER,
    role: 'CONTRIBUTOR',
    contributorId: CONTRIB_A,
    contributorActive: true,
  };

  it.each(ACTIONS)('refuses %s to an owner who has not completed it', (action) => {
    expect(can(pendingOwner, action, { ownerUserId: OWNER_USER, contributorId: CONTRIB_A, isPublic: true }))
      .toBe(false);
  });

  it.each(ACTIONS)('refuses %s to a contributor who has not completed it', (action) => {
    expect(can(pendingContributor, action, { ownerUserId: CONTRIB_A_USER, contributorId: CONTRIB_A, isPublic: true }))
      .toBe(false);
  });

  it('scopes such a session to nothing, so no query can widen it', () => {
    expect(contributorScopeFor(pendingOwner)).toEqual({ kind: 'NONE' });
  });
});
