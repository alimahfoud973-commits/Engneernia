import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  contributors, disciplines, entitlements, productContributors, productRatings,
  products, settings, users,
} from '@/db/schema';
import { GUEST, type Actor } from '@/authz/actor';
import { RuleViolationError, ValidationError } from '@/lib/errors';
import { myRating, rateProduct, ratingSummary } from './ratings';
import { getPublicSettings } from '@/platform/settings';

/**
 * ===========================================================================
 * OPEN-14 — RATINGS, BEHIND A FLAG
 * ===========================================================================
 * The owner's decisions: a score from 1 to 5, no written review, and the public
 * sees an average and a count.
 *
 * The rule that matters is "only a buyer may rate", and it is NOT enforced in
 * the application — it is a WITH CHECK in migration 0045. So these tests ask
 * the database, not the module: every refusal below would still hold if
 * somebody wrote a second code path tomorrow and forgot about it.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '',
  engineerUser: randomUUID(), contributor: randomUUID(), discipline: randomUUID(),
  product: randomUUID(), otherProduct: randomUUID(),
  buyer: randomUUID(), stranger: randomUUID(),
};

let OWNER_RAW: { actorId: string; actorRole: string };
const base = {
  kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's',
  twoFactorSatisfied: true, totpEnabled: false,
} as const;

const buyer: Actor = {
  ...base, userId: ids.buyer, role: 'CUSTOMER', contributorId: null, contributorActive: false,
};
const stranger: Actor = {
  ...base, userId: ids.stranger, role: 'CUSTOMER', contributorId: null, contributorActive: false,
};
const engineer: Actor = {
  ...base, userId: ids.engineerUser, role: 'CONTRIBUTOR',
  contributorId: ids.contributor, contributorActive: true,
};

/** The flag is a row; these tests move it and put it back. */
async function setFlag(enabled: boolean) {
  await withRawActorContext(OWNER_RAW, (tx) =>
    tx.update(settings).set({ value: enabled }).where(eq(settings.key, 'catalog.ratingsEnabled')));
  // `getPublicSettings` is request-cached; these tests run outside a request,
  // so the cache is per-call and the new value is read immediately.
  await getPublicSettings();
}

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.engineerUser, email: `rate-eng+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
      { id: ids.buyer, email: `rate-buyer+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Buyer' },
      { id: ids.stranger, email: `rate-stranger+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Stranger' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `rate-eng-${suffix}`,
      settlementCode: `RAT${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `rate-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'R', sortOrder: 97,
    });
    await tx.insert(products).values([
      { id: ids.product, slug: `rate-prod-${suffix}`, titleAr: 'مورد', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD' },
      { id: ids.otherProduct, slug: `rate-other-${suffix}`, titleAr: 'مورد آخر', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD' },
    ]);
    for (const productId of [ids.product, ids.otherProduct]) {
      await tx.insert(productContributors).values({ productId, contributorId: ids.contributor, shareBp: 10000 });
    }
    // The buyer bought ONE of the two products. That difference is the feature.
    await tx.insert(entitlements).values({ customerId: ids.buyer, productId: ids.product });
  });
}, 60_000);

afterAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.delete(productRatings).where(sql`product_id IN (${ids.product}, ${ids.otherProduct})`);
    await tx.delete(entitlements).where(sql`product_id IN (${ids.product}, ${ids.otherProduct})`);
    await tx.delete(productContributors).where(sql`product_id IN (${ids.product}, ${ids.otherProduct})`);
    await tx.delete(products).where(sql`id IN (${ids.product}, ${ids.otherProduct})`);
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(sql`id IN (${ids.engineerUser}, ${ids.buyer}, ${ids.stranger})`);
    await tx.update(settings).set({ value: false }).where(eq(settings.key, 'catalog.ratingsEnabled'));
  });
  await closeDb();
});

describe('1. the flag is off, which is how the platform ships', () => {
  beforeAll(() => setFlag(false));

  it('refuses a rating even from a genuine buyer', async () => {
    // A feature turned off that still accepts writes is not off — it is
    // invisible, and the rows keep arriving where nobody is looking.
    await expect(rateProduct(buyer, { productId: ids.product, score: 5 }))
      .rejects.toThrow(RuleViolationError);
  });

  it('shows no summary at all', async () => {
    expect(await ratingSummary(GUEST, ids.product)).toBeNull();
  });
});

describe('2. the flag is on', () => {
  beforeAll(() => setFlag(true));

  it('accepts a score from the buyer, and the public sees it', async () => {
    await rateProduct(buyer, { productId: ids.product, score: 4 });

    const summary = await ratingSummary(GUEST, ids.product);
    expect(summary).toEqual({ count: 1, average: 4 });
    expect(await myRating(buyer, ids.product)).toBe(4);
  });

  it('replaces rather than stacks when the buyer changes their mind', async () => {
    await rateProduct(buyer, { productId: ids.product, score: 2 });

    const summary = await ratingSummary(GUEST, ids.product);
    expect(summary).toEqual({ count: 1, average: 2 });
    expect(await myRating(buyer, ids.product)).toBe(2);
  });

  it('REFUSES a rating for a product this person did not buy', async () => {
    /**
     * The rule the whole feature rests on, and it is the database's rather
     * than this module's: the WITH CHECK in migration 0045 requires a live
     * entitlement, so no second code path can forget it.
     */
    await expect(rateProduct(buyer, { productId: ids.otherProduct, score: 5 }))
      .rejects.toThrow(RuleViolationError);

    await expect(rateProduct(stranger, { productId: ids.product, score: 5 }))
      .rejects.toThrow(RuleViolationError);

    // And nothing was written by either attempt.
    expect(await ratingSummary(GUEST, ids.otherProduct)).toEqual({ count: 0, average: null });
    expect((await ratingSummary(GUEST, ids.product))?.count).toBe(1);
  });

  it('refuses a guest outright', async () => {
    await expect(rateProduct(GUEST, { productId: ids.product, score: 5 })).rejects.toThrow();
    expect(await myRating(GUEST, ids.product)).toBeNull();
  });

  it.each([0, 6, -1, 2.5, Number.NaN])('refuses a score of %s', async (score) => {
    await expect(rateProduct(buyer, { productId: ids.product, score }))
      .rejects.toThrow(ValidationError);
  });

  it('shows an average of null, not zero, when nobody has rated', async () => {
    // Zero out of five reads as a terrible product. Absence is not a score.
    expect(await ratingSummary(GUEST, ids.otherProduct)).toEqual({ count: 0, average: null });
  });
});

describe('3. a rating says nothing about who bought the product (OPEN-4)', () => {
  beforeAll(() => setFlag(true));

  it('hides the rows from the public, the engineer, and other customers', async () => {
    /**
     * A visitor who can list a product's ratings can list who bought it. So the
     * aggregate is all anyone gets, and the rows themselves resolve for their
     * author and the owner only — asked of the database with no WHERE clause.
     */
    for (const actor of [GUEST, stranger, engineer]) {
      const rows = await withRawActorContext(
        actor.kind === 'USER'
          ? { actorId: actor.userId, actorRole: actor.role, contributorId: actor.contributorId ?? '' }
          : { actorId: '', actorRole: 'GUEST' },
        (tx) => tx.select().from(productRatings),
      );
      expect(rows, `${actor.kind === 'USER' ? actor.role : 'GUEST'} read a rating row`)
        .toHaveLength(0);
    }
  });

  it('lets the author see their own, and the owner see every one', async () => {
    const mine = await withRawActorContext(
      { actorId: ids.buyer, actorRole: 'CUSTOMER' },
      (tx) => tx.select().from(productRatings),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.customerId).toBe(ids.buyer);

    const all = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(productRatings).where(eq(productRatings.productId, ids.product)));
    expect(all.length).toBeGreaterThan(0);
  });
});

describe('4. a revoked purchase freezes the rating it left behind', () => {
  beforeAll(() => setFlag(true));

  it('refuses an edit once the entitlement is revoked', async () => {
    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(entitlements).set({ revokedAt: new Date(), revokedReason: 'test' })
        .where(eq(entitlements.customerId, ids.buyer)));

    await expect(rateProduct(buyer, { productId: ids.product, score: 5 }))
      .rejects.toThrow(RuleViolationError);

    // The score they left while entitled stands; it is not deleted by revoking.
    expect((await ratingSummary(GUEST, ids.product))?.count).toBe(1);

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(entitlements).set({ revokedAt: null, revokedReason: null })
        .where(eq(entitlements.customerId, ids.buyer)));
  });
});
