import { describe, it, expect } from 'vitest';
import {
  assertTransition,
  canTransition,
  isPubliclyVisible,
  publishBlockers,
  transitionsFrom,
  type ProductStatus,
} from './publication';
import { RuleViolationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';

const ALL_STATUSES: readonly ProductStatus[] = [
  'DRAFT', 'SUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED',
  'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED',
];

const base = { kind: 'USER', displayName: 'x', locale: 'ar', sessionId: 's', twoFactorSatisfied: true } as const;
const owner: Actor = { ...base, userId: 'u1', role: 'OWNER', contributorId: null, contributorActive: false };
const contributor: Actor = { ...base, userId: 'u2', role: 'CONTRIBUTOR', contributorId: 'c1', contributorActive: true };

const READY = {
  hasContributor: true,
  hasCurrentPrice: true,
  hasOriginalFile: true,
  hasPreview: true,
  requiresPreview: true,
  fileIsServable: true,
};

describe('the documented happy path (specification §10)', () => {
  it('walks draft → submitted → review → approved → published', () => {
    expect(canTransition('DRAFT', 'SUBMITTED', 'CONTRIBUTOR')).toBe(true);
    expect(canTransition('SUBMITTED', 'IN_REVIEW', 'OWNER')).toBe(true);
    expect(canTransition('IN_REVIEW', 'APPROVED', 'OWNER')).toBe(true);
    expect(canTransition('APPROVED', 'PUBLISHED', 'OWNER')).toBe(true);
  });

  it('supports the revision loop', () => {
    expect(canTransition('IN_REVIEW', 'REVISION_REQUESTED', 'OWNER')).toBe(true);
    expect(canTransition('REVISION_REQUESTED', 'SUBMITTED', 'CONTRIBUTOR')).toBe(true);
  });
});

describe('what a contributor may NOT do', () => {
  it('cannot approve, publish, unpublish or archive anything', () => {
    const forbidden: ReadonlyArray<readonly [ProductStatus, ProductStatus]> = [
      ['IN_REVIEW', 'APPROVED'],
      ['APPROVED', 'PUBLISHED'],
      ['PUBLISHED', 'UNPUBLISHED'],
      ['UNPUBLISHED', 'PUBLISHED'],
      ['DRAFT', 'ARCHIVED'],
      ['UNPUBLISHED', 'ARCHIVED'],
    ];
    for (const [from, to] of forbidden) {
      expect(canTransition(from, to, 'CONTRIBUTOR'), `${from} → ${to}`).toBe(false);
    }
  });

  it('cannot publish a draft directly, skipping review', () => {
    expect(canTransition('DRAFT', 'PUBLISHED', 'CONTRIBUTOR')).toBe(false);
    expect(canTransition('DRAFT', 'PUBLISHED', 'OWNER')).toBe(false);
  });

  it('has exactly two moves available anywhere in the workflow', () => {
    const available = ALL_STATUSES.flatMap((status) =>
      transitionsFrom(status, 'CONTRIBUTOR').map((t) => `${status}→${t.to}`),
    );
    expect(available.sort()).toEqual(['DRAFT→SUBMITTED', 'REVISION_REQUESTED→SUBMITTED']);
  });
});

describe('archive is terminal', () => {
  it('offers no transitions to anyone', () => {
    expect(transitionsFrom('ARCHIVED', 'OWNER')).toEqual([]);
    expect(transitionsFrom('ARCHIVED', 'CONTRIBUTOR')).toEqual([]);
    for (const to of ALL_STATUSES) {
      expect(canTransition('ARCHIVED', to, 'OWNER'), `ARCHIVED → ${to}`).toBe(false);
    }
  });
});

describe('public visibility', () => {
  it('only PUBLISHED is public', () => {
    for (const status of ALL_STATUSES) {
      expect(isPubliclyVisible(status)).toBe(status === 'PUBLISHED');
    }
  });
});

describe('publish preconditions', () => {
  it('reports nothing missing when the product is ready', () => {
    expect(publishBlockers(READY)).toEqual([]);
  });

  it('lists every missing piece rather than just the first', () => {
    const blockers = publishBlockers({
      hasContributor: false, hasCurrentPrice: false, hasOriginalFile: false,
      hasPreview: false, requiresPreview: true, fileIsServable: false,
    });
    // Contributor, price, original file, preview — the missing scan is not
    // listed separately because there is no file to have scanned.
    expect(blockers).toHaveLength(4);
  });

  /**
   * The owner's decision: a preview exists for PDF and for nothing else.
   * Requiring one for a DWG or a Revit model would make those unpublishable.
   */
  it('does not demand a preview for a format that has none', () => {
    const dwgProduct = { ...READY, hasPreview: false, requiresPreview: false };
    expect(publishBlockers(dwgProduct)).toEqual([]);
    expect(() => assertTransition('APPROVED', 'PUBLISHED', owner, dwgProduct)).not.toThrow();
  });

  it('still demands a preview for a PDF', () => {
    const pdfProduct = { ...READY, hasPreview: false, requiresPreview: true };
    expect(publishBlockers(pdfProduct)).toContain('لم تُولَّد معاينة الصفحات الخمس');
  });

  it('refuses to publish a file that did not pass scanning', () => {
    const unscanned = { ...READY, fileIsServable: false };
    expect(publishBlockers(unscanned)).toContain('الملف الأصلي لم يجتز فحص البرمجيات الخبيثة');
    expect(() => assertTransition('APPROVED', 'PUBLISHED', owner, unscanned)).toThrow(
      RuleViolationError,
    );
  });

  it('refuses to publish a product with no credited engineer', () => {
    expect(() =>
      assertTransition('APPROVED', 'PUBLISHED', owner, { ...READY, hasContributor: false }),
    ).toThrow(RuleViolationError);
  });

  it('refuses to publish a product with no preview', () => {
    expect(() =>
      assertTransition('APPROVED', 'PUBLISHED', owner, { ...READY, hasPreview: false }),
    ).toThrow(RuleViolationError);
  });

  it('allows publication when everything is in place', () => {
    expect(() => assertTransition('APPROVED', 'PUBLISHED', owner, READY)).not.toThrow();
  });
});

describe('assertTransition enforcement', () => {
  it('throws for a contributor attempting an owner-only move', () => {
    expect(() => assertTransition('APPROVED', 'PUBLISHED', contributor, READY)).toThrow(
      RuleViolationError,
    );
  });

  it('names the moves that WERE available, so the error is actionable', () => {
    try {
      assertTransition('DRAFT', 'PUBLISHED', contributor);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RuleViolationError);
      expect((error as RuleViolationError).details).toMatchObject({
        from: 'DRAFT',
        to: 'PUBLISHED',
        allowed: ['SUBMITTED'],
      });
    }
  });

  it('permits a contributor to submit their own draft', () => {
    expect(() => assertTransition('DRAFT', 'SUBMITTED', contributor)).not.toThrow();
  });
});

describe('the transition table is total', () => {
  it('defines an entry for every status, with no unknown targets', () => {
    for (const status of ALL_STATUSES) {
      const targets = transitionsFrom(status, 'OWNER').map((t) => t.to);
      for (const target of targets) {
        expect(ALL_STATUSES).toContain(target);
      }
    }
  });

  it('never allows a state to transition to itself', () => {
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status, 'OWNER'), `${status} → itself`).toBe(false);
    }
  });
});
