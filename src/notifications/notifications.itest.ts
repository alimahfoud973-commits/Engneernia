import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements, notifications,
  orders, paymentMethods, payments, productContributors, productPrices, products, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { markNotificationsRead, myNotifications, unreadNotificationCount } from './queries';
import { renderNotification } from './render';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * THE ENGINEER IS TOLD ABOUT EVERY SALE (owner decision)
 * ===========================================================================
 * "عند الشراء اريد فقط ان تصل رسالة أو اشعار إلى المهندس تخبره بكل عملية الشراء"
 *
 * Two co-authors on one product, so the test can check the thing that is easy
 * to get wrong: each is told THEIR OWN share and never the other's.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '', customer: randomUUID(),
  userA: randomUUID(), contribA: randomUUID(),
  userB: randomUUID(), contribB: randomUUID(),
  discipline: randomUUID(), product: randomUUID(), method: randomUUID(),
};
const slug = `notif-prod-${suffix}`;

let OWNER_RAW: { actorId: string; actorRole: string };
const base = {
  kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true,
} as const;

let owner: Actor;
const customer: Actor = {
  ...base, userId: ids.customer, role: 'CUSTOMER', contributorId: null, contributorActive: false,
};
const engineerA: Actor = {
  ...base, userId: ids.userA, role: 'CONTRIBUTOR',
  contributorId: ids.contribA, contributorActive: true,
};
const engineerB: Actor = {
  ...base, userId: ids.userB, role: 'CONTRIBUTOR',
  contributorId: ids.contribB, contributorActive: true,
};

const PRICE = 2000n;  // 80% engineer = 1600, split 75/25 between two authors

beforeAll(async () => {
  // The platform has exactly one owner (migration 0041), so this file no
  // longer invents one of its own — it asks for the one that exists.
  ids.owner = await ensureTestOwner({ displayName: 'Owner' });
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.customer, email: `nf-cust+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Customer', countryCode: 'SY' },
      { id: ids.userA, email: `nf-a+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Author A' },
      { id: ids.userB, email: `nf-b+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Author B' },
    ]);
    await tx.insert(contributors).values([
      { id: ids.contribA, userId: ids.userA, publicSlug: `nf-a-${suffix}`, settlementCode: `NFA${suffix}`, displayName: 'Author A', isActive: true },
      { id: ids.contribB, userId: ids.userB, publicSlug: `nf-b-${suffix}`, settlementCode: `NFB${suffix}`, displayName: 'Author B', isActive: true },
    ]);
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `nf-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 92,
    });
    await tx.insert(products).values({
      id: ids.product, slug, titleAr: 'مخطط مشترك', disciplineId: ids.discipline,
      fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date(),
    });
    // Two authors, an uneven split.
    await tx.insert(productContributors).values([
      { productId: ids.product, contributorId: ids.contribA, shareBp: 7500 },
      { productId: ids.product, contributorId: ids.contribB, shareBp: 2500 },
    ]);
    await tx.insert(productPrices).values({
      productId: ids.product, amountMinor: PRICE, currency: 'USD',
    });
    await tx.insert(commissionAgreements).values([
      { contributorId: ids.contribA, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner },
      { contributorId: ids.contribB, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner },
    ]);
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `nf-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل بنكي', instructionsAr: 'حوّل', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });
}, 120_000);

afterAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.execute(sql`DELETE FROM notifications WHERE user_id IN
      (${ids.customer}, ${ids.userA}, ${ids.userB})`);
    await tx.delete(entitlements).where(eq(entitlements.customerId, ids.customer));
    await tx.delete(orders).where(eq(orders.customerId, ids.customer));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.execute(sql`DELETE FROM commission_agreements WHERE contributor_id IN
      (${ids.contribA}, ${ids.contribB})`);
    await tx.execute(sql`DELETE FROM product_contributors WHERE product_id = ${ids.product}`);
    await tx.delete(products).where(eq(products.id, ids.product));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.execute(sql`DELETE FROM contributors WHERE id IN (${ids.contribA}, ${ids.contribB})`);
    await tx.execute(sql`DELETE FROM users WHERE id IN
      (${ids.customer}, ${ids.userA}, ${ids.userB})`);
  });
  await closeDb();
}, 60_000);

describe('a completed sale tells each engineer their own share', () => {
  beforeAll(async () => {
    const order = await createOrder(customer, { productSlugs: [slug] });
    await placeOrder(customer, { orderId: order.orderId, paymentMethodId: ids.method });
    const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)),
    );
    await approvePayment(owner, { paymentId: payment!.id });
  });

  it('author A is told 12.00 — 75% of the engineer side', async () => {
    const rows = await myNotifications(engineerA);
    const sale = rows.find((row) => row.type === 'PRODUCT_SOLD');

    expect(sale).toBeDefined();
    expect(sale!.payload.engineerMinor).toBe('1200');
    expect(sale!.payload.productTitle).toBe('مخطط مشترك');

    const message = renderNotification(sale!.type, sale!.payload);
    expect(message.detail).toContain('12.00 USD');
  });

  it('author B is told 4.00 — and never sees A\'s figure', async () => {
    const rows = await myNotifications(engineerB);
    const sale = rows.find((row) => row.type === 'PRODUCT_SOLD');

    expect(sale!.payload.engineerMinor).toBe('400');

    // The whole list under B's actor, checked for any trace of A's number.
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain('1200');
  });

  it('the notification names no buyer (OPEN-4)', async () => {
    const rows = await myNotifications(engineerA);
    const sale = rows.find((row) => row.type === 'PRODUCT_SOLD');
    const keys = Object.keys(sale!.payload);

    expect(keys).toEqual(
      expect.arrayContaining(['productTitle', 'currency', 'grossMinor', 'engineerMinor']),
    );
    for (const forbidden of ['customerId', 'customerName', 'customerEmail', 'orderId', 'orderNumber']) {
      expect(keys, `payload leaks ${forbidden}`).not.toContain(forbidden);
    }
    expect(JSON.stringify(sale!.payload)).not.toContain(ids.customer);
  });

  it('the buyer gets their own message, not the engineer\'s', async () => {
    const rows = await myNotifications(customer);
    expect(rows.some((row) => row.type === 'ORDER_PAID')).toBe(true);
    // PRODUCT_SOLD is the engineer's message and must not reach the buyer.
    expect(rows.some((row) => row.type === 'PRODUCT_SOLD')).toBe(false);
  });

  it('one engineer cannot read another\'s notifications', async () => {
    // Raw SQL with NO WHERE clause, under B's context.
    const rows = await withRawActorContext(
      { actorId: ids.userB, actorRole: 'CONTRIBUTOR', contributorId: ids.contribB },
      (tx) => tx.execute(sql`SELECT user_id FROM notifications`),
    ) as unknown as Array<{ user_id: string }>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.user_id === ids.userB)).toBe(true);
  });

  it('marking read is scoped to the reader', async () => {
    const before = await unreadNotificationCount(engineerA);
    expect(before).toBeGreaterThan(0);

    // A tries to mark one of B's notifications read.
    const bRows = await myNotifications(engineerB, { unreadOnly: true });
    const changed = await markNotificationsRead(engineerA, { notificationId: bRows[0]!.id });
    expect(changed).toBe(0);
    expect(await unreadNotificationCount(engineerB)).toBe(bRows.length);

    // A marks their own.
    expect(await markNotificationsRead(engineerA)).toBe(before);
    expect(await unreadNotificationCount(engineerA)).toBe(0);
  });

  it('a contributor cannot write themselves a notification', async () => {
    await expect(
      withRawActorContext(
        { actorId: ids.userA, actorRole: 'CONTRIBUTOR', contributorId: ids.contribA },
        (tx) =>
          tx.insert(notifications).values({
            userId: ids.userA, type: 'SETTLEMENT_PAID', payload: {},
          }),
      ),
    ).rejects.toThrow();
  });
});
