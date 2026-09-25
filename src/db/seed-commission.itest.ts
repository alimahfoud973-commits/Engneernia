import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { withRawActorContext, type Transaction } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import { commissionAgreements, contributors, productContributors, productPrices, products, users } from '@/db/schema';
import { productSaleBlockers } from '@/finance/commission-resolver';
import { saveCommissionAgreement } from '@/finance/commissions';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * THE SEEDS SET NO PLATFORM COMMISSION RATE (F2 code review)
 * ===========================================================================
 * Enginora has no commission rate of its own: each engineer's terms are agreed
 * with them (CLAUDE.md rule 9). The F2 version of the seeds broke that in the
 * one place it mattered — seed:scale opened 80% terms for whichever engineer
 * was created FIRST, which on a real database is a real engineer.
 *
 * These run the real scripts against the test database and prove:
 *   - seed:scale writes no terms at all, and never touches another engineer;
 *   - seed:demo's terms belong to its fictitious engineer alone and say, on
 *     the row, that they are demonstration data;
 *   - seed:demo never replaces terms the owner has set;
 *   - what the seeds publish is still sellable (F2).
 *
 * The seeds are idempotent and CI runs them before this suite, so running
 * them again here changes nothing another file relies on; the only rows this
 * file creates of its own (one engineer) are removed afterwards.
 * ===========================================================================
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCALE_COUNT = '40';
const DEMO_LABEL = 'بيانات عرض فقط';

function seed(script: string, ...args: string[]): void {
  execFileSync(process.execPath, ['--experimental-strip-types', `scripts/${script}`, ...args], {
    cwd: ROOT, env: process.env, stdio: 'pipe',
  });
}

const suffix = Date.now();
const ids = { owner: '', realUser: randomUUID(), realEngineer: randomUUID(), demoEngineer: '' };
let OWNER_RAW: { actorId: string; actorRole: string };
let owner: Actor;
const asOwner = <T,>(fn: (tx: Transaction) => Promise<T>) => withRawActorContext(OWNER_RAW, fn);

const agreementCount = async () =>
  (await asOwner((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(commissionAgreements)))[0]!.n;

const demoDefault = async () =>
  (await asOwner((tx) => tx.select().from(commissionAgreements).where(and(
    eq(commissionAgreements.contributorId, ids.demoEngineer),
    isNull(commissionAgreements.productId),
    isNull(commissionAgreements.effectiveTo),
  ))))[0]!;

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = {
    kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true, totpEnabled: false,
    userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false,
  };

  // A "real" engineer, older than every other: exactly who the F2 seed:scale
  // picked. No terms, no products.
  await asOwner(async (tx) => {
    await tx.insert(users).values({
      id: ids.realUser, email: `seed-real+${suffix}@test.local`, passwordHash: 'x',
      role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Real engineer',
    });
    await tx.insert(contributors).values({
      id: ids.realEngineer, userId: ids.realUser, publicSlug: `seed-real-${suffix}`,
      settlementCode: `SEEDREAL${suffix}`, displayName: 'مهندس حقيقي', isActive: true,
      createdAt: new Date('2000-01-01T00:00:00Z'),
    });
  });

  seed('seed-demo.ts');
  const [demo] = await asOwner((tx) => tx.select({ id: contributors.id }).from(contributors)
    .where(eq(contributors.publicSlug, 'demo-engineer')));
  ids.demoEngineer = demo!.id;
}, 120_000);

afterAll(async () => {
  await asOwner(async (tx) => {
    await tx.delete(contributors).where(eq(contributors.id, ids.realEngineer));
    await tx.delete(users).where(eq(users.id, ids.realUser));
  });
  await closeDb();
});

describe('seed:scale', () => {
  it('writes no commission terms at all, and gives nothing to a real engineer', async () => {
    const before = await agreementCount();
    seed('seed-scale.ts', SCALE_COUNT);
    expect(await agreementCount()).toBe(before);

    const [terms, credits] = await asOwner((tx) => Promise.all([
      tx.select().from(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.realEngineer)),
      tx.select().from(productContributors).where(eq(productContributors.contributorId, ids.realEngineer)),
    ]));
    expect(terms).toHaveLength(0);
    expect(credits).toHaveLength(0);
  }, 120_000);

  it('credits its products to the demonstration engineer, once each', async () => {
    const rows = await asOwner((tx) => tx
      .select({ productId: productContributors.productId, contributorId: productContributors.contributorId })
      .from(productContributors)
      .innerJoin(products, eq(products.id, productContributors.productId))
      .where(like(products.slug, 'scale-%')));
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.contributorId))).toEqual(new Set([ids.demoEngineer]));
    expect(new Set(rows.map((r) => r.productId)).size).toBe(rows.length);
  });
});

describe('seed:demo', () => {
  it('its terms belong to its fictitious engineer alone, and say they are demonstration data', async () => {
    const labelled = await asOwner((tx) => tx.select({ contributorId: commissionAgreements.contributorId })
      .from(commissionAgreements)
      .where(like(commissionAgreements.note, `%${DEMO_LABEL}%`)));
    expect(labelled.length).toBeGreaterThan(0);
    expect(new Set(labelled.map((r) => r.contributorId))).toEqual(new Set([ids.demoEngineer]));
  });

  it('never replaces terms the owner has set for that engineer', async () => {
    const original = await demoDefault();
    await saveCommissionAgreement(owner, {
      contributorId: ids.demoEngineer, productId: null,
      agreement: { model: 'PERCENTAGE', engineerBp: 6500, currency: 'USD' }, note: 'set by the owner',
    });
    try {
      seed('seed-demo.ts');
      const current = await demoDefault();
      expect(current.engineerBp).toBe(6500);
      expect(current.note).toBe('set by the owner');
    } finally {
      // Put the demonstration terms back as they were.
      await saveCommissionAgreement(owner, {
        contributorId: ids.demoEngineer, productId: null,
        agreement: { model: 'PERCENTAGE', engineerBp: original.engineerBp!, currency: original.currency },
        note: original.note,
      });
    }
  }, 120_000);
});

describe('what the seeds publish is sellable (F2)', () => {
  it('every seeded paid product has matching terms for every engineer on it', async () => {
    const seeded = await asOwner((tx) => tx
      .select({ id: products.id, amountMinor: productPrices.amountMinor })
      .from(products)
      .innerJoin(productPrices, and(eq(productPrices.productId, products.id), isNull(productPrices.effectiveTo)))
      .where(and(
        eq(products.status, 'PUBLISHED'),
        or(
          like(products.slug, 'demo-%'),
          inArray(products.slug, Array.from({ length: Number(SCALE_COUNT) }, (_, i) => `scale-${i}`)),
        ),
      )));
    expect(seeded.filter((p) => p.amountMinor > 0n).length).toBeGreaterThan(0);

    for (const product of seeded) {
      expect(await asOwner((tx) => productSaleBlockers(tx, product.id))).toEqual([]);
    }
  });
});
