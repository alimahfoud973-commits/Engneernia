import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withRawActorContext } from '@/db/actor-context';
import { closeDb } from '@/db';
import { auditLogs, payments } from '@/db/schema';
import { approvePayment, createOrder, placeOrder, rejectPayment } from './orders';
import { submitPaymentProof } from './proofs';
import { checkoutView, verificationQueue } from './queries';
import { RuleViolationError } from '@/lib/errors';
import {
  buildCommerceWorld, orderStatusOf, paymentsOfOrder, pngBytes, type CommerceWorld,
} from '@/db/testing/commerce-fixtures';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * EVERY PAYMENT ATTEMPT IS ITS OWN ROW (Stage 7 — K1, K2, D2, S7-01/02/05)
 * ===========================================================================
 * Before Stage 7 a rejected receipt ended the sale: the order page kept
 * showing the rejected payment and refused every new receipt, a retry with
 * the same method was swallowed by the idempotency key `order:method`, and the
 * buyer could never order the product again. Choosing WhatsApp was the same
 * dead end. Now:
 *
 *   - at most one OPEN payment per order (INITIATED, AWAITING_PROOF,
 *     PROOF_SUBMITTED) — enforced by `payments_one_open_per_order` (0066);
 *   - a retry after a rejection is a NEW payment row, with the same method or
 *     another; the rejected row is history and never changes again;
 *   - choosing another method before a receipt closes the open payment as
 *     CANCELLED and opens a new one — WhatsApp included;
 *   - after a receipt, the method cannot change.
 * ===========================================================================
 */

let w: CommerceWorld;
let buyerA: Actor, buyerB: Actor, buyerC: Actor, buyerD: Actor;

const upload = (who: Actor, paymentId: string) =>
  submitPaymentProof(who, { paymentId, filename: 'r.png', body: pngBytes(), referenceNote: 'S7' });

const openOf = async (orderId: string) =>
  (await paymentsOfOrder(w, orderId)).filter((p) => ['INITIATED', 'AWAITING_PROOF', 'PROOF_SUBMITTED'].includes(p.status));

beforeAll(async () => {
  w = await buildCommerceWorld({ prefix: 's7-att', buyers: 4, prices: { p1: 2500n, p2: 2500n, p3: 2500n, p4: 2500n } });
  [buyerA, buyerB, buyerC, buyerD] = w.buyers as [Actor, Actor, Actor, Actor];
}, 120_000);

afterAll(async () => {
  await w.cleanup();
  await closeDb();
}, 60_000);

describe('K1 — a rejected payment is history, and the buyer tries again', () => {
  let orderId = '';
  let rejectedId = '';
  let rejectedBefore: Record<string, unknown> = {};

  it('rejection leaves no open payment and the order page offers the picker with the reason', async () => {
    orderId = (await createOrder(buyerA, { productSlugs: [w.products.p1!.slug], buyerCountry: 'SY' })).orderId;
    await placeOrder(buyerA, { orderId, paymentMethodId: w.methods.bank });
    rejectedId = (await paymentsOfOrder(w, orderId))[0]!.id;
    await upload(buyerA, rejectedId);
    await rejectPayment(w.owner, { paymentId: rejectedId, reason: 'الإيصال غير واضح' });

    const view = await checkoutView(buyerA, orderId);
    expect(view!.order.status).toBe('PAYMENT_ISSUE');
    expect(view!.payment).toBeNull();
    expect(view!.lastRejection?.reason).toBe('الإيصال غير واضح');
    expect(view!.methods.length).toBeGreaterThan(0);
    rejectedBefore = { ...(await paymentsOfOrder(w, orderId))[0]! };
  });

  it('a retry with the SAME method opens a new payment row; the rejected one is untouched', async () => {
    await placeOrder(buyerA, { orderId, paymentMethodId: w.methods.bank });
    const all = await paymentsOfOrder(w, orderId);
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(rejectedBefore);
    expect(all[1]!.id).not.toBe(rejectedId);
    expect(all[1]!.status).toBe('AWAITING_PROOF');
    expect(await orderStatusOf(w, orderId)).toBe('AWAITING_PAYMENT');
    expect((await checkoutView(buyerA, orderId))!.payment!.id).toBe(all[1]!.id);
  });

  it('the new attempt takes a receipt and the owner approves it: one invoice, one sale, one entitlement', async () => {
    const fresh = (await openOf(orderId))[0]!;
    await upload(buyerA, fresh.id);
    await approvePayment(w.owner, { paymentId: fresh.id });
    expect(await orderStatusOf(w, orderId)).toBe('COMPLETED');
    const all = await paymentsOfOrder(w, orderId);
    expect(all.map((p) => p.status)).toEqual(['REJECTED', 'APPROVED']);
    expect(all[0]).toEqual(rejectedBefore);
    const [counts] = await withRawActorContext(w.ownerRaw, (tx) => tx.execute(sql`
      SELECT (SELECT count(*)::int FROM invoices WHERE order_id = ${orderId}::uuid) AS invoices,
             (SELECT count(*)::int FROM ledger_transactions WHERE reference_id = ${orderId}::uuid) AS ledger,
             (SELECT count(*)::int FROM entitlements e JOIN order_items oi ON oi.id = e.order_item_id
               WHERE oi.order_id = ${orderId}::uuid) AS grants`)) as unknown as Array<Record<string, number>>;
    expect(counts).toEqual({ invoices: 1, ledger: 1, grants: 1 });
  });

  it('a retry with a DIFFERENT method works the same way', async () => {
    const id = (await createOrder(buyerB, { productSlugs: [w.products.p1!.slug], buyerCountry: 'SY' })).orderId;
    await placeOrder(buyerB, { orderId: id, paymentMethodId: w.methods.bank });
    const first = (await paymentsOfOrder(w, id))[0]!;
    await upload(buyerB, first.id);
    await rejectPayment(w.owner, { paymentId: first.id, reason: 'x' });
    await placeOrder(buyerB, { orderId: id, paymentMethodId: w.methods.wallet });
    const all = await paymentsOfOrder(w, id);
    expect(all.map((p) => [p.status, p.paymentMethodId])).toEqual([
      ['REJECTED', w.methods.bank], ['AWAITING_PROOF', w.methods.wallet],
    ]);
    await upload(buyerB, all[1]!.id);
    await approvePayment(w.owner, { paymentId: all[1]!.id });
    expect(await orderStatusOf(w, id)).toBe('COMPLETED');
  });
});

describe('K2 / D2 — changing method before a receipt; WhatsApp is an attempt like any other', () => {
  let orderId = '';

  it('WhatsApp opens an INITIATED payment and the page still offers the picker', async () => {
    orderId = (await createOrder(buyerC, { productSlugs: [w.products.p2!.slug], buyerCountry: 'SY' })).orderId;
    const init = await placeOrder(buyerC, { orderId, paymentMethodId: w.methods.whatsapp });
    expect(init.kind).toBe('ASSISTED');
    const all = await paymentsOfOrder(w, orderId);
    expect(all.map((p) => p.status)).toEqual(['INITIATED']);
    const view = await checkoutView(buyerC, orderId);
    expect(view!.payment!.status).toBe('INITIATED');
    expect(view!.canChangeMethod).toBe(true);
  });

  it('choosing WhatsApp twice does not open a second payment', async () => {
    await placeOrder(buyerC, { orderId, paymentMethodId: w.methods.whatsapp });
    expect(await paymentsOfOrder(w, orderId)).toHaveLength(1);
  });

  it('switching to the bank cancels the WhatsApp payment and opens one new attempt', async () => {
    await placeOrder(buyerC, { orderId, paymentMethodId: w.methods.bank });
    const all = await paymentsOfOrder(w, orderId);
    expect(all.map((p) => [p.status, p.paymentMethodId])).toEqual([
      ['CANCELLED', w.methods.whatsapp], ['AWAITING_PROOF', w.methods.bank],
    ]);
    expect(await openOf(orderId)).toHaveLength(1);
    const [audit] = await withRawActorContext(w.ownerRaw, (tx) => tx.select({ action: auditLogs.action })
      .from(auditLogs).where(eq(auditLogs.entityId, all[0]!.id)));
    expect(audit?.action).toBe('PAYMENT_CANCELLED');
  });

  it('switching again (the Back button) closes the previous attempt as well', async () => {
    await placeOrder(buyerC, { orderId, paymentMethodId: w.methods.wallet });
    const all = await paymentsOfOrder(w, orderId);
    expect(all.map((p) => p.status)).toEqual(['CANCELLED', 'CANCELLED', 'AWAITING_PROOF']);
  });

  it('a double-click on the same method opens nothing new', async () => {
    await Promise.all([
      placeOrder(buyerC, { orderId, paymentMethodId: w.methods.wallet }),
      placeOrder(buyerC, { orderId, paymentMethodId: w.methods.wallet }),
    ]);
    expect(await openOf(orderId)).toHaveLength(1);
    expect(await paymentsOfOrder(w, orderId)).toHaveLength(3);
  });

  it('after the receipt the method cannot change, and nothing is written', async () => {
    const open = (await openOf(orderId))[0]!;
    await upload(buyerC, open.id);
    const before = await paymentsOfOrder(w, orderId);
    await expect(placeOrder(buyerC, { orderId, paymentMethodId: w.methods.bank }))
      .rejects.toBeInstanceOf(RuleViolationError);
    expect(await paymentsOfOrder(w, orderId)).toEqual(before);
  });

  it('the owner\'s queue shows the saved method name and no closed attempts', async () => {
    const rows = (await verificationQueue(w.owner)).filter((r) => r.orderId === orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.methodName).toBe('محفظة');
  });
});

describe('S7-05 — the database refuses a second open payment on one order', () => {
  it('a direct insert of a second open payment is refused by the unique index', async () => {
    const id = (await createOrder(buyerD, { productSlugs: [w.products.p3!.slug], buyerCountry: 'SY' })).orderId;
    await placeOrder(buyerD, { orderId: id, paymentMethodId: w.methods.bank });
    const [first] = await paymentsOfOrder(w, id);
    await expect(withRawActorContext(w.ownerRaw, (tx) => tx.insert(payments).values({
      orderId: id, paymentMethodId: w.methods.wallet, status: 'AWAITING_PROOF',
      amountMinor: first!.amountMinor, currency: 'USD', idempotencyKey: `${id}:manual`,
      methodNameSnapshot: 'محفظة', requiresProofSnapshot: true,
    }))).rejects.toThrow();
    expect(await openOf(id)).toHaveLength(1);
  });
});
