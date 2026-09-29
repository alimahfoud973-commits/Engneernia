import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withRawActorContext } from '@/db/actor-context';
import { closeDb } from '@/db';
import {
  entitlements, invoices, orderItemContributors, orderItems, orders, payments,
  productPrices, products,
} from '@/db/schema';
import { approvePayment, completeFreeOrder, createOrder, placeOrder } from './orders';
import { submitPaymentProof } from './proofs';
import { changeProductPrice } from '@/catalog/products';
import { saveCommissionAgreement } from '@/finance/commissions';
import { RuleViolationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';
import {
  buildCommerceWorld, orderStatusOf, paymentsOfOrder, pngBytes, type CommerceWorld,
} from '@/db/testing/commerce-fixtures';

/**
 * ===========================================================================
 * THE PRICE AGREED WHEN THE ORDER WAS MADE IS THE PRICE (Stage 7 — K3, D7, D8)
 * ===========================================================================
 * Owner decision: an order keeps the price the buyer agreed to. Before Stage 7
 * approval re-read the product's price and refused the sale when it had moved,
 * so a price change during an open order locked that order for good.
 *
 * Now the line's own price is what is taxed, split and booked. The commission
 * agreement and the tax rate are still those in force at approval (D8,
 * unchanged). A free order created while the product was free completes free
 * even if the product has since become paid (D7, option A) — but a NEW order
 * is always priced from today's price, so nothing makes a paid product free.
 * ===========================================================================
 */

let w: CommerceWorld;
let buyerA: Actor, buyerB: Actor, buyerC: Actor;

const upload = (who: Actor, paymentId: string) =>
  submitPaymentProof(who, { paymentId, filename: 'r.png', body: pngBytes() });

async function payAndSubmit(buyer: Actor, slug: string): Promise<{ orderId: string; paymentId: string }> {
  const { orderId } = await createOrder(buyer, { productSlugs: [slug], buyerCountry: 'SY' });
  await placeOrder(buyer, { orderId, paymentMethodId: w.methods.bank });
  const [payment] = await paymentsOfOrder(w, orderId);
  await upload(buyer, payment!.id);
  return { orderId, paymentId: payment!.id };
}

const setPrice = (productId: string, minor: bigint) =>
  changeProductPrice(w.owner, { productId, newAmountMinor: minor, currency: 'USD', reason: 'اختبار' });

async function saleFigures(orderId: string) {
  return withRawActorContext(w.ownerRaw, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    const [line] = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const pays = await tx.select().from(payments).where(eq(payments.orderId, orderId));
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.orderId, orderId));
    const slices = await tx.select().from(orderItemContributors).where(eq(orderItemContributors.orderItemId, line!.id));
    const [ledger] = (await tx.execute(sql`
      SELECT COALESCE(sum(l.amount_minor) FILTER (WHERE l.amount_minor > 0), 0)::bigint AS debits
        FROM ledger_lines l JOIN ledger_transactions t ON t.id = l.transaction_id
       WHERE t.reference_id = ${orderId}::uuid`)) as unknown as Array<{ debits: string }>;
    return { order, line: line!, pays, invoice, slices, ledgerDebits: BigInt(ledger!.debits) };
  });
}

beforeAll(async () => {
  w = await buildCommerceWorld({
    prefix: 's7-price', buyers: 3,
    prices: { pct: 1000n, fixed: 1000n, legacy: 1000n, free: 0n, freeHidden: 0n },
  });
  [buyerA, buyerB, buyerC] = w.buyers as [Actor, Actor, Actor];
  await saveCommissionAgreement(w.owner, {
    contributorId: w.contributorId, productId: w.products.fixed!.id,
    agreement: { model: 'FIXED_BOTH', engineerFixedMinor: 600n, platformFixedMinor: 400n, currency: 'USD' },
  });
}, 120_000);

afterAll(async () => {
  await w.cleanup();
  await closeDb();
}, 60_000);

describe('a paid order keeps its agreed price through approval', () => {
  it('$10 agreed, product moved to $15: approval succeeds and every figure is $10', async () => {
    const { orderId, paymentId } = await payAndSubmit(buyerA, w.products.pct!.slug);
    const [agreedRow] = await withRawActorContext(w.ownerRaw, (tx) => tx.select({ id: productPrices.id })
      .from(productPrices).where(and(eq(productPrices.productId, w.products.pct!.id), isNull(productPrices.effectiveTo))));
    await setPrice(w.products.pct!.id, 1500n);

    await approvePayment(w.owner, { paymentId });
    const f = await saleFigures(orderId);
    expect(f.order!.status).toBe('COMPLETED');
    expect(f.order!.totalMinor).toBe(1000n);
    expect(f.pays.map((p) => p.amountMinor)).toEqual([1000n]);
    expect(f.invoice!.grossMinor).toBe(1000n);
    expect(f.ledgerDebits).toBe(1000n);
    expect(f.line.unitPriceMinor).toBe(1000n);
    expect(f.line.priceRowId).toBe(agreedRow!.id);
    // PERCENTAGE 80% on the agreed price, not on $15.
    const engineer = f.slices.reduce((s, x) => s + x.amountMinor, 0n);
    const platform = f.slices.reduce((s, x) => s + (x.platformAmountMinor ?? 0n), 0n);
    expect(engineer + platform + f.line.taxMinor!).toBe(1000n);
    expect(engineer).toBe(((1000n - f.line.taxMinor!) * 8000n) / 10000n);
    const grants = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(entitlements)
      .where(eq(entitlements.orderItemId, f.line.id)));
    expect(grants).toHaveLength(1);
  });

  it('a new order after the change is priced at $15', async () => {
    const { orderId, totalMinor } = await createOrder(buyerB, { productSlugs: [w.products.pct!.slug], buyerCountry: 'SY' });
    expect(totalMinor).toBe(1500n);
    await placeOrder(buyerB, { orderId, paymentMethodId: w.methods.bank });
    expect((await paymentsOfOrder(w, orderId))[0]!.amountMinor).toBe(1500n);
  });

  it('FIXED_BOTH is split on the agreed price after the product doubles', async () => {
    const { orderId, paymentId } = await payAndSubmit(buyerA, w.products.fixed!.slug);
    await setPrice(w.products.fixed!.id, 2000n);
    await approvePayment(w.owner, { paymentId });
    const f = await saleFigures(orderId);
    expect(f.invoice!.grossMinor).toBe(1000n);
    expect(f.ledgerDebits).toBe(1000n);
    const engineer = f.slices.reduce((s, x) => s + x.amountMinor, 0n);
    const platform = f.slices.reduce((s, x) => s + (x.platformAmountMinor ?? 0n), 0n);
    expect(engineer + platform + f.line.taxMinor!).toBe(1000n);
    expect(f.slices[0]!.commissionModel).toBe('FIXED_BOTH');
  });

  it('an order made before Stage 7 (no price row on the line) finds the row in force when it was made', async () => {
    const { orderId, paymentId } = await payAndSubmit(buyerA, w.products.legacy!.slug);
    const [agreedRow] = await withRawActorContext(w.ownerRaw, (tx) => tx.select({ id: productPrices.id })
      .from(productPrices).where(and(eq(productPrices.productId, w.products.legacy!.id), isNull(productPrices.effectiveTo))));
    await withRawActorContext(w.ownerRaw, (tx) =>
      tx.update(orderItems).set({ priceRowId: null }).where(eq(orderItems.orderId, orderId)));
    await setPrice(w.products.legacy!.id, 1200n);
    await approvePayment(w.owner, { paymentId });
    const f = await saleFigures(orderId);
    expect(f.invoice!.grossMinor).toBe(1000n);
    expect(f.line.priceRowId).toBe(agreedRow!.id);
  });
});

describe('D7 — a free order made while the product was free completes free', () => {
  it('free when ordered, paid now: completes with no payment, invoice or ledger, and grants access', async () => {
    const { orderId, totalMinor } = await createOrder(buyerC, { productSlugs: [w.products.free!.slug], buyerCountry: 'SY' });
    expect(totalMinor).toBe(0n);
    await setPrice(w.products.free!.id, 700n);
    await completeFreeOrder(buyerC, { orderId });
    const f = await saleFigures(orderId);
    expect(f.order!.status).toBe('COMPLETED');
    expect(f.pays).toHaveLength(0);
    expect(f.invoice).toBeUndefined();
    expect(f.ledgerDebits).toBe(0n);
    const grants = await withRawActorContext(w.ownerRaw, (tx) => tx.select().from(entitlements)
      .where(eq(entitlements.orderItemId, f.line.id)));
    expect(grants).toHaveLength(1);
  });

  it('a NEW order after it became paid is paid, and cannot be completed free', async () => {
    const { orderId, totalMinor } = await createOrder(buyerA, { productSlugs: [w.products.free!.slug], buyerCountry: 'SY' });
    expect(totalMinor).toBe(700n);
    await expect(completeFreeOrder(buyerA, { orderId })).rejects.toBeInstanceOf(RuleViolationError);
    expect(await orderStatusOf(w, orderId)).toBe('DRAFT');
  });

  it('a free order whose product is no longer published is still refused', async () => {
    const { orderId } = await createOrder(buyerA, { productSlugs: [w.products.freeHidden!.slug], buyerCountry: 'SY' });
    await withRawActorContext(w.ownerRaw, (tx) =>
      tx.update(products).set({ status: 'UNPUBLISHED' }).where(eq(products.id, w.products.freeHidden!.id)));
    await expect(completeFreeOrder(buyerA, { orderId })).rejects.toBeInstanceOf(RuleViolationError);
    expect(await orderStatusOf(w, orderId)).toBe('DRAFT');
  });
});
