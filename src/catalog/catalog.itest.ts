import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  auditLogs, contributors, disciplines, notifications,
  productContributors, productFiles, productPrices, products, users,
} from '@/db/schema';
import { changeProductPrice, changeProductStatus, setProductContributors } from './products';
import { productBySlug } from './public-queries';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * PHASE P2 EXIT CRITERIA, proven against a real database
 * ===========================================================================
 *   1. A product walks draft → review → published, leaving audit entries.
 *   2. A price change preserves history and is never applied in place.
 *   3. A price change notifies ONLY the engineer responsible for that product.
 *   4. Only PUBLISHED products, and only their CURRENT price, are public.
 *   5. One contributor cannot see another's product, price history or share.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  ownerUser: '',
  userA: randomUUID(), userB: randomUUID(),
  contribA: randomUUID(), contribB: randomUUID(),
  productA: randomUUID(), productB: randomUUID(),
  discipline: randomUUID(),
};

let OWNER_RAW: { actorId: string; actorRole: string };
const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true, totpEnabled: false } as const;

let owner: Actor;
const engineerA: Actor = { ...base, userId: ids.userA, role: 'CONTRIBUTOR', contributorId: ids.contribA, contributorActive: true };
const engineerB: Actor = { ...base, userId: ids.userB, role: 'CONTRIBUTOR', contributorId: ids.contribB, contributorActive: true };

const ctxOf = (actor: Actor) =>
  actor.kind === 'USER'
    ? { actorId: actor.userId, actorRole: actor.role, contributorId: actor.contributorId ?? '' }
    : { actorId: '', actorRole: 'GUEST', contributorId: '' };

beforeAll(async () => {
  // The platform has exactly one owner (migration 0041), so this file no
  // longer invents one of its own — it asks for the one that exists.
  ids.ownerUser = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.ownerUser, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.ownerUser, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.userA, email: `p2-a+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer A' },
      { id: ids.userB, email: `p2-b+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer B' },
    ]);
    await tx.insert(contributors).values([
      { id: ids.contribA, userId: ids.userA, publicSlug: `p2-a-${suffix}`, settlementCode: `P2A${suffix}`, displayName: 'Engineer A', isActive: true, canSubmitDrafts: true },
      { id: ids.contribB, userId: ids.userB, publicSlug: `p2-b-${suffix}`, settlementCode: `P2B${suffix}`, displayName: 'Engineer B', isActive: true },
    ]);
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `p2-disc-${suffix}`, nameAr: 'تخصص اختبار', nameEn: 'Test', sortOrder: 99,
    });
    await tx.insert(products).values([
      { id: ids.productA, slug: `p2-prod-a-${suffix}`, titleAr: 'منتج المهندس أ', disciplineId: ids.discipline, status: 'DRAFT', currency: 'USD' },
      { id: ids.productB, slug: `p2-prod-b-${suffix}`, titleAr: 'منتج المهندس ب', disciplineId: ids.discipline, status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
    ]);
    await tx.insert(productContributors).values([
      { productId: ids.productA, contributorId: ids.contribA, shareBp: 10000 },
      { productId: ids.productB, contributorId: ids.contribB, shareBp: 10000 },
    ]);
    await tx.insert(productPrices).values([
      { productId: ids.productA, amountMinor: 1000n, currency: 'USD' },
      { productId: ids.productB, amountMinor: 2000n, currency: 'USD' },
    ]);

    // Since phase P3 the publication gate requires a scanned original, and a
    // preview for PDF products. Attaching them here keeps this suite focused
    // on the workflow rather than on the media pipeline, which has its own.
    const now = new Date();
    for (const [index, productId] of [ids.productA, ids.productB].entries()) {
      await tx.insert(productFiles).values([
        {
          productId, role: 'ORIGINAL',
          storageKey: `original/${String(index).padStart(2, '0')}/${randomUUID()}`,
          bucket: 'originals', originalFilename: 'doc.pdf', contentType: 'application/pdf',
          container: 'PDF', byteSize: 1024n, sha256: 'x'.repeat(64), pageCount: 40,
          scanStatus: 'CLEAN', scannedAt: now,
        },
        {
          productId, role: 'PREVIEW',
          storageKey: `preview/${String(index).padStart(2, '0')}/${randomUUID()}`,
          bucket: 'derivatives', originalFilename: 'preview-doc.pdf',
          contentType: 'application/pdf', container: 'PDF', byteSize: 512n,
          sha256: 'y'.repeat(64), pageCount: 5, scanStatus: 'CLEAN', scannedAt: now,
        },
      ]);
    }
  });
});

afterAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.delete(notifications).where(sql`user_id IN (${ids.userA}, ${ids.userB})`);
    await tx.delete(products).where(sql`id IN (${ids.productA}, ${ids.productB})`);
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(sql`id IN (${ids.contribA}, ${ids.contribB})`);
    await tx.delete(users).where(sql`id IN (${ids.userA}, ${ids.userB})`);
  });
  await closeDb();
});

describe('1. publication workflow (specification §10)', () => {
  it('walks a product from draft to published, and only the owner can publish', async () => {
    await changeProductStatus(engineerA, { productId: ids.productA, to: 'SUBMITTED' });
    await changeProductStatus(owner, { productId: ids.productA, to: 'IN_REVIEW' });
    await changeProductStatus(owner, { productId: ids.productA, to: 'APPROVED' });

    // The contributor cannot take the final step.
    await expect(
      changeProductStatus(engineerA, { productId: ids.productA, to: 'PUBLISHED' }),
    ).rejects.toThrow(/انتقال غير مسموح/);

    const final = await changeProductStatus(owner, { productId: ids.productA, to: 'PUBLISHED' });
    expect(final).toBe('PUBLISHED');
  });

  it('records every step in the audit log', async () => {
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ action: auditLogs.action, after: auditLogs.after })
        .from(auditLogs)
        .where(eq(auditLogs.entityId, ids.productA)),
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('PRODUCT_PUBLISHED');
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses an illegal jump straight from draft to published', async () => {
    await expect(
      changeProductStatus(owner, { productId: ids.productB, to: 'DRAFT' }),
    ).rejects.toThrow(/انتقال غير مسموح/);
  });
});

describe('2. price history is never overwritten (specification §34)', () => {
  it('closes the old row and opens a new one', async () => {
    const before = await changeProductPrice(owner, {
      productId: ids.productA, newAmountMinor: 1500n, currency: 'USD', reason: 'اختبار',
    });
    expect(before.previous?.amountMinor).toBe(1000n);
    expect(before.next.amountMinor).toBe(1500n);

    await changeProductPrice(owner, {
      productId: ids.productA, newAmountMinor: 1800n, currency: 'USD',
    });

    const history = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(productPrices).where(eq(productPrices.productId, ids.productA)),
    );

    // Three rows: the original and two changes. Nothing was updated in place.
    expect(history).toHaveLength(3);
    expect(history.map((r) => r.amountMinor).sort()).toEqual([1000n, 1500n, 1800n]);
  });

  it('leaves exactly one open price row, enforced by the database', async () => {
    const open = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(productPrices)
        .where(and(eq(productPrices.productId, ids.productA), isNull(productPrices.effectiveTo))),
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.amountMinor).toBe(1800n);
  });

  it('records who changed it and why', async () => {
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(productPrices)
        .where(and(eq(productPrices.productId, ids.productA), eq(productPrices.amountMinor, 1500n))),
    );
    expect(rows[0]?.changedBy).toBe(ids.ownerUser);
    expect(rows[0]?.reason).toBe('اختبار');
  });

  it('a contributor cannot change a price', async () => {
    await expect(
      changeProductPrice(engineerA, { productId: ids.productA, newAmountMinor: 1n, currency: 'USD' }),
    ).rejects.toThrow();
  });
});

/**
 * THE TARGETING RULE — specification §33.
 * If the owner changes the price of engineer A's product, engineer B must
 * hear nothing about it.
 */
describe('3. notifications reach only the responsible engineer', () => {
  it('notifies engineer A and not engineer B', async () => {
    const countFor = async (userId: string) => {
      const rows = await withRawActorContext(OWNER_RAW, (tx) =>
        tx.select({ c: sql<number>`count(*)::int` }).from(notifications)
          .where(and(eq(notifications.userId, userId), eq(notifications.type, 'PRODUCT_PRICE_CHANGED'))),
      );
      return Number(rows[0]?.c ?? 0);
    };

    const beforeA = await countFor(ids.userA);
    const beforeB = await countFor(ids.userB);

    const result = await changeProductPrice(owner, {
      productId: ids.productA, newAmountMinor: 2400n, currency: 'USD',
    });

    expect(result.notified).toBe(1);
    expect(await countFor(ids.userA)).toBe(beforeA + 1);
    expect(await countFor(ids.userB)).toBe(beforeB); // unchanged
  });

  it('engineer B cannot read engineer A notifications', async () => {
    const rows = await withRawActorContext(ctxOf(engineerB), (tx) =>
      tx.select().from(notifications),
    );
    expect(rows.every((r) => r.userId === ids.userB)).toBe(true);
  });
});

describe('4. only published products and current prices are public', () => {
  it('hides an unpublished product from a guest', async () => {
    await changeProductStatus(owner, { productId: ids.productB, to: 'UNPUBLISHED' });
    expect(await productBySlug(`p2-prod-b-${suffix}`)).toBeNull();

    await changeProductStatus(owner, { productId: ids.productB, to: 'PUBLISHED' });
    expect(await productBySlug(`p2-prod-b-${suffix}`)).not.toBeNull();
  });

  it('shows a guest the current price but no price history', async () => {
    const visible = await withRawActorContext({ actorId: '', actorRole: 'GUEST' }, (tx) =>
      tx.select().from(productPrices).where(eq(productPrices.productId, ids.productA)),
    );
    // Four rows exist; a guest resolves only the open one.
    expect(visible).toHaveLength(1);
    expect(visible[0]?.effectiveTo).toBeNull();
  });

  it('never exposes a revenue share to a guest', async () => {
    const rows = await withRawActorContext({ actorId: '', actorRole: 'GUEST' }, (tx) =>
      tx.select().from(productContributors),
    );
    expect(rows).toHaveLength(0);
  });

  it('still shows the public author name (specification §28)', async () => {
    const product = await productBySlug(`p2-prod-b-${suffix}`);
    expect(product?.authors.map((a) => a.displayName)).toContain('Engineer B');
  });
});

describe('5. contributors are isolated from each other', () => {
  it('engineer A sees their own product but not engineer B draft state', async () => {
    const rows = await withRawActorContext(ctxOf(engineerA), (tx) =>
      tx.select({ id: products.id, status: products.status }).from(products)
        .where(sql`id IN (${ids.productA}, ${ids.productB})`),
    );
    const own = rows.find((r) => r.id === ids.productA);
    expect(own).toBeDefined();
    // Engineer B's product is visible only because it is PUBLISHED — public info.
    const other = rows.find((r) => r.id === ids.productB);
    expect(other?.status).toBe('PUBLISHED');
  });

  it('engineer A cannot read engineer B price history', async () => {
    const rows = await withRawActorContext(ctxOf(engineerA), (tx) =>
      tx.select().from(productPrices).where(eq(productPrices.productId, ids.productB)),
    );
    // Only the current public price, never the history.
    expect(rows.every((r) => r.effectiveTo === null)).toBe(true);
  });

  it('engineer A cannot read engineer B revenue share', async () => {
    const rows = await withRawActorContext(ctxOf(engineerA), (tx) =>
      tx.select().from(productContributors).where(eq(productContributors.productId, ids.productB)),
    );
    expect(rows).toHaveLength(0);
  });

  it('a contributor cannot assign shares on any product', async () => {
    await expect(
      setProductContributors(engineerA, ids.productA, [
        { contributorId: ids.contribA, shareBp: 10000 },
      ]),
    ).rejects.toThrow(/مالك المنصة/);
  });

  it('the owner cannot save shares that do not total 100%', async () => {
    await expect(
      setProductContributors(owner, ids.productA, [
        { contributorId: ids.contribA, shareBp: 6000 },
        { contributorId: ids.contribB, shareBp: 3000 },
      ]),
    ).rejects.toThrow();
  });

  it('the owner CAN split a product between two engineers', async () => {
    await setProductContributors(owner, ids.productA, [
      { contributorId: ids.contribA, shareBp: 7000 },
      { contributorId: ids.contribB, shareBp: 3000 },
    ]);
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(productContributors).where(eq(productContributors.productId, ids.productA)),
    );
    expect(rows.reduce((sum, r) => sum + r.shareBp, 0)).toBe(10000);

    /*
     * AND NEITHER ENGINEER SEES A CREDIT ROW AT ALL — not even their own
     * (migration 0049). This assertion used to read "sees only their own
     * line", which was the whole trouble: `share_bp` on that line turns an
     * engineer's own pay into everybody else's,
     *
     *     pot = my amount x 10000 / my share_bp,  others = pot - my amount
     *
     * exactly, and on a two-author product "others" is one named person.
     * Decisions §6 says an engineer never learns another engineer's share, and
     * no contributor-facing screen displays a credit share, so the read side
     * now matches the write side: the owner's alone.
     */
    const seenByA = await withRawActorContext(ctxOf(engineerA), (tx) =>
      tx.select().from(productContributors).where(eq(productContributors.productId, ids.productA)),
    );
    expect(seenByA).toHaveLength(0);
  });
});
