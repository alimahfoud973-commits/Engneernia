import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withActor, withRawActorContext } from '@/db/actor-context';
import { closeDb } from '@/db';
import { auditLogs, entitlements, notifications, orderEvents, orders } from '@/db/schema';
import { approvePayment, cancelOrder, createOrder, placeOrder, rejectPayment } from './orders';
import { submitPaymentProof } from './proofs';
import { purchaseState } from './queries';
import { NotFoundError, RuleViolationError, ValidationError } from '@/lib/errors';
import { GUEST, type Actor } from '@/authz/actor';
import {
  buildCommerceWorld, orderStatusOf, paymentsOfOrder, pngBytes, type CommerceWorld,
} from '@/db/testing/commerce-fixtures';

/**
 * ===========================================================================
 * AN ORDER CAN BE CANCELLED — BY THE RIGHT PERSON, IN THE RIGHT STATE (K3-A, D4–D6)
 * ===========================================================================
 * The state table always allowed cancellation; nothing performed it, so an
 * order that could not be approved blocked its product for that buyer forever.
 *
 *   buyer:  DRAFT, AWAITING_PAYMENT, PAYMENT_ISSUE
 *   owner:  the same, and PROOF_SUBMITTED, PENDING_VERIFICATION — with a reason
 *   nobody: PAID, COMPLETED, CANCELLED, REFUNDED
 *
 * Open payments close as CANCELLED with the order; a REJECTED payment stays
 * as it was. No refund, no ledger movement — none exists to make (D5). The
 * owner's cancellation is audited and the buyer is told (D6).
 * ===========================================================================
 */

let w: CommerceWorld;
let buyer: Actor, other: Actor;

const upload = (who: Actor, paymentId: string) =>
  submitPaymentProof(who, { paymentId, filename: 'r.png', body: pngBytes() });

/** A fresh order of `buyer`'s on product `key`, taken to `stage`. */
async function orderAt(key: string, stage: 'DRAFT' | 'AWAITING_PAYMENT' | 'PROOF_SUBMITTED' | 'PAYMENT_ISSUE') {
  const orderId = (await createOrder(buyer, { productSlugs: [w.products[key]!.slug], buyerCountry: 'SY' })).orderId;
  if (stage === 'DRAFT') return orderId;
  await placeOrder(buyer, { orderId, paymentMethodId: w.methods.bank });
  if (stage === 'AWAITING_PAYMENT') return orderId;
  const [payment] = await paymentsOfOrder(w, orderId);
  await upload(buyer, payment!.id);
  if (stage === 'PROOF_SUBMITTED') return orderId;
  await rejectPayment(w.owner, { paymentId: payment!.id, reason: 'مرفوض' });
  return orderId;
}

/** A state no path in the application reaches yet: set directly, as a fixture. */
async function forceStatus(orderId: string, status: 'PENDING_VERIFICATION' | 'REFUNDED') {
  await withRawActorContext(w.ownerRaw, (tx) => tx.update(orders).set({ status }).where(eq(orders.id, orderId)));
}

async function cancelAndReset(orderId: string) {
  await cancelOrder(w.owner, { orderId, reason: 'تنظيف' });
}

beforeAll(async () => {
  w = await buildCommerceWorld({
    prefix: 's7-can', buyers: 2,
    prices: { a: 2500n, b: 2500n, c: 2500n, d: 2500n, e: 2500n, f: 2500n, g: 2500n },
  });
  [buyer, other] = w.buyers as [Actor, Actor];
}, 120_000);

afterAll(async () => {
  await w.cleanup();
  await closeDb();
}, 60_000);

describe('the buyer cancels their own order', () => {
  it('from DRAFT: cancelled, with an event, and the product can be bought again', async () => {
    const orderId = await orderAt('a', 'DRAFT');
    expect(await purchaseState(buyer, w.products.a!.id)).toMatchObject({ kind: 'IN_ORDER' });
    await cancelOrder(buyer, { orderId });
    expect(await orderStatusOf(w, orderId)).toBe('CANCELLED');
    const events = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(orderEvents)
      .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.toStatus, 'CANCELLED'))));
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBe(w.buyerIds[0]);
    expect(await purchaseState(buyer, w.products.a!.id)).toEqual({ kind: 'BUYABLE' });
    const again = await createOrder(buyer, { productSlugs: [w.products.a!.slug], buyerCountry: 'SY' });
    expect(await orderStatusOf(w, again.orderId)).toBe('DRAFT');
    await cancelOrder(buyer, { orderId: again.orderId });
  });

  it('from AWAITING_PAYMENT: the open payment closes as CANCELLED', async () => {
    const orderId = await orderAt('b', 'AWAITING_PAYMENT');
    await cancelOrder(buyer, { orderId });
    expect((await paymentsOfOrder(w, orderId)).map((p) => p.status)).toEqual(['CANCELLED']);
    expect(await orderStatusOf(w, orderId)).toBe('CANCELLED');
  });

  it('from PAYMENT_ISSUE: the rejected payment stays exactly as it was', async () => {
    const orderId = await orderAt('c', 'PAYMENT_ISSUE');
    const [rejected] = await paymentsOfOrder(w, orderId);
    await cancelOrder(buyer, { orderId });
    expect(await paymentsOfOrder(w, orderId)).toEqual([rejected]);
    expect(await orderStatusOf(w, orderId)).toBe('CANCELLED');
  });

  it('refused from PROOF_SUBMITTED and PENDING_VERIFICATION — nothing changes', async () => {
    const orderId = await orderAt('d', 'PROOF_SUBMITTED');
    const before = await paymentsOfOrder(w, orderId);
    await expect(cancelOrder(buyer, { orderId })).rejects.toBeInstanceOf(RuleViolationError);
    await forceStatus(orderId, 'PENDING_VERIFICATION');
    await expect(cancelOrder(buyer, { orderId })).rejects.toBeInstanceOf(RuleViolationError);
    expect(await paymentsOfOrder(w, orderId)).toEqual(before);
    expect(await orderStatusOf(w, orderId)).toBe('PENDING_VERIFICATION');
    await cancelAndReset(orderId);
  });

  it("another buyer cannot cancel it: not found, and no trace", async () => {
    const orderId = await orderAt('e', 'AWAITING_PAYMENT');
    await expect(cancelOrder(other, { orderId })).rejects.toBeInstanceOf(NotFoundError);
    expect(await orderStatusOf(w, orderId)).toBe('AWAITING_PAYMENT');
    expect((await paymentsOfOrder(w, orderId)).map((p) => p.status)).toEqual(['AWAITING_PROOF']);
    await cancelOrder(buyer, { orderId });
  });

  it('a guest cannot cancel anything', async () => {
    const orderId = await orderAt('e', 'DRAFT');
    await expect(cancelOrder(GUEST, { orderId })).rejects.toThrow();
    expect(await orderStatusOf(w, orderId)).toBe('DRAFT');
    await cancelOrder(buyer, { orderId });
  });
});

describe('the owner cancels, with a reason, and the buyer is told', () => {
  it('a reason is required', async () => {
    const orderId = await orderAt('f', 'PROOF_SUBMITTED');
    await expect(cancelOrder(w.owner, { orderId })).rejects.toBeInstanceOf(ValidationError);
    await expect(cancelOrder(w.owner, { orderId, reason: '   ' })).rejects.toBeInstanceOf(ValidationError);
    expect(await orderStatusOf(w, orderId)).toBe('PROOF_SUBMITTED');
  });

  it('from PROOF_SUBMITTED: payment CANCELLED, event and audit carry the reason, the buyer is notified without amounts', async () => {
    const [row] = await withRawActorContext(w.ownerRaw, (tx) => tx.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.customerId, w.buyerIds[0]!), eq(orders.status, 'PROOF_SUBMITTED'))));
    const orderId = row!.id;
    await cancelOrder(w.owner, { orderId, reason: 'لم يصل المبلغ' });
    expect(await orderStatusOf(w, orderId)).toBe('CANCELLED');
    expect((await paymentsOfOrder(w, orderId)).map((p) => p.status)).toEqual(['CANCELLED']);

    const [event] = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(orderEvents)
      .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.toStatus, 'CANCELLED'))));
    expect(event!.note).toBe('لم يصل المبلغ');
    const [audit] = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(auditLogs)
      .where(and(eq(auditLogs.entityId, orderId), eq(auditLogs.action, 'ORDER_CANCELLED'))));
    expect(audit!.after).toMatchObject({ reason: 'لم يصل المبلغ' });

    const [{ orderNumber }] = await withRawActorContext(w.ownerRaw, (tx) =>
      tx.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, orderId))) as [{ orderNumber: string }];
    const [note] = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(notifications)
      .where(and(
        eq(notifications.userId, w.buyerIds[0]!),
        eq(notifications.type, 'ORDER_CANCELLED'),
        sql`${notifications.payload}->>'orderNumber' = ${orderNumber}`,
      )));
    expect(note).toBeDefined();
    expect(JSON.stringify(note!.payload)).not.toMatch(/Minor|amount|2500|25\.00/);
    expect(note!.payload).toMatchObject({ reason: 'لم يصل المبلغ' });
  });

  it('from PENDING_VERIFICATION, DRAFT, AWAITING_PAYMENT and PAYMENT_ISSUE too', async () => {
    for (const stage of ['DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_ISSUE'] as const) {
      const orderId = await orderAt('g', stage);
      await cancelOrder(w.owner, { orderId, reason: 'اختبار' });
      expect(await orderStatusOf(w, orderId)).toBe('CANCELLED');
    }
    const pending = await orderAt('g', 'PROOF_SUBMITTED');
    await forceStatus(pending, 'PENDING_VERIFICATION');
    await cancelOrder(w.owner, { orderId: pending, reason: 'اختبار' });
    expect(await orderStatusOf(w, pending)).toBe('CANCELLED');
  });
});

describe('nobody cancels a settled, cancelled or refunded order', () => {
  it('COMPLETED: refused for owner and buyer; entitlement, payment and order untouched', async () => {
    // `f`'s earlier order was cancelled by the owner above, so it can be bought.
    const orderId = await orderAt('f', 'DRAFT');
    await placeOrder(buyer, { orderId, paymentMethodId: w.methods.bank });
    const [payment] = await paymentsOfOrder(w, orderId);
    await upload(buyer, payment!.id);
    await approvePayment(w.owner, { paymentId: payment!.id });
    const before = await paymentsOfOrder(w, orderId);
    await expect(cancelOrder(w.owner, { orderId, reason: 'x' })).rejects.toBeInstanceOf(RuleViolationError);
    await expect(cancelOrder(buyer, { orderId })).rejects.toThrow();
    expect(await orderStatusOf(w, orderId)).toBe('COMPLETED');
    expect(await paymentsOfOrder(w, orderId)).toEqual(before);
    const grants = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(entitlements)
      .where(and(eq(entitlements.customerId, w.buyerIds[0]!), eq(entitlements.productId, w.products.f!.id))));
    expect(grants).toHaveLength(1);
  });

  it('CANCELLED and REFUNDED: refused', async () => {
    const orderId = await orderAt('a', 'DRAFT');
    await cancelOrder(buyer, { orderId });
    await expect(cancelOrder(buyer, { orderId })).rejects.toThrow();
    await expect(cancelOrder(w.owner, { orderId, reason: 'x' })).rejects.toBeInstanceOf(RuleViolationError);
    const refunded = await orderAt('a', 'DRAFT');
    await forceStatus(refunded, 'REFUNDED');
    await expect(cancelOrder(w.owner, { orderId: refunded, reason: 'x' })).rejects.toBeInstanceOf(RuleViolationError);
    expect(await orderStatusOf(w, refunded)).toBe('REFUNDED');
  });
});

describe('app_cancel_open_payments — the buyer\'s one narrow way to close a payment', () => {
  const call = (actor: Actor, orderId: string) =>
    withActor(actor, (tx) => tx.execute(sql`SELECT app_cancel_open_payments(${orderId}::uuid) AS n`));

  it("refuses another buyer's order, a guest, and an order past its receipt", async () => {
    const orderId = await orderAt('b', 'PROOF_SUBMITTED');
    await expect(call(other, orderId)).rejects.toThrow();
    await expect(call(GUEST, orderId)).rejects.toThrow();
    await expect(call(buyer, orderId)).rejects.toThrow();
    expect((await paymentsOfOrder(w, orderId)).map((p) => p.status)).toEqual(['PROOF_SUBMITTED']);
    await cancelAndReset(orderId);
  });
});
