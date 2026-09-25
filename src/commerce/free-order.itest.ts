import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { withRawActorContext, type Transaction } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  auditLogs, commissionAgreements, contributors, disciplines, entitlements, invoices,
  ledgerTransactions, orderEvents, orderItemContributors, orderItems, orders, paymentMethods,
  payments, productContributors,
  productFiles, productPrices, products, users,
} from '@/db/schema';
import { completeFreeOrder, createOrder, placeOrder } from './orders';
import { myPurchases } from './queries';
import { changeProductPrice } from '@/catalog/products';
import { deliverProductFile } from '@/media/deliver';
import { ingestProductFile } from '@/media/ingest';
import { NotFoundError, RuleViolationError, UnauthenticatedError } from '@/lib/errors';
import { GUEST, type Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * A FREE PRODUCT IS TAKEN, NOT PAID FOR (Stage 2 buyer audit, F1; OPEN-12)
 * ===========================================================================
 * Found by operating the site: "الحصول عليه مجاناً" built an order of zero,
 * sent the buyer to choose a payment method, and the database refused the
 * zero payment (`payments_amount_positive`). The product could not be had.
 *
 * Now a zero-value order completes through `app_complete_free_order`
 * (migration 0054) with no payment, ledger entry or invoice at all. This file
 * proves the grant, the absence of every money row, the download gate on both
 * sides, the refusals, and that the paid path is exactly as it was.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '', customer: randomUUID(), stranger: randomUUID(), late: randomUUID(), unpub: randomUUID(),
  engineerUser: randomUUID(), contributor: randomUUID(), discipline: randomUUID(),
  free: randomUUID(), paid: randomUUID(), bank: randomUUID(),
};
const FREE_SLUG = `f1-free-${suffix}`;
const PAID_SLUG = `f1-paid-${suffix}`;
const PAID_PRICE = 1500n;

let OWNER_RAW: { actorId: string; actorRole: string };
const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true, totpEnabled: false } as const;
let owner: Actor;
const customer: Actor = { ...base, userId: ids.customer, role: 'CUSTOMER', contributorId: null, contributorActive: false };
const stranger: Actor = { ...base, userId: ids.stranger, role: 'CUSTOMER', contributorId: null, contributorActive: false };
const late: Actor = { ...base, userId: ids.late, role: 'CUSTOMER', contributorId: null, contributorActive: false };
const unpub: Actor = { ...base, userId: ids.unpub, role: 'CUSTOMER', contributorId: null, contributorActive: false };

async function buildPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 8; i += 1) doc.addPage([595, 842]).drawText(`F1 ${i}`, { x: 50, y: 700, size: 24, font });
  return doc.save();
}

const asOwner = <T,>(fn: (tx: Transaction) => Promise<T>) => withRawActorContext(OWNER_RAW, fn);

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await asOwner(async (tx) => {
    await tx.insert(users).values([
      { id: ids.customer, email: `f1-c+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Customer' },
      { id: ids.stranger, email: `f1-s+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Stranger' },
      { id: ids.late, email: `f1-l+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Late' },
      { id: ids.unpub, email: `f1-u+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Unpublished' },
      { id: ids.engineerUser, email: `f1-e+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `f1-eng-${suffix}`,
      settlementCode: `F1E${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({ id: ids.discipline, slug: `f1-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 96 });
    await tx.insert(products).values([
      { id: ids.free, slug: FREE_SLUG, titleAr: 'دليل مجاني', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', isFree: true, publishedAt: new Date() },
      { id: ids.paid, slug: PAID_SLUG, titleAr: 'دليل مدفوع', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
    ]);
    await tx.insert(productContributors).values([
      { productId: ids.free, contributorId: ids.contributor, shareBp: 10000 },
      { productId: ids.paid, contributorId: ids.contributor, shareBp: 10000 },
    ]);
    await tx.insert(productPrices).values([
      { productId: ids.free, amountMinor: 0n, currency: 'USD' },
      { productId: ids.paid, amountMinor: PAID_PRICE, currency: 'USD' },
    ]);
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
    await tx.insert(paymentMethods).values({
      id: ids.bank, code: `f1-bank-${suffix}`, type: 'MANUAL', displayNameAr: 'تحويل بنكي',
      instructionsAr: 'حوّل المبلغ', accountDetailsAr: 'IBAN SY00 TEST', requiresProof: true,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });

  await ingestProductFile(owner, {
    productId: ids.free, filename: 'free.pdf', declaredType: 'PDF', body: await buildPdf(), contentType: 'application/pdf',
  });
}, 120_000);

afterAll(async () => {
  await asOwner(async (tx) => {
    const people = sql`(${ids.customer}, ${ids.stranger}, ${ids.late}, ${ids.unpub})`;
    await tx.delete(orders).where(sql`customer_id IN ${people}`);
    await tx.delete(entitlements).where(sql`customer_id IN ${people}`);
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.bank));
    await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.delete(productContributors).where(sql`product_id IN (${ids.free}, ${ids.paid})`);
    await tx.delete(productFiles).where(sql`product_id IN (${ids.free}, ${ids.paid})`);
    await tx.delete(productPrices).where(sql`product_id IN (${ids.free}, ${ids.paid})`);
    await tx.delete(products).where(sql`id IN (${ids.free}, ${ids.paid})`);
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(sql`id IN (${ids.customer}, ${ids.stranger}, ${ids.late}, ${ids.unpub}, ${ids.engineerUser})`);
  });
  await closeDb();
});

describe('1. a signed-in buyer takes a free product', () => {
  let orderId: string;

  it('builds a DRAFT order worth exactly zero', async () => {
    const order = await createOrder(customer, { productSlugs: [FREE_SLUG] });
    orderId = order.orderId;
    expect(order.totalMinor).toBe(0n);
  });

  it('refuses to open a payment for it — no method, no receipt', async () => {
    await expect(placeOrder(customer, { orderId, paymentMethodId: ids.bank }))
      .rejects.toThrow(RuleViolationError);
    const rows = await asOwner((tx) => tx.select().from(payments).where(eq(payments.orderId, orderId)));
    expect(rows).toHaveLength(0);
  });

  it('gives no file before the order is complete', async () => {
    await expect(deliverProductFile(customer, { productSlug: FREE_SLUG, role: 'ORIGINAL' }))
      .rejects.toThrow(NotFoundError);
  });

  it('will not let a guest complete it', async () => {
    await expect(completeFreeOrder(GUEST, { orderId })).rejects.toThrow(UnauthenticatedError);
  });

  it('will not let another signed-in customer complete it (changing the id is not enough)', async () => {
    await expect(completeFreeOrder(stranger, { orderId })).rejects.toThrow(NotFoundError);
    const [order] = await asOwner((tx) => tx.select().from(orders).where(eq(orders.id, orderId)));
    expect(order!.status).toBe('DRAFT');
    const granted = await asOwner((tx) => tx.select().from(entitlements).where(eq(entitlements.customerId, ids.stranger)));
    expect(granted).toHaveLength(0);
  });

  it('completes it and grants access, in one step', async () => {
    const done = await completeFreeOrder(customer, { orderId });
    expect(done.entitlementsGranted).toBe(1);
    const [order] = await asOwner((tx) => tx.select().from(orders).where(eq(orders.id, orderId)));
    expect(order!.status).toBe('COMPLETED');
    expect(order!.completedAt).not.toBeNull();
  });

  it('writes no payment, no ledger transaction and no invoice — no money moved', async () => {
    const [pay, ledger, invoice] = await asOwner(async (tx) => Promise.all([
      tx.select().from(payments).where(eq(payments.orderId, orderId)),
      tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.referenceId, orderId)),
      tx.select().from(invoices).where(eq(invoices.orderId, orderId)),
    ]));
    expect(pay).toHaveLength(0);
    expect(ledger).toHaveLength(0);
    expect(invoice).toHaveLength(0);
  });

  it('records the same three history steps as a paid order, and an audit entry', async () => {
    const events = await asOwner((tx) => tx.select().from(orderEvents).where(eq(orderEvents.orderId, orderId)));
    const steps = events.map((e) => `${e.fromStatus ?? '∅'}→${e.toStatus}`);
    expect(steps).toEqual(expect.arrayContaining(['DRAFT→AWAITING_PAYMENT', 'AWAITING_PAYMENT→PAID', 'PAID→COMPLETED']));
    const audit = await asOwner((tx) => tx.select().from(auditLogs).where(
      and(eq(auditLogs.entityId, orderId), eq(auditLogs.action, 'FREE_ORDER_COMPLETED')),
    ));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorUserId).toBe(ids.customer);
  });

  it('shows the product among the buyer\'s purchases', async () => {
    const mine = await myPurchases(customer);
    expect(mine.owned.map((o) => o.productSlug)).toContain(FREE_SLUG);
    expect(mine.orders.find((o) => o.id === orderId)?.status).toBe('COMPLETED');
  });

  it('opens the file to the buyer', async () => {
    const delivery = await deliverProductFile(customer, { productSlug: FREE_SLUG, role: 'ORIGINAL' });
    expect(delivery.grant.kind).toBe('stream');
  });

  it('keeps the file closed to someone who does not own the order', async () => {
    await expect(deliverProductFile(stranger, { productSlug: FREE_SLUG, role: 'ORIGINAL' }))
      .rejects.toThrow(NotFoundError);
  });

  it('cannot be completed twice', async () => {
    await expect(completeFreeOrder(customer, { orderId })).rejects.toThrow(RuleViolationError);
  });

  it('cannot be taken a second time through a new order', async () => {
    await expect(createOrder(customer, { productSlugs: [FREE_SLUG] })).rejects.toThrow(RuleViolationError);
  });
});

describe('2. what is not free is not given away', () => {
  it('refuses to complete a paid order through the free path', async () => {
    const order = await createOrder(customer, { productSlugs: [PAID_SLUG] });
    await expect(completeFreeOrder(customer, { orderId: order.orderId })).rejects.toThrow(RuleViolationError);
    const granted = await asOwner((tx) => tx.select().from(entitlements).where(
      and(eq(entitlements.customerId, ids.customer), eq(entitlements.productId, ids.paid)),
    ));
    expect(granted).toHaveLength(0);
  });

  it('refuses a free order whose product has since been given a price', async () => {
    const order = await createOrder(late, { productSlugs: [FREE_SLUG] });
    expect(order.totalMinor).toBe(0n);
    await changeProductPrice(owner, { productId: ids.free, newAmountMinor: 500n, currency: 'USD', reason: 'F1 test' });
    try {
      await expect(completeFreeOrder(late, { orderId: order.orderId })).rejects.toThrow(RuleViolationError);
      const granted = await asOwner((tx) => tx.select().from(entitlements).where(eq(entitlements.customerId, ids.late)));
      expect(granted).toHaveLength(0);
    } finally {
      await changeProductPrice(owner, { productId: ids.free, newAmountMinor: 0n, currency: 'USD', reason: 'F1 test restore' });
    }
  });

  /*
   * Proven in the security review against the SQL function directly; kept
   * here so it cannot regress. `products` is RLS-enabled but not FORCEd, so
   * the definer sees the product's real status — an unpublished product is
   * not hidden from the check, it fails it.
   */
  it('refuses a free order whose product has since been unpublished, and leaves no trace', async () => {
    const order = await createOrder(unpub, { productSlugs: [FREE_SLUG] });
    expect(order.totalMinor).toBe(0n);
    const [before] = await asOwner((tx) => tx
      .select({ n: products.salesCount }).from(products).where(eq(products.id, ids.free)));
    const salesBefore = before!.n;

    await asOwner((tx) => tx.update(products).set({ status: 'UNPUBLISHED' }).where(eq(products.id, ids.free)));
    try {
      await expect(completeFreeOrder(unpub, { orderId: order.orderId })).rejects.toThrow(RuleViolationError);

      const [after, granted, pay, ledger, invoice, lines, events, audit, sales] = await asOwner(async (tx) => {
        const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.orderId));
        return Promise.all([
          tx.select().from(orders).where(eq(orders.id, order.orderId)),
          tx.select().from(entitlements).where(eq(entitlements.customerId, ids.unpub)),
          tx.select().from(payments).where(eq(payments.orderId, order.orderId)),
          tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.referenceId, order.orderId)),
          tx.select().from(invoices).where(eq(invoices.orderId, order.orderId)),
          Promise.resolve(items),
          tx.select().from(orderEvents).where(eq(orderEvents.orderId, order.orderId)),
          tx.select().from(auditLogs).where(
            and(eq(auditLogs.entityId, order.orderId), eq(auditLogs.action, 'FREE_ORDER_COMPLETED')),
          ),
          tx.select({ n: products.salesCount }).from(products).where(eq(products.id, ids.free)),
        ]);
      });

      // Refused, and the order is exactly as it was built.
      expect(after[0]!.status).toBe('DRAFT');
      expect(after[0]!.completedAt).toBeNull();
      expect(granted).toHaveLength(0);
      // No money rows of any kind.
      expect(pay).toHaveLength(0);
      expect(ledger).toHaveLength(0);
      expect(invoice).toHaveLength(0);
      // No commission snapshot: the line is unfrozen and has no per-engineer rows.
      expect(lines).toHaveLength(1);
      expect(lines[0]!.snapshotTakenAt).toBeNull();
      const perEngineer = await asOwner((tx) => tx.select().from(orderItemContributors)
        .where(eq(orderItemContributors.orderItemId, lines[0]!.id)));
      expect(perEngineer).toHaveLength(0);
      // No side effect: only the creation event, no completion audit, no sale counted.
      expect(events.map((e) => e.toStatus)).toEqual(['DRAFT']);
      expect(audit).toHaveLength(0);
      expect(sales[0]!.n).toBe(salesBefore);
    } finally {
      await asOwner((tx) => tx.update(products).set({ status: 'PUBLISHED' }).where(eq(products.id, ids.free)));
    }
  });
});

describe('3. the paid path is unchanged', () => {
  it('still opens a payment of the full amount, awaiting its receipt', async () => {
    const [order] = await asOwner((tx) => tx.select().from(orders).where(
      and(eq(orders.customerId, ids.customer), eq(orders.status, 'DRAFT')),
    ));
    expect(order!.totalMinor).toBe(PAID_PRICE);
    const initiation = await placeOrder(customer, { orderId: order!.id, paymentMethodId: ids.bank });
    expect(initiation.kind).toBe('INSTRUCTIONS');
    const [pay] = await asOwner((tx) => tx.select().from(payments).where(eq(payments.orderId, order!.id)));
    expect(pay!.amountMinor).toBe(PAID_PRICE);
    expect(pay!.status).toBe('AWAITING_PROOF');
    const [after] = await asOwner((tx) => tx.select().from(orders).where(eq(orders.id, order!.id)));
    expect(after!.status).toBe('AWAITING_PAYMENT');
  });
});
