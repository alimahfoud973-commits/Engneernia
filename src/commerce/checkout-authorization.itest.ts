import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { withRawActorContext, type Transaction } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  auditLogs, commissionAgreements, contributors, disciplines, entitlements, invoices, ledgerTransactions,
  orderEvents, orders, paymentMethods, paymentProofs, payments, productContributors, productPrices, products, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder, rejectPayment } from './orders';
import { submitPaymentProof } from './proofs';
import { checkoutView } from './queries';
import { getStorage } from '@/media/storage';
import { NotFoundError, RuleViolationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';
import { insertProductsWithVersion } from '@/db/testing/product-versions';

/**
 * ===========================================================================
 * THE OWNER READS AN ORDER; ONLY ITS CUSTOMER PAYS FOR IT (Stage 3, W14)
 * ===========================================================================
 * Found in the W13/W14 audit, on a production build:
 *
 *   - `placeOrder` named no customer. The policies on `orders` and `payments`
 *     admit the owner to every row, so the owner, opening a customer's
 *     checkout, could choose a payment method for them: a payment row was
 *     written and the customer's order moved to AWAITING_PAYMENT.
 *   - `placeOrder` wrote the payment before looking at the order's status, so
 *     a COMPLETED order could gain a fresh payment.
 *   - The receipt upload checked ownership before storage through the same
 *     policies, so the owner's upload was STORED and only then refused — an
 *     orphan object in the private bucket.
 *
 * Owner decision: reading stays (the specification gives the owner "View all
 * orders"); acting as the customer does not. Every refusal here is proven to
 * write nothing: no payment, no order move, no event, no receipt, no object.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '', a: randomUUID(), b: randomUUID(), engineerUser: randomUUID(), contributor: randomUUID(),
  discipline: randomUUID(), p1: randomUUID(), p2: randomUUID(), p3: randomUUID(), p4: randomUUID(),
  bank: randomUUID(), other: randomUUID(),
};
const slug = (p: string) => `w14-${p}-${suffix}`;

let OWNER_RAW: { actorId: string; actorRole: string };
const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true, totpEnabled: false } as const;
let owner: Actor;
const customer = (id: string): Actor => ({ ...base, userId: id, role: 'CUSTOMER', contributorId: null, contributorActive: false });
const buyerA = customer(ids.a);
const buyerB = customer(ids.b);
const asOwner = <T,>(fn: (tx: Transaction) => Promise<T>) => withRawActorContext(OWNER_RAW, fn);

/** A real, minimal PNG: the proof path inspects the bytes, not the name. */
function png(): Uint8Array {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...new Array(12).fill(200)])));
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** Everything a checkout step can write, for one order. */
async function footprint(orderId: string) {
  return asOwner(async (tx) => {
    const n = async (q: Promise<Array<{ n: number }>>) => (await q)[0]!.n;
    const count = sql<number>`count(*)::int`;
    const [order] = await tx.select({ status: orders.status, placedAt: orders.placedAt }).from(orders).where(eq(orders.id, orderId));
    const pays = await tx.select({ status: payments.status }).from(payments).where(eq(payments.orderId, orderId));
    return {
      order: order!.status,
      placedAt: order!.placedAt ? 'set' : 'unset',
      payments: pays.map((p) => p.status).sort().join(','),
      events: await n(tx.select({ n: count }).from(orderEvents).where(eq(orderEvents.orderId, orderId))),
      proofs: await n(tx.select({ n: count }).from(paymentProofs)
        .innerJoin(payments, eq(payments.id, paymentProofs.paymentId)).where(eq(payments.orderId, orderId))),
      invoices: await n(tx.select({ n: count }).from(invoices).where(eq(invoices.orderId, orderId))),
      entitlementsA: await n(tx.select({ n: count }).from(entitlements).where(eq(entitlements.customerId, ids.a))),
      ledger: await n(tx.select({ n: count }).from(ledgerTransactions)),
      audit: await n(tx.select({ n: count }).from(auditLogs)),
    };
  });
}

const paymentOf = async (orderId: string) => {
  const [row] = await asOwner((tx) => tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId)));
  return row!.id;
};
const upload = (actor: Actor, paymentId: string) =>
  submitPaymentProof(actor, { paymentId, filename: 'receipt.png', body: png(), referenceNote: 'W14' });

/** Counts objects written to storage — the orphan the owner's upload used to leave. */
const put = vi.spyOn(getStorage(), 'put');
afterEach(() => put.mockClear());

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await asOwner(async (tx) => {
    await tx.insert(users).values([
      { id: ids.a, email: `w14-a+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Buyer A', countryCode: 'SY' },
      { id: ids.b, email: `w14-b+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Buyer B', countryCode: 'SY' },
      { id: ids.engineerUser, email: `w14-e+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `w14-eng-${suffix}`,
      settlementCode: `W14${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({ id: ids.discipline, slug: `w14-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 91 });
    const all = [ids.p1, ids.p2, ids.p3, ids.p4];
    await insertProductsWithVersion(tx, all.map((id, i) => ({
      id, slug: slug(`p${i + 1}`), titleAr: 'مورد هندسي', disciplineId: ids.discipline,
      fileType: 'PDF' as const, status: 'PUBLISHED' as const, currency: 'USD', publishedAt: new Date(),
    })));
    await tx.insert(productContributors).values(all.map((productId) => ({ productId, contributorId: ids.contributor, shareBp: 10000 })));
    await tx.insert(productPrices).values(all.map((productId) => ({ productId, amountMinor: 1200n, currency: 'USD' })));
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
    const manual = { type: 'MANUAL' as const, instructionsAr: 'حوّل', accountDetailsAr: 'IBAN TEST', countries: [], currencies: ['USD'], isActive: true };
    await tx.insert(paymentMethods).values([
      { id: ids.bank, code: `w14-bank-${suffix}`, displayNameAr: 'تحويل بنكي', requiresProof: true, sortOrder: 1, ...manual },
      { id: ids.other, code: `w14-other-${suffix}`, displayNameAr: 'طريقة أخرى', requiresProof: false, sortOrder: 2, ...manual },
    ]);
  });
}, 120_000);

afterAll(async () => {
  put.mockRestore();
  await asOwner(async (tx) => {
    const all = [ids.p1, ids.p2, ids.p3, ids.p4];
    // Invoices are append-only and stay, as in tax.itest.
    await tx.delete(entitlements).where(inArray(entitlements.productId, all));
    await tx.delete(orders).where(inArray(orders.customerId, [ids.a, ids.b]));
    await tx.delete(paymentMethods).where(inArray(paymentMethods.id, [ids.bank, ids.other]));
    await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.delete(productPrices).where(inArray(productPrices.productId, all));
    await tx.delete(productContributors).where(inArray(productContributors.productId, all));
    await tx.delete(products).where(inArray(products.id, all));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(inArray(users.id, [ids.a, ids.b, ids.engineerUser]));
  });
  await closeDb();
}, 60_000);

describe("W14 — only the order's customer chooses how to pay", () => {
  let aDraft = '';

  it("the owner can still READ A's checkout (View all orders is unchanged)", async () => {
    aDraft = (await createOrder(buyerA, { productSlugs: [slug('p1')], buyerCountry: 'SY' })).orderId;
    const view = await checkoutView(owner, aDraft);
    expect(view?.order.id).toBe(aDraft);
  });

  it("the owner choosing a method on A's DRAFT order is refused, and nothing is written", async () => {
    const before = await footprint(aDraft);
    const refusal = placeOrder(owner, { orderId: aDraft, paymentMethodId: ids.bank });
    await expect(refusal).rejects.toBeInstanceOf(RuleViolationError);
    await expect(refusal).rejects.toThrow('إتمام الدفع خطوة صاحب الطلب وحده');
    expect(await footprint(aDraft)).toEqual(before);
    expect(before).toMatchObject({ order: 'DRAFT', placedAt: 'unset', payments: '' });
  });

  it("buyer B on A's order: not found, and nothing is written", async () => {
    const before = await footprint(aDraft);
    await expect(placeOrder(buyerB, { orderId: aDraft, paymentMethodId: ids.bank })).rejects.toBeInstanceOf(NotFoundError);
    expect(await footprint(aDraft)).toEqual(before);
  });

  it('buyer A on A\'s own DRAFT order: allowed as before — AWAITING_PAYMENT with one payment', async () => {
    await placeOrder(buyerA, { orderId: aDraft, paymentMethodId: ids.bank });
    expect(await footprint(aDraft)).toMatchObject({ order: 'AWAITING_PAYMENT', placedAt: 'set', payments: 'AWAITING_PROOF' });
  });

  it('buyer A choosing the same method again while AWAITING_PAYMENT: unchanged behaviour, no second payment', async () => {
    const before = await footprint(aDraft);
    await placeOrder(buyerA, { orderId: aDraft, paymentMethodId: ids.bank });
    expect(await footprint(aDraft)).toEqual(before);
  });

  it("the owner is refused on A's AWAITING_PAYMENT order too", async () => {
    const before = await footprint(aDraft);
    await expect(placeOrder(owner, { orderId: aDraft, paymentMethodId: ids.other })).rejects.toBeInstanceOf(RuleViolationError);
    expect(await footprint(aDraft)).toEqual(before);
  });
});

describe('W14 — a payment starts only where the order still waits for one', () => {
  let completed = '';

  it('a COMPLETED order gains no new payment, even from its own customer with another method', async () => {
    completed = (await createOrder(buyerA, { productSlugs: [slug('p2')], buyerCountry: 'SY' })).orderId;
    await placeOrder(buyerA, { orderId: completed, paymentMethodId: ids.other });
    await approvePayment(owner, { paymentId: await paymentOf(completed), providerRef: `W14-${suffix}` });
    const before = await footprint(completed);
    expect(before).toMatchObject({ order: 'COMPLETED', payments: 'APPROVED' });

    await expect(placeOrder(buyerA, { orderId: completed, paymentMethodId: ids.bank })).rejects.toThrow('لا يمكن بدء الدفع لطلب في هذه الحالة');
    expect(await footprint(completed)).toEqual(before);
  });

  it.each(['PROOF_SUBMITTED', 'PENDING_VERIFICATION', 'PAID', 'CANCELLED'] as const)(
    'an order in %s gains no payment and does not move',
    async (status) => {
      const orderId = (await createOrder(buyerB, { productSlugs: [slug('p3')], buyerCountry: 'SY' })).orderId;
      // A fixture state, set directly: what is under test is that placeOrder refuses it.
      await asOwner((tx) => tx.update(orders).set({ status }).where(eq(orders.id, orderId)));
      const before = await footprint(orderId);
      await expect(placeOrder(buyerB, { orderId, paymentMethodId: ids.bank })).rejects.toBeInstanceOf(RuleViolationError);
      expect(await footprint(orderId)).toEqual(before);
      await asOwner((tx) => tx.delete(orders).where(eq(orders.id, orderId)));
    },
  );

  it('PAYMENT_ISSUE (after a rejected receipt) still lets the customer try again, as before', async () => {
    const orderId = (await createOrder(buyerB, { productSlugs: [slug('p4')], buyerCountry: 'SY' })).orderId;
    await placeOrder(buyerB, { orderId, paymentMethodId: ids.bank });
    await upload(buyerB, await paymentOf(orderId));
    await rejectPayment(owner, { paymentId: await paymentOf(orderId), reason: 'الإيصال غير واضح' });
    expect((await footprint(orderId)).order).toBe('PAYMENT_ISSUE');
    await placeOrder(buyerB, { orderId, paymentMethodId: ids.bank });
    expect((await footprint(orderId)).order).toBe('AWAITING_PAYMENT');
  });
});

describe('W14 — a receipt is refused BEFORE it is stored, unless it is the customer\'s', () => {
  let orderId = '';
  let paymentId = '';

  it('fixture: A\'s order awaits its receipt', async () => {
    orderId = (await asOwner((tx) => tx.select({ id: orders.id }).from(orders)
      .where(sql`${orders.customerId} = ${ids.a} AND ${orders.status} = 'AWAITING_PAYMENT'`)))[0]!.id;
    paymentId = await paymentOf(orderId);
    expect((await footprint(orderId)).payments).toBe('AWAITING_PROOF');
  });

  it("the owner's receipt on A's payment: refused, no receipt row, NO object stored", async () => {
    const before = await footprint(orderId);
    const refusal = upload(owner, paymentId);
    await expect(refusal).rejects.toBeInstanceOf(RuleViolationError);
    await expect(refusal).rejects.toThrow('رفع إيصال الدفع خطوة صاحب الطلب وحده');
    expect(put).not.toHaveBeenCalled();
    expect(await footprint(orderId)).toEqual(before);
  });

  it("buyer B's receipt on A's payment: not found, no row, no object", async () => {
    const before = await footprint(orderId);
    await expect(upload(buyerB, paymentId)).rejects.toBeInstanceOf(NotFoundError);
    expect(put).not.toHaveBeenCalled();
    expect(await footprint(orderId)).toEqual(before);
  });

  it("buyer A's own receipt: stored once, and W7's agreement holds — order and payment PROOF_SUBMITTED, one receipt", async () => {
    await upload(buyerA, paymentId);
    expect(put).toHaveBeenCalledTimes(1);
    expect(await footprint(orderId)).toMatchObject({ order: 'PROOF_SUBMITTED', payments: 'PROOF_SUBMITTED', proofs: 1 });
  });
});
