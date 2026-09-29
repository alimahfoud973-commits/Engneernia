import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { withActor, withRawActorContext } from '@/db/actor-context';
import { closeDb } from '@/db';
import {
  auditLogs, orderEvents, orders, paymentMethods, paymentProofs, payments,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder, rejectPayment } from './orders';
import { submitPaymentProof } from './proofs';
import { checkoutView, verificationQueue } from './queries';
import { createPaymentMethod, updatePaymentMethod } from '@/payments/admin';
import { RuleViolationError, ValidationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';
import {
  buildCommerceWorld, orderStatusOf, paymentsOfOrder, pngBytes, type CommerceWorld,
} from '@/db/testing/commerce-fixtures';

/**
 * ===========================================================================
 * THE PAYMENT ROW DEFENDS ITSELF (Stage 7 — S7-06, S7-07, S7-08, S7-10,
 * S7-11, D3, D9, D10, D11)
 * ===========================================================================
 * A payment had no state machine of its own: only the order's table stood
 * between the owner and approving a REJECTED payment. It now has three:
 * the code's table (`payment-status.ts`), writes that name the status they
 * expect, and a trigger (`payments_transition_guard`, 0066) that refuses an
 * illegal move or a change to what the payment was — even from a superuser.
 *
 * Row-level security on the three tables a buyer writes to during checkout
 * now admits only what checkout writes (D9), and stale open payments left
 * by the old code are closed, never deleted, before the one-open-payment
 * index is built (D10, C-1, C-2).
 * ===========================================================================
 */

let w: CommerceWorld;
let buyerA: Actor, buyerB: Actor;

const upload = (who: Actor, paymentId: string) =>
  submitPaymentProof(who, { paymentId, filename: 'r.png', body: pngBytes(), referenceNote: 'S7' });

async function orderAwaitingProof(buyer: Actor, key: string) {
  const { orderId } = await createOrder(buyer, { productSlugs: [w.products[key]!.slug], buyerCountry: 'SY' });
  await placeOrder(buyer, { orderId, paymentMethodId: w.methods.bank });
  const [payment] = await paymentsOfOrder(w, orderId);
  return { orderId, paymentId: payment!.id };
}

function superuser() {
  const url = process.env.DATABASE_SUPERUSER_URL;
  if (!url) throw new Error('DATABASE_SUPERUSER_URL is required');
  return postgres(url, { max: 1, onnotice: () => {} });
}

beforeAll(async () => {
  const prices: Record<string, bigint> = {};
  for (const k of ['t1', 't2', 't3', 't4', 't5', 'r1', 'r2', 'r3', 'c1', 'c2', 'c3', 'q1', 'd1']) prices[k] = 2500n;
  w = await buildCommerceWorld({ prefix: 's7-guard', buyers: 2, prices });
  [buyerA, buyerB] = w.buyers as [Actor, Actor];
}, 120_000);

afterAll(async () => {
  await w.cleanup();
  await closeDb();
}, 60_000);

describe('S7-06 / D11 — the payment state machine, in code and in the database', () => {
  it('a REJECTED payment cannot be approved, even after the order moved on to a new attempt', async () => {
    const { orderId, paymentId } = await orderAwaitingProof(buyerA, 't1');
    await upload(buyerA, paymentId);
    await rejectPayment(w.owner, { paymentId, reason: 'x' });
    await placeOrder(buyerA, { orderId, paymentMethodId: w.methods.bank });
    await expect(approvePayment(w.owner, { paymentId })).rejects.toBeInstanceOf(RuleViolationError);
    expect((await paymentsOfOrder(w, orderId))[0]!.status).toBe('REJECTED');
    expect(await orderStatusOf(w, orderId)).toBe('AWAITING_PAYMENT');
  });

  it('an APPROVED or CANCELLED payment cannot be rejected', async () => {
    const { orderId, paymentId } = await orderAwaitingProof(buyerA, 't2');
    await upload(buyerA, paymentId);
    await approvePayment(w.owner, { paymentId });
    await expect(rejectPayment(w.owner, { paymentId, reason: 'x' })).rejects.toBeInstanceOf(RuleViolationError);
    const other = await orderAwaitingProof(buyerA, 't3');
    await placeOrder(buyerA, { orderId: other.orderId, paymentMethodId: w.methods.wallet });
    await expect(rejectPayment(w.owner, { paymentId: other.paymentId, reason: 'x' })).rejects.toBeInstanceOf(RuleViolationError);
    expect((await paymentsOfOrder(w, orderId))[0]!.status).toBe('APPROVED');
  });

  it('the legitimate owner moves still pass: INITIATED → APPROVED and AWAITING_PROOF → APPROVED', async () => {
    const wa = await createOrder(buyerB, { productSlugs: [w.products.t4!.slug], buyerCountry: 'SY' });
    await placeOrder(buyerB, { orderId: wa.orderId, paymentMethodId: w.methods.whatsapp });
    const [initiated] = await paymentsOfOrder(w, wa.orderId);
    await approvePayment(w.owner, { paymentId: initiated!.id });
    expect(await orderStatusOf(w, wa.orderId)).toBe('COMPLETED');

    const noReceipt = await orderAwaitingProof(buyerB, 't5');
    await approvePayment(w.owner, { paymentId: noReceipt.paymentId });
    expect(await orderStatusOf(w, noReceipt.orderId)).toBe('COMPLETED');
  });

  it('the trigger refuses illegal moves and changed facts, even from a superuser', async () => {
    const sql0 = superuser();
    try {
      const rows = await sql0`
        SELECT p.id, p.status::text AS status FROM payments p JOIN orders o ON o.id = p.order_id
         WHERE o.customer_id IN ${sql0(w.buyerIds as string[])}`;
      const approved = rows.find((r) => r.status === 'APPROVED')!.id as string;
      const rejected = rows.find((r) => r.status === 'REJECTED')!.id as string;
      const cancelled = rows.find((r) => r.status === 'CANCELLED')!.id as string;
      const open = rows.find((r) => r.status === 'AWAITING_PROOF')!.id as string;
      const refuses = async (q: Promise<unknown>) => {
        await expect(q).rejects.toThrow(/payment/i);
      };
      await refuses(sql0`UPDATE payments SET status = 'APPROVED' WHERE id = ${rejected}::uuid`);
      await refuses(sql0`UPDATE payments SET status = 'REJECTED' WHERE id = ${approved}::uuid`);
      await refuses(sql0`UPDATE payments SET status = 'APPROVED' WHERE id = ${cancelled}::uuid`);
      await refuses(sql0`UPDATE payments SET status = 'AWAITING_PROOF' WHERE id = ${cancelled}::uuid`);
      await refuses(sql0`UPDATE payments SET rejected_reason = 'rewritten' WHERE id = ${rejected}::uuid`);
      await refuses(sql0`UPDATE payments SET amount_minor = 1 WHERE id = ${open}::uuid`);
      await refuses(sql0`UPDATE payments SET currency = 'EUR' WHERE id = ${open}::uuid`);
      await refuses(sql0`UPDATE payments SET method_name_snapshot = 'x' WHERE id = ${open}::uuid`);
      await refuses(sql0`UPDATE payments SET payment_method_id = ${w.methods.wallet}::uuid WHERE id = ${open}::uuid`);
      const [someOrder] = await sql0`SELECT id FROM orders WHERE customer_id = ${w.buyerIds[1]!}::uuid LIMIT 1`;
      await refuses(sql0`UPDATE payments SET order_id = ${someOrder!.id}::uuid WHERE id = ${open}::uuid`);
    } finally {
      await sql0.end({ timeout: 5 });
    }
  });
});

describe('D9 — row-level security admits only what checkout writes', () => {
  it('payments_insert: a buyer cannot tamper with amount, currency, status, approver or order state', async () => {
    const { orderId } = await createOrder(buyerA, { productSlugs: [w.products.r1!.slug], buyerCountry: 'SY' });
    const valid = {
      orderId, paymentMethodId: w.methods.bank, status: 'AWAITING_PROOF' as const, amountMinor: 2500n,
      currency: 'USD', methodNameSnapshot: 'تحويل بنكي', requiresProofSnapshot: true,
    };
    const insert = (values: Record<string, unknown>) =>
      withActor(buyerA, (tx) => tx.insert(payments).values({ ...valid, idempotencyKey: randomUUID(), ...values } as typeof payments.$inferInsert));
    await expect(insert({ amountMinor: 1n })).rejects.toThrow();
    await expect(insert({ currency: 'EUR' })).rejects.toThrow();
    await expect(insert({ status: 'APPROVED' })).rejects.toThrow();
    await expect(insert({ approvedBy: w.buyerIds[0]!, approvedAt: new Date() })).rejects.toThrow();
    await expect(insert({ providerRef: 'X1' })).rejects.toThrow();
    expect(await paymentsOfOrder(w, orderId)).toHaveLength(0);
    // What checkout itself writes still passes.
    await insert({});
    expect(await paymentsOfOrder(w, orderId)).toHaveLength(1);
  });

  it("payments_insert: nothing on another buyer's order, nor on a settled one", async () => {
    const { orderId, paymentId } = await orderAwaitingProof(buyerB, 'r2');
    await expect(withActor(buyerA, (tx) => tx.insert(payments).values({
      orderId, paymentMethodId: w.methods.bank, status: 'AWAITING_PROOF', amountMinor: 2500n, currency: 'USD',
      methodNameSnapshot: 'x', requiresProofSnapshot: true, idempotencyKey: randomUUID(),
    }))).rejects.toThrow();
    await upload(buyerB, paymentId);
    await approvePayment(w.owner, { paymentId });
    await expect(withActor(buyerB, (tx) => tx.insert(payments).values({
      orderId, paymentMethodId: w.methods.bank, status: 'AWAITING_PROOF', amountMinor: 2500n, currency: 'USD',
      methodNameSnapshot: 'x', requiresProofSnapshot: true, idempotencyKey: randomUUID(),
    }))).rejects.toThrow();
  });

  it("payment_proofs_insert: no receipt row on another buyer's payment, nor on one past its receipt", async () => {
    const { paymentId } = await orderAwaitingProof(buyerB, 'r3');
    const proof = (who: Actor, pid: string) => withActor(who, (tx) => tx.insert(paymentProofs).values({
      paymentId: pid, storageKey: `proof/00/${randomUUID()}`, contentType: 'image/png', byteSize: 1n,
      submittedBy: (who as { userId: string }).userId,
    }));
    await expect(proof(buyerA, paymentId)).rejects.toThrow();
    await upload(buyerB, paymentId);
    await expect(proof(buyerB, paymentId)).rejects.toThrow();
    const rows = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(paymentProofs).where(eq(paymentProofs.paymentId, paymentId)));
    expect(rows).toHaveLength(1);
  });

  it("order_events_insert: no event on another buyer's order, and no forged actor on one's own", async () => {
    const [bOrder] = await withRawActorContext(w.ownerRaw, (tx) => tx.select({ id: orders.id }).from(orders)
      .where(eq(orders.customerId, w.buyerIds[1]!)).limit(1));
    const [aOrder] = await withRawActorContext(w.ownerRaw, (tx) => tx.select({ id: orders.id }).from(orders)
      .where(eq(orders.customerId, w.buyerIds[0]!)).limit(1));
    const event = (who: Actor, orderId: string, actorUserId: string | null) =>
      withActor(who, (tx) => tx.insert(orderEvents).values({ orderId, toStatus: 'CANCELLED', actorUserId, note: 'forged' }));
    await expect(event(buyerA, bOrder!.id, w.buyerIds[0]!)).rejects.toThrow();
    await expect(event(buyerA, aOrder!.id, w.buyerIds[1]!)).rejects.toThrow();
    const forged = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(orderEvents)
      .where(and(eq(orderEvents.note, 'forged'), inArray(orderEvents.orderId, [aOrder!.id, bOrder!.id]))));
    expect(forged).toHaveLength(0);
  });

  it('another buyer reads neither the payment, the receipt nor the rejection reason', async () => {
    const { orderId, paymentId } = await orderAwaitingProof(buyerA, 'c1');
    await upload(buyerA, paymentId);
    await rejectPayment(w.owner, { paymentId, reason: 'سبب خاص' });
    expect(await checkoutView(buyerB, orderId)).toBeNull();
    const seen = await withActor(buyerB, async (tx) => ({
      payments: await tx.select().from(payments).where(eq(payments.id, paymentId)),
      proofs: await tx.select().from(paymentProofs).where(eq(paymentProofs.paymentId, paymentId)),
    }));
    expect(seen).toEqual({ payments: [], proofs: [] });
    expect((await checkoutView(buyerA, orderId))!.lastRejection?.reason).toBe('سبب خاص');
  });
});

describe('S7-07 / S7-08 — what the receipt and the audit trail record', () => {
  it('an upload is audited as PAYMENT_PROOF_SUBMITTED, not as an approval', async () => {
    const { paymentId } = await orderAwaitingProof(buyerB, 'c2');
    await upload(buyerB, paymentId);
    const [proof] = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(paymentProofs).where(eq(paymentProofs.paymentId, paymentId)));
    const actions = await withRawActorContext(w.ownerRaw, (tx) => tx.select({ action: auditLogs.action })
      .from(auditLogs).where(eq(auditLogs.entityId, proof!.id)));
    expect(actions.map((a) => a.action)).toEqual(['PAYMENT_PROOF_SUBMITTED']);
  });

  it('rejection and approval write the decision and the reviewer onto the receipt', async () => {
    const [proofC1] = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(paymentProofs)
      .innerJoin(payments, eq(payments.id, paymentProofs.paymentId))
      .where(and(eq(payments.status, 'REJECTED'), eq(paymentProofs.submittedBy, w.buyerIds[0]!), eq(payments.rejectedReason, 'سبب خاص'))));
    expect(proofC1!.payment_proofs).toMatchObject({ decision: 'REJECTED', reviewedBy: w.owner.kind === 'USER' ? w.owner.userId : '', rejectionReason: 'سبب خاص' });
    expect(proofC1!.payment_proofs.reviewedAt).toBeInstanceOf(Date);

    const { paymentId } = await orderAwaitingProof(buyerB, 'c3');
    await upload(buyerB, paymentId);
    await approvePayment(w.owner, { paymentId });
    const [proof] = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(paymentProofs).where(eq(paymentProofs.paymentId, paymentId)));
    expect(proof).toMatchObject({ decision: 'APPROVED', rejectionReason: null });
    expect(proof!.reviewedAt).toBeInstanceOf(Date);
  });
});

describe('S7-11 — the owner\'s queue shows the method the buyer chose', () => {
  it('renaming the method later does not rename it in the queue', async () => {
    const { orderId } = await orderAwaitingProof(buyerA, 'q1');
    const [method] = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(paymentMethods).where(eq(paymentMethods.id, w.methods.bank)));
    await updatePaymentMethod(w.owner, w.methods.bank, {
      displayNameAr: 'اسم جديد', displayNameEn: null, descriptionAr: null, instructionsAr: method!.instructionsAr,
      accountDetailsAr: method!.accountDetailsAr, supportMessageAr: null, requiresProof: true,
      countries: [], currencies: ['USD'], sortOrder: 1,
    });
    const row = (await verificationQueue(w.owner)).find((r) => r.orderId === orderId);
    expect(row!.methodName).toBe('تحويل بنكي');
  });
});

describe('D3 — a manual method always asks for a receipt', () => {
  const fields = {
    displayNameEn: null, descriptionAr: null, instructionsAr: 'حوّل', accountDetailsAr: 'IBAN',
    supportMessageAr: null, countries: [], currencies: ['USD'], sortOrder: 5,
  };

  it('creating a manual method without a receipt is refused, and nothing is written', async () => {
    const code = `${w.suffix}-noproof`.toLowerCase();
    await expect(createPaymentMethod(w.owner, {
      ...fields, code, type: 'MANUAL', isActive: true, displayNameAr: 'بلا إيصال', requiresProof: false,
    })).rejects.toBeInstanceOf(ValidationError);
    const rows = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(paymentMethods).where(eq(paymentMethods.code, code)));
    expect(rows).toHaveLength(0);
  });

  it('turning the receipt off on a manual method is refused, and the method is unchanged', async () => {
    const [before] = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(paymentMethods).where(eq(paymentMethods.id, w.methods.wallet)));
    await expect(updatePaymentMethod(w.owner, w.methods.wallet, {
      ...fields, displayNameAr: before!.displayNameAr, instructionsAr: before!.instructionsAr,
      accountDetailsAr: before!.accountDetailsAr, sortOrder: before!.sortOrder, requiresProof: false,
    })).rejects.toBeInstanceOf(ValidationError);
    const [after] = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(paymentMethods).where(eq(paymentMethods.id, w.methods.wallet)));
    expect(after).toEqual(before);
  });

  it('WhatsApp assistance may still go without one', async () => {
    const [before] = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(paymentMethods).where(eq(paymentMethods.id, w.methods.whatsapp)));
    await updatePaymentMethod(w.owner, w.methods.whatsapp, {
      ...fields, displayNameAr: before!.displayNameAr, instructionsAr: before!.instructionsAr,
      accountDetailsAr: null, currencies: [], sortOrder: before!.sortOrder, requiresProof: false,
    });
  });
});

describe('D10 — stale open payments are closed, never deleted, before the index', () => {
  it('keeps the one with a receipt, then the newest; closes those on settled orders; runs clean twice', async () => {
    const x = await orderAwaitingProof(buyerA, 'd1');
    await upload(buyerA, x.paymentId);
    const sql0 = superuser();
    const ROLLBACK = new Error('rollback');
    try {
      await sql0.begin(async (t) => {
        await t`DROP INDEX payments_one_open_per_order`;
        const insertOpen = async (orderId: string, status: string, offsetSeconds: number) => (await t`
          INSERT INTO payments (order_id, payment_method_id, status, amount_minor, currency, idempotency_key,
                                method_name_snapshot, requires_proof_snapshot, created_at)
          VALUES (${orderId}::uuid, ${w.methods.bank}::uuid, ${status}::payment_status, 2500, 'USD', ${randomUUID()},
                  'تحويل بنكي', true, now() + make_interval(secs => ${offsetSeconds}))
          RETURNING id`)[0]!.id as string;

        // X: an older payment WITH a receipt, and a newer empty one (the Back button).
        const xNewer = await insertOpen(x.orderId, 'AWAITING_PROOF', 60);
        // Y: three empty attempts. Receipt-less ones rank AWAITING_PROOF
        // before INITIATED, then newest first: yB stays, yA and yC close.
        const [yOrder] = await t`SELECT o.id FROM orders o WHERE o.customer_id = ${w.buyerIds[1]!}::uuid AND o.status = 'COMPLETED' LIMIT 1`;
        const [yDraft] = await t`
          INSERT INTO orders (order_number, customer_id, status, currency, subtotal_minor, discount_minor, total_minor)
          VALUES (${`S7-D10-${Date.now()}`}, ${w.buyerIds[1]!}::uuid, 'AWAITING_PAYMENT', 'USD', 2500, 0, 2500) RETURNING id`;
        const yA = await insertOpen(yDraft!.id as string, 'AWAITING_PROOF', 0);
        const yB = await insertOpen(yDraft!.id as string, 'AWAITING_PROOF', 30);
        const yC = await insertOpen(yDraft!.id as string, 'INITIATED', 60);
        // Z: an open payment left on a settled order.
        const zOpen = await insertOpen(yOrder!.id as string, 'AWAITING_PROOF', 0);
        const terminalBefore = await t`SELECT id, status::text, updated_at FROM payments WHERE status IN ('APPROVED','REJECTED','CANCELLED') ORDER BY id`;

        const [first] = await t`SELECT app_close_stale_open_payments() AS n`;
        expect(first!.n).toBeGreaterThanOrEqual(4);
        const status = async (id: string) => (await t`SELECT status::text AS s FROM payments WHERE id = ${id}::uuid`)[0]!.s;
        expect(await status(x.paymentId)).toBe('PROOF_SUBMITTED');
        expect(await status(xNewer)).toBe('CANCELLED');
        expect(await status(yB)).toBe('AWAITING_PROOF');
        expect(await status(yA)).toBe('CANCELLED');
        expect(await status(yC)).toBe('CANCELLED');
        expect(await status(zOpen)).toBe('CANCELLED');
        const events = await t`SELECT note FROM order_events WHERE note LIKE '0066:%' AND order_id IN (${x.orderId}::uuid, ${yDraft!.id}::uuid, ${yOrder!.id}::uuid)`;
        expect(events).toHaveLength(4);
        const terminalAfter = await t`SELECT id, status::text, updated_at FROM payments
                                       WHERE id IN ${t(terminalBefore.map((r) => r.id as string))} ORDER BY id`;
        expect([...terminalAfter]).toEqual([...terminalBefore]);
        const [second] = await t`SELECT app_close_stale_open_payments() AS n`;
        expect(second!.n).toBe(0);
        await t`CREATE UNIQUE INDEX payments_one_open_per_order ON payments (order_id)
                 WHERE status IN ('INITIATED', 'AWAITING_PROOF', 'PROOF_SUBMITTED')`;
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    } finally {
      await sql0.end({ timeout: 5 });
    }
    expect((await paymentsOfOrder(w, x.orderId)).map((p) => p.status)).toEqual(['PROOF_SUBMITTED']);
  });
});
