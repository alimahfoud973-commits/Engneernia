import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext, type Transaction } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements, invoices, orders,
  paymentMethods, payments, productContributors, productPrices, products, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from './orders';
import { myPurchases, verificationQueue } from './queries';
import { myInvoices } from '@/finance/invoice-queries';
import { type Actor } from '@/authz/actor';
import { insertProductsWithVersion } from '@/db/testing/product-versions';
import { withFinancialPurge } from '@/db/testing/financial-purge';

/**
 * ===========================================================================
 * "MY ACCOUNT" IS PERSONAL — FOR THE OWNER TOO (Stage 3 admin audit, W12)
 * ===========================================================================
 * Found by signing in as the owner and opening /account: "مشترياتي" listed
 * every customer's purchases, "طلباتي" the platform's latest 25 orders, and
 * "فواتيري" everyone's invoices.
 *
 * Nothing was wrong with row-level security. The policies on `entitlements`,
 * `orders` and `invoices` read `app_is_owner() OR customer_id = actor` — the
 * owner's global reach is deliberate, and the admin screens depend on it. The
 * three `/account` queries simply relied on that policy to mean "mine", which
 * it does for every caller except the owner.
 *
 * The fix names the caller in each query. This file proves both halves: the
 * account is personal for A, B and the owner, and the owner's global reach —
 * the policy itself and the admin queue built on it — is exactly as it was.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '', a: randomUUID(), b: randomUUID(), engineerUser: randomUUID(), contributor: randomUUID(),
  discipline: randomUUID(), p1: randomUUID(), p2: randomUUID(), method: randomUUID(),
};
const SLUG1 = `w12-one-${suffix}`;
const SLUG2 = `w12-two-${suffix}`;

let OWNER_RAW: { actorId: string; actorRole: string };
const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true, totpEnabled: false } as const;
let owner: Actor;
const buyerA: Actor = { ...base, userId: ids.a, role: 'CUSTOMER', contributorId: null, contributorActive: false };
const buyerB: Actor = { ...base, userId: ids.b, role: 'CUSTOMER', contributorId: null, contributorActive: false };
const engineer: Actor = {
  ...base, userId: ids.engineerUser, role: 'CONTRIBUTOR', contributorId: ids.contributor, contributorActive: true,
};

const asOwner = <T,>(fn: (tx: Transaction) => Promise<T>) => withRawActorContext(OWNER_RAW, fn);

/** A completed purchase: order → payment → the owner approves it. */
async function buy(actor: Actor, slug: string): Promise<string> {
  const orderId = await pending(actor, slug);
  const [payment] = await asOwner((tx) => tx.select().from(payments).where(eq(payments.orderId, orderId)));
  await approvePayment(owner, { paymentId: payment!.id });
  return orderId;
}

/** An order with a payment awaiting the owner's decision. */
async function pending(actor: Actor, slug: string): Promise<string> {
  const order = await createOrder(actor, { productSlugs: [slug], buyerCountry: 'SY' });
  await placeOrder(actor, { orderId: order.orderId, paymentMethodId: ids.method });
  return order.orderId;
}

const orderIds = { aBought: '', aPending: '', bBought: '', bPending: '' };

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await asOwner(async (tx) => {
    await tx.insert(users).values([
      { id: ids.a, email: `w12-a+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'المشتري أ', countryCode: 'SY' },
      { id: ids.b, email: `w12-b+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'المشتري ب', countryCode: 'SY' },
      { id: ids.engineerUser, email: `w12-e+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `w12-eng-${suffix}`,
      settlementCode: `W12${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({ id: ids.discipline, slug: `w12-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 93 });
    for (const [id, slug] of [[ids.p1, SLUG1], [ids.p2, SLUG2]] as const) {
      await insertProductsWithVersion(tx, {
        id, slug, titleAr: 'مورد هندسي', disciplineId: ids.discipline,
        fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date(),
      });
      await tx.insert(productContributors).values({ productId: id, contributorId: ids.contributor, shareBp: 10000 });
      await tx.insert(productPrices).values({ productId: id, amountMinor: 1000n, currency: 'USD' });
    }
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `w12-bank-${suffix}`, type: 'MANUAL', displayNameAr: 'تحويل',
      instructionsAr: 'حوّل', accountDetailsAr: 'IBAN TEST', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });

  // A owns P1 and is waiting on P2; B the other way round.
  orderIds.aBought = await buy(buyerA, SLUG1);
  orderIds.bBought = await buy(buyerB, SLUG2);
  orderIds.aPending = await pending(buyerA, SLUG2);
  orderIds.bPending = await pending(buyerB, SLUG1);
}, 120_000);

afterAll(async () => {
  // Superuser + explicit flag: these fixtures became financial history (S5-03).
  await withFinancialPurge(async (tx) => {
    // Invoices are append-only and stay, as in tax.itest.
    const people = sql`(${ids.a}, ${ids.b})`;
    await tx.delete(entitlements).where(sql`customer_id IN ${people}`);
    await tx.delete(orders).where(sql`customer_id IN ${people}`);
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.delete(productPrices).where(sql`product_id IN (${ids.p1}, ${ids.p2})`);
    await tx.delete(productContributors).where(sql`product_id IN (${ids.p1}, ${ids.p2})`);
    await tx.delete(products).where(sql`id IN (${ids.p1}, ${ids.p2})`);
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(sql`id IN (${ids.a}, ${ids.b}, ${ids.engineerUser})`);
  });
  await closeDb();
});

const ownedSlugs = async (actor: Actor) => (await myPurchases(actor)).owned.map((row) => row.productSlug).sort();
const orderIdsOf = async (actor: Actor) => (await myPurchases(actor)).orders.map((row) => row.id).sort();

describe('W12 — buyer A sees only A', () => {
  it('purchases: P1 alone, and the count the page prints is that', async () => {
    const { owned } = await myPurchases(buyerA);
    expect(owned.map((row) => row.productSlug)).toEqual([SLUG1]);
    expect(owned).toHaveLength(1);
  });

  it("orders: A's two, not B's", async () => {
    expect(await orderIdsOf(buyerA)).toEqual([orderIds.aBought, orderIds.aPending].sort());
  });

  it("invoices: A's one", async () => {
    const [invoice] = await asOwner((tx) => tx.select().from(invoices).where(eq(invoices.orderId, orderIds.aBought)));
    expect((await myInvoices(buyerA)).map((row) => row.id)).toEqual([invoice!.id]);
  });
});

describe('W12 — buyer B sees only B', () => {
  it('purchases: P2 alone', async () => {
    expect(await ownedSlugs(buyerB)).toEqual([SLUG2]);
  });

  it("orders: B's two, not A's", async () => {
    expect(await orderIdsOf(buyerB)).toEqual([orderIds.bBought, orderIds.bPending].sort());
  });

  it("invoices: B's one", async () => {
    const [invoice] = await asOwner((tx) => tx.select().from(invoices).where(eq(invoices.orderId, orderIds.bBought)));
    expect((await myInvoices(buyerB)).map((row) => row.id)).toEqual([invoice!.id]);
  });
});

describe("W12 — the owner's /account shows only the owner's own", () => {
  it("none of A's or B's purchases, orders or invoices", async () => {
    const mine = await myPurchases(owner);
    const invoicesListed = await myInvoices(owner);
    const theirs = Object.values(orderIds);

    expect(mine.owned.map((row) => row.productSlug)).not.toContain(SLUG1);
    expect(mine.owned.map((row) => row.productSlug)).not.toContain(SLUG2);
    for (const id of theirs) expect(mine.orders.map((row) => row.id)).not.toContain(id);

    const buyersInvoices = await asOwner((tx) =>
      tx.select({ id: invoices.id }).from(invoices).where(sql`customer_id IN (${ids.a}, ${ids.b})`),
    );
    expect(buyersInvoices).toHaveLength(2);
    for (const { id } of buyersInvoices) expect(invoicesListed.map((row) => row.id)).not.toContain(id);
  });

  it("exactly the owner's own rows — whatever else other suites left in the database", async () => {
    const mine = await myPurchases(owner);
    const own = await asOwner(async (tx) => ({
      entitlements: await tx.select({ id: entitlements.id }).from(entitlements).where(eq(entitlements.customerId, ids.owner)),
      invoices: await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.customerId, ids.owner)),
    }));
    expect(mine.owned.map((row) => row.id).sort()).toEqual(own.entitlements.map((row) => row.id).sort());
    expect((await myInvoices(owner)).map((row) => row.id).sort()).toEqual(own.invoices.map((row) => row.id).sort());

    if (mine.orders.length > 0) {
      const orderOwners = await asOwner((tx) =>
        tx.select({ customerId: orders.customerId }).from(orders)
          .where(inArray(orders.id, mine.orders.map((row) => row.id))),
      );
      for (const row of orderOwners) expect(row.customerId).toBe(ids.owner);
    }
  });
});

describe('W12 — an engineer who bought nothing sees nothing', () => {
  it('selling is not buying', async () => {
    expect(await myPurchases(engineer)).toEqual({ owned: [], orders: [] });
    expect(await myInvoices(engineer)).toEqual([]);
  });
});

describe("W12 — the owner's global reach in admin is untouched", () => {
  it('the row policy still admits the owner to A and B, unfiltered', async () => {
    const seen = await asOwner(async (tx) => ({
      orders: await tx.select({ id: orders.id }).from(orders),
      entitlements: await tx.select({ customerId: entitlements.customerId }).from(entitlements),
    }));
    const seenOrders = seen.orders.map((row) => row.id);
    for (const id of Object.values(orderIds)) expect(seenOrders).toContain(id);
    const holders = new Set(seen.entitlements.map((row) => row.customerId));
    expect(holders.has(ids.a) && holders.has(ids.b)).toBe(true);
  });

  it("the payments queue (/admin/payments) lists A's and B's pending orders", async () => {
    const queue = (await verificationQueue(owner)).map((row) => row.orderId);
    expect(queue).toContain(orderIds.aPending);
    expect(queue).toContain(orderIds.bPending);
  });

  it('and neither buyer can read the other through the policy, unfiltered', async () => {
    const asA = await withRawActorContext({ actorId: ids.a, actorRole: 'CUSTOMER' }, (tx) =>
      tx.select({ customerId: orders.customerId }).from(orders),
    );
    expect(asA.length).toBe(2);
    expect(asA.every((row) => row.customerId === ids.a)).toBe(true);
  });
});
