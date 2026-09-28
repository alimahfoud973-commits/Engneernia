import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { withActor, withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements,
  orders, paymentMethods, paymentProofs, payments, productContributors,
  productPrices, products, users,
} from '@/db/schema';
import { approvePayment, completeFreeOrder, createOrder, placeOrder, rejectPayment } from './orders';
import { submitPaymentProof } from './proofs';
import { NotFoundError, RuleViolationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';
import { insertProductsWithVersion } from '@/db/testing/product-versions';
import { withFinancialPurge } from '@/db/testing/financial-purge';

/**
 * ===========================================================================
 * A RECEIPT MOVES THE PAYMENT, NOT ONLY THE ORDER (Stage 3, W7)
 * ===========================================================================
 * `submitPaymentProof` wrote the receipt, moved the order to PROOF_SUBMITTED,
 * and asked for the payment to follow — with an UPDATE that the customer's
 * row-level security (`payments_update`: owner only) filtered down to zero
 * rows. Nothing checked the count, so every upload left the payment at
 * AWAITING_PROOF beside a receipt and an order that said otherwise.
 *
 * The move now goes through `app_mark_payment_proof_submitted` (0057), which
 * checks everything as the customer and changes exactly one column of exactly
 * one row. These tests pin the consistency, the refusals and the neighbours.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '', buyerA: randomUUID(), buyerB: randomUUID(),
  engineerUser: randomUUID(), contributor: randomUUID(), discipline: randomUUID(),
  paid: randomUUID(), second: randomUUID(), free: randomUUID(), method: randomUUID(),
};
const slugs = { paid: `w7-paid-${suffix}`, second: `w7-second-${suffix}`, free: `w7-free-${suffix}` };

let OWNER_RAW: { actorId: string; actorRole: string };
const base = {
  kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's',
  twoFactorSatisfied: true, totpEnabled: false,
} as const;
let owner: Actor;
const asCustomer = (id: string): Actor => ({
  ...base, userId: id, role: 'CUSTOMER', contributorId: null, contributorActive: false,
});
const buyerA = asCustomer(ids.buyerA);
const buyerB = asCustomer(ids.buyerB);

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

/** The three facts that must agree after an upload. */
async function stateOf(paymentId: string) {
  return withRawActorContext(OWNER_RAW, async (tx) => {
    const [row] = await tx
      .select({ payment: payments.status, order: orders.status, orderId: orders.id })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(eq(payments.id, paymentId));
    const proofs = await tx.select({ id: paymentProofs.id }).from(paymentProofs)
      .where(eq(paymentProofs.paymentId, paymentId));
    const paymentsOfOrder = await tx.select({ id: payments.id }).from(payments)
      .where(eq(payments.orderId, row!.orderId));
    return { payment: row!.payment, order: row!.order, proofs: proofs.length, payments: paymentsOfOrder.length };
  });
}

/** Buys `slug` as `buyer` up to AWAITING_PROOF and returns the payment id. */
async function awaitingProof(buyer: Actor, slug: string): Promise<string> {
  const order = await createOrder(buyer, { productSlugs: [slug] });
  await placeOrder(buyer, { orderId: order.orderId, paymentMethodId: ids.method });
  const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)));
  return payment!.id;
}

const upload = (buyer: Actor, paymentId: string) =>
  submitPaymentProof(buyer, { paymentId, filename: 'receipt.png', body: png(), referenceNote: 'W7' });

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.buyerA, email: `w7-a+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Buyer A', countryCode: 'SY' },
      { id: ids.buyerB, email: `w7-b+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Buyer B', countryCode: 'SY' },
      { id: ids.engineerUser, email: `w7-eng+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `w7-eng-${suffix}`,
      settlementCode: `W7E${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `w7-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 93,
    });
    const published = { disciplineId: ids.discipline, fileType: 'PDF' as const, status: 'PUBLISHED' as const, currency: 'USD', publishedAt: new Date() };
    await insertProductsWithVersion(tx, [
      { id: ids.paid, slug: slugs.paid, titleAr: 'دليل مدفوع', ...published },
      { id: ids.second, slug: slugs.second, titleAr: 'دليل ثانٍ', ...published },
      { id: ids.free, slug: slugs.free, titleAr: 'دليل مجاني', ...published },
    ]);
    await tx.insert(productContributors).values([ids.paid, ids.second, ids.free].map((productId) => (
      { productId, contributorId: ids.contributor, shareBp: 10000 })));
    await tx.insert(productPrices).values([
      { productId: ids.paid, amountMinor: 2500n, currency: 'USD' },
      { productId: ids.second, amountMinor: 1500n, currency: 'USD' },
      { productId: ids.free, amountMinor: 0n, currency: 'USD' },
    ]);
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE',
      engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `w7-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل بنكي', instructionsAr: 'حوّل ثم ارفع الإيصال', accountDetailsAr: 'IBAN TEST',
      requiresProof: true, countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });
}, 120_000);

afterAll(async () => {
  // Superuser + explicit flag: these fixtures became financial history (S5-03).
  await withFinancialPurge(async (tx) => {
    const buyers = [ids.buyerA, ids.buyerB];
    // Invoices stay: append-only even for a superuser (OPEN-9). Under the
    // owner's context this line used to delete nothing, silently — no
    // policy grants DELETE on invoices.
    await tx.delete(entitlements).where(inArray(entitlements.customerId, buyers));
    await tx.delete(orders).where(inArray(orders.customerId, buyers));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.delete(productContributors).where(inArray(productContributors.productId, [ids.paid, ids.second, ids.free]));
    await tx.delete(products).where(inArray(products.id, [ids.paid, ids.second, ids.free]));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(inArray(users.id, [...buyers, ids.engineerUser]));
  });
  await closeDb();
}, 60_000);

describe('W7 — a receipt leaves order, payment and receipt in agreement', () => {
  let paymentId = '';

  it('before the upload the payment awaits its proof', async () => {
    paymentId = await awaitingProof(buyerA, slugs.paid);
    expect(await stateOf(paymentId)).toEqual({ payment: 'AWAITING_PROOF', order: 'AWAITING_PAYMENT', proofs: 0, payments: 1 });
  }, 60_000);

  it('after the upload: receipt stored, order AND payment at PROOF_SUBMITTED, nothing duplicated', async () => {
    await upload(buyerA, paymentId);
    expect(await stateOf(paymentId)).toEqual({ payment: 'PROOF_SUBMITTED', order: 'PROOF_SUBMITTED', proofs: 1, payments: 1 });
  }, 60_000);

  it('a second upload on the same payment is refused cleanly and changes nothing', async () => {
    await expect(upload(buyerA, paymentId)).rejects.toBeInstanceOf(RuleViolationError);
    expect(await stateOf(paymentId)).toEqual({ payment: 'PROOF_SUBMITTED', order: 'PROOF_SUBMITTED', proofs: 1, payments: 1 });
  }, 60_000);

  it("another buyer cannot put a receipt on this payment — not found, state untouched", async () => {
    await expect(upload(buyerB, paymentId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await stateOf(paymentId)).toEqual({ payment: 'PROOF_SUBMITTED', order: 'PROOF_SUBMITTED', proofs: 1, payments: 1 });
  }, 60_000);

  it('the owner approves it: payment APPROVED, order settled', async () => {
    await approvePayment(owner, { paymentId });
    const state = await stateOf(paymentId);
    expect(state.payment).toBe('APPROVED');
    expect(['PAID', 'COMPLETED']).toContain(state.order);
  }, 60_000);
});

describe('W7 — the database function refuses everything but its one move', () => {
  const mark = (actor: Actor, id: string) =>
    withActor(actor, (tx) => tx.execute(sql`SELECT app_mark_payment_proof_submitted(${id}::uuid)`));

  it("refuses another buyer's payment, and leaves it as it was", async () => {
    const id = await awaitingProof(buyerA, slugs.second);
    await withRawActorContext(OWNER_RAW, (tx) => tx.insert(paymentProofs).values({
      paymentId: id, storageKey: `proof/00/${randomUUID()}`, contentType: 'image/png', byteSize: 1n, submittedBy: ids.buyerA,
    }));
    await expect(mark(buyerB, id)).rejects.toThrow();
    expect((await stateOf(id)).payment).toBe('AWAITING_PROOF');
    // …and the rightful buyer can, which is what makes the refusal meaningful.
    await mark(buyerA, id);
    expect((await stateOf(id)).payment).toBe('PROOF_SUBMITTED');
  }, 60_000);

  it('refuses a payment that has no receipt yet', async () => {
    const order = await createOrder(buyerB, { productSlugs: [slugs.second] });
    await placeOrder(buyerB, { orderId: order.orderId, paymentMethodId: ids.method });
    const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)));
    await expect(mark(buyerB, payment!.id)).rejects.toThrow();
    expect((await stateOf(payment!.id)).payment).toBe('AWAITING_PROOF');
  }, 60_000);
});

describe('W7 — rejection and the free path are unchanged', () => {
  it('rejection: payment REJECTED, order PAYMENT_ISSUE; a receipt on the rejected payment is refused and stores nothing', async () => {
    const order = await createOrder(buyerB, { productSlugs: [slugs.paid] });
    await placeOrder(buyerB, { orderId: order.orderId, paymentMethodId: ids.method });
    const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)));
    await upload(buyerB, payment!.id);
    expect(await stateOf(payment!.id)).toEqual({ payment: 'PROOF_SUBMITTED', order: 'PROOF_SUBMITTED', proofs: 1, payments: 1 });

    await rejectPayment(owner, { paymentId: payment!.id, reason: 'الإيصال غير واضح' });
    expect(await stateOf(payment!.id)).toEqual({ payment: 'REJECTED', order: 'PAYMENT_ISSUE', proofs: 1, payments: 1 });

    await expect(upload(buyerB, payment!.id)).rejects.toBeInstanceOf(RuleViolationError);
    expect(await stateOf(payment!.id)).toEqual({ payment: 'REJECTED', order: 'PAYMENT_ISSUE', proofs: 1, payments: 1 });
  }, 60_000);

  it('a free product completes with no payment at all', async () => {
    const order = await createOrder(buyerA, { productSlugs: [slugs.free] });
    await completeFreeOrder(buyerA, { orderId: order.orderId });
    const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ status: orders.status }).from(orders).where(eq(orders.id, order.orderId)));
    const pays = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)));
    expect(row!.status).toBe('COMPLETED');
    expect(pays).toHaveLength(0);
  }, 60_000);
});
