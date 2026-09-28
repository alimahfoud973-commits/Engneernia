import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext, type Transaction } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  auditLogs, commissionAgreements, contributors, disciplines, entitlements, invoices,
  ledgerTransactions, orders, paymentMethods, payments, productContributors, productPrices, products, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from './orders';
import { ConflictError } from '@/lib/errors';
import { toUserMessage } from '@/lib/action-errors';
import type { Actor } from '@/authz/actor';
import { insertProductsWithVersion } from '@/db/testing/product-versions';
import { withFinancialPurge } from '@/db/testing/financial-purge';

/**
 * ===========================================================================
 * THE OPTIONAL BANK REFERENCE (Stage 3 admin audit, W13)
 * ===========================================================================
 * Approving with the reference field left empty stored '' — a value to the
 * unique index `payments_provider_ref_unique (payment_method_id,
 * provider_ref)` — so the second approval without a reference on the same
 * method collided with the first, and the owner read "تعذّر إتمام العملية".
 *
 * Owner decision: the reference is optional. Empty and whitespace-only become
 * NULL, a real reference is trimmed, letter case is kept. A reference already
 * used on the same method is still refused by the index — now in words that
 * say so — and the refusal leaves nothing half-written.
 * ===========================================================================
 */

const suffix = Date.now();
const BUYERS = 10;
const ids = {
  owner: '', engineerUser: randomUUID(), contributor: randomUUID(), discipline: randomUUID(),
  product: randomUUID(), m1: randomUUID(), m2: randomUUID(),
  buyers: Array.from({ length: BUYERS }, () => randomUUID()),
};
const SLUG = `w13-ref-${suffix}`;

let OWNER_RAW: { actorId: string; actorRole: string };
const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true, totpEnabled: false } as const;
let owner: Actor;
const buyer = (i: number): Actor => ({ ...base, userId: ids.buyers[i]!, role: 'CUSTOMER', contributorId: null, contributorActive: false });
const asOwner = <T,>(fn: (tx: Transaction) => Promise<T>) => withRawActorContext(OWNER_RAW, fn);

/** Buyer `i` orders the product and chooses `method`; returns the payment id. */
async function pendingPayment(i: number, method: string): Promise<string> {
  const order = await createOrder(buyer(i), { productSlugs: [SLUG], buyerCountry: 'SY' });
  await placeOrder(buyer(i), { orderId: order.orderId, paymentMethodId: method });
  const [payment] = await asOwner((tx) => tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)));
  return payment!.id;
}

const refOf = async (paymentId: string) => {
  const [row] = await asOwner((tx) => tx.select({ ref: payments.providerRef, status: payments.status }).from(payments).where(eq(payments.id, paymentId)));
  return row!;
};

/** Everything an approval writes, so a refusal can be shown to write none of it. */
async function footprint(paymentId: string) {
  return asOwner(async (tx) => {
    const [pay] = await tx.select({ status: payments.status, ref: payments.providerRef, orderId: payments.orderId })
      .from(payments).where(eq(payments.id, paymentId));
    const [order] = await tx.select({ status: orders.status, customerId: orders.customerId }).from(orders).where(eq(orders.id, pay!.orderId));
    const count = async (q: Promise<Array<{ n: number }>>) => (await q)[0]!.n;
    return {
      payment: `${pay!.status}/${pay!.ref ?? 'NULL'}`,
      order: order!.status,
      invoicesOfOrder: await count(tx.select({ n: sql<number>`count(*)::int` }).from(invoices).where(eq(invoices.orderId, pay!.orderId))),
      entitlementsOfBuyer: await count(tx.select({ n: sql<number>`count(*)::int` }).from(entitlements).where(eq(entitlements.customerId, order!.customerId))),
      ledgerTransactions: await count(tx.select({ n: sql<number>`count(*)::int` }).from(ledgerTransactions)),
      auditRows: await count(tx.select({ n: sql<number>`count(*)::int` }).from(auditLogs)),
      lastInvoiceNumber: await lastInvoiceNumber(tx),
    };
  });
}

/**
 * The highest invoice number issued. The counter itself is not readable by the
 * application role (it moves only inside `app_next_invoice_number`), so a
 * spent number is proven from the invoices: the next sale must take the very
 * next number.
 */
async function lastInvoiceNumber(tx: Transaction): Promise<string> {
  const [row] = await tx.select({ n: sql<string>`max(${invoices.invoiceNumber})` }).from(invoices);
  return row!.n;
}
const nextOf = (invoiceNumber: string) =>
  invoiceNumber.replace(/(\d+)$/, (digits) => String(Number(digits) + 1).padStart(digits.length, '0'));
let numberBeforeRefusal = '';

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await asOwner(async (tx) => {
    await tx.insert(users).values([
      ...ids.buyers.map((id, i) => ({
        id, email: `w13-b${i}+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER' as const, status: 'ACTIVE' as const,
        displayName: `Buyer ${i}`, countryCode: 'SY',
      })),
      { id: ids.engineerUser, email: `w13-e+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `w13-eng-${suffix}`,
      settlementCode: `W13${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({ id: ids.discipline, slug: `w13-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 92 });
    await insertProductsWithVersion(tx, {
      id: ids.product, slug: SLUG, titleAr: 'مورد هندسي', disciplineId: ids.discipline,
      fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date(),
    });
    await tx.insert(productContributors).values({ productId: ids.product, contributorId: ids.contributor, shareBp: 10000 });
    await tx.insert(productPrices).values({ productId: ids.product, amountMinor: 1000n, currency: 'USD' });
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
    const method = { type: 'MANUAL' as const, instructionsAr: 'حوّل', accountDetailsAr: 'IBAN TEST', requiresProof: false, countries: [], currencies: ['USD'], isActive: true };
    await tx.insert(paymentMethods).values([
      { id: ids.m1, code: `w13-m1-${suffix}`, displayNameAr: 'تحويل ١', sortOrder: 1, ...method },
      { id: ids.m2, code: `w13-m2-${suffix}`, displayNameAr: 'تحويل ٢', sortOrder: 2, ...method },
    ]);
  });
}, 120_000);

afterAll(async () => {
  // Superuser + explicit flag: these fixtures became financial history (S5-03).
  await withFinancialPurge(async (tx) => {
    // Invoices are append-only and stay, as in tax.itest.
    await tx.delete(entitlements).where(inArray(entitlements.customerId, ids.buyers));
    await tx.delete(orders).where(inArray(orders.customerId, ids.buyers));
    await tx.delete(paymentMethods).where(inArray(paymentMethods.id, [ids.m1, ids.m2]));
    await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.delete(productPrices).where(eq(productPrices.productId, ids.product));
    await tx.delete(productContributors).where(eq(productContributors.productId, ids.product));
    await tx.delete(products).where(eq(products.id, ids.product));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(inArray(users.id, [...ids.buyers, ids.engineerUser]));
  });
  await closeDb();
}, 60_000);

describe('W13 — no reference is NULL, however it arrives', () => {
  it('1. no reference at all → approved, NULL', async () => {
    const id = await pendingPayment(0, ids.m1);
    await approvePayment(owner, { paymentId: id });
    expect(await refOf(id)).toEqual({ ref: null, status: 'APPROVED' });
  });

  it("2. '' (the empty form field) → approved, NULL — and it no longer blocks the next one", async () => {
    const id = await pendingPayment(1, ids.m1);
    await approvePayment(owner, { paymentId: id, providerRef: '' });
    expect(await refOf(id)).toEqual({ ref: null, status: 'APPROVED' });
  });

  it("3. '   ' (spaces only) → approved, NULL — three reference-less approvals on one method", async () => {
    const id = await pendingPayment(2, ids.m1);
    await approvePayment(owner, { paymentId: id, providerRef: '   ' });
    expect(await refOf(id)).toEqual({ ref: null, status: 'APPROVED' });
  });
});

describe('W13 — a real reference is trimmed, kept as typed, and still unique per method', () => {
  it("4. ' ABC123 ' → stored as 'ABC123'", async () => {
    const id = await pendingPayment(3, ids.m1);
    await approvePayment(owner, { paymentId: id, providerRef: ' ABC123 ' });
    expect(await refOf(id)).toEqual({ ref: 'ABC123', status: 'APPROVED' });
  });

  it("5. 'XYZ789' → approved as typed", async () => {
    const id = await pendingPayment(4, ids.m1);
    await approvePayment(owner, { paymentId: id, providerRef: 'XYZ789' });
    expect(await refOf(id)).toEqual({ ref: 'XYZ789', status: 'APPROVED' });
  });

  it("6. 'ABC123' again on the same method → refused, in words that say why; 9–10. nothing half-written, no invoice number spent", async () => {
    const id = await pendingPayment(5, ids.m1);
    const before = await footprint(id);

    const refusal = approvePayment(owner, { paymentId: id, providerRef: 'ABC123' });
    await expect(refusal).rejects.toBeInstanceOf(ConflictError);
    const error = await refusal.catch((e: unknown) => e);
    expect(toUserMessage(error, 'w13 test')).toBe('رقم العملية هذا مستخدم لدفعة أخرى بالطريقة نفسها.');

    expect(await footprint(id)).toEqual(before);
    expect(before.payment).toBe('INITIATED/NULL');
    numberBeforeRefusal = before.lastInvoiceNumber;
  });

  it("6b. the same reference with spaces around it is the same reference — refused too", async () => {
    const id = await pendingPayment(6, ids.m1);
    const before = await footprint(id);
    await expect(approvePayment(owner, { paymentId: id, providerRef: '  ABC123\t' })).rejects.toBeInstanceOf(ConflictError);
    expect(await footprint(id)).toEqual(before);
  });

  it("7. 'ABC123' on a different method → approved (the index is per method)", async () => {
    const id = await pendingPayment(7, ids.m2);
    await approvePayment(owner, { paymentId: id, providerRef: 'ABC123' });
    expect(await refOf(id)).toEqual({ ref: 'ABC123', status: 'APPROVED' });
  });

  it("8. 'abc123' on the first method → approved: letter case is not changed in this cycle", async () => {
    const id = await pendingPayment(8, ids.m1);
    await approvePayment(owner, { paymentId: id, providerRef: 'abc123' });
    expect(await refOf(id)).toEqual({ ref: 'abc123', status: 'APPROVED' });
  });

  it('10. the refused payment, corrected, takes exactly the next invoice number — the refusals spent none', async () => {
    // Between the refusal (6) and here, 6b was refused and 7–8 each issued an
    // invoice: the corrected sale must be exactly three numbers on.
    const [row] = await asOwner((tx) => tx.select({ id: payments.id, orderId: payments.orderId }).from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId)).where(eq(orders.customerId, ids.buyers[5]!)));
    await approvePayment(owner, { paymentId: row!.id, providerRef: 'ABC124' });
    expect(await refOf(row!.id)).toEqual({ ref: 'ABC124', status: 'APPROVED' });
    const [invoice] = await asOwner((tx) => tx.select({ n: invoices.invoiceNumber }).from(invoices).where(eq(invoices.orderId, row!.orderId)));
    expect(invoice!.n).toBe(nextOf(nextOf(nextOf(numberBeforeRefusal))));
  });

  it("no '' or whitespace-only reference is stored anywhere after all of this", async () => {
    const [row] = await asOwner((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(payments)
      .where(sql`${payments.providerRef} ~ '^[[:space:]]*$'`));
    expect(row!.n).toBe(0);
  });
});
