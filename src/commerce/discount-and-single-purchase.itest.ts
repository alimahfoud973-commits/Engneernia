import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements, invoices,
  orderItems, orders, paymentMethods, payments, productContributors,
  productPrices, products, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from './orders';
import { purchaseState } from './queries';
import { RuleViolationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * OPEN-1 AND OPEN-11, PROVED AGAINST A REAL DATABASE
 * ===========================================================================
 * Both decisions are enforced in PostgreSQL — a discount that does not
 * reconcile is a CHECK violation, and a second purchase is a trigger and a
 * unique index — so neither can be proved with a mock. The point of every case
 * below is the same: reach past the application layer entirely, write the row
 * the way a buggy code path or a psql prompt would, and watch the database
 * refuse it.
 *
 * The cases run under the OWNER's raw context, which is the most privileged
 * actor this system has. A refusal there is a refusal everywhere.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '',
  buyerA: randomUUID(), buyerB: randomUUID(), buyerC: randomUUID(),
  engineerUser: randomUUID(), contributor: randomUUID(),
  discipline: randomUUID(), product: randomUUID(), second: randomUUID(),
  method: randomUUID(),
};
const slug = `d1-prod-${suffix}`;
const secondSlug = `d1-second-${suffix}`;

/** $100.00. Chosen so the owner's worked example reads in whole cents. */
const PRICE = 10_000n;
const DISCOUNT = 2_000n;   // $20.00 off
const PAID = PRICE - DISCOUNT;

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
const buyerC = asCustomer(ids.buyerC);
const ctxOf = (a: Actor) =>
  a.kind === 'USER' ? { actorId: a.userId, actorRole: a.role } : { actorId: '', actorRole: 'GUEST' };

/**
 * The text of whatever the database raised, or '' if it raised nothing.
 *
 * THE WHOLE CAUSE CHAIN, not just the top message. Drizzle wraps a driver
 * error in a "Failed query: ..." of its own, which contains the SQL and none
 * of the reason — so asserting on the top-level message alone would pass for
 * any failure at all, including the wrong one.
 */
async function rejectionText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      const detail = (current as { detail?: unknown }).detail;
      if (typeof detail === 'string') parts.push(detail);
      const constraint = (current as { constraint_name?: unknown }).constraint_name;
      if (typeof constraint === 'string') parts.push(constraint);
      current = current.cause;
    }
    return parts.join(' | ');
  }
}

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.buyerA, email: `d1-a+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Buyer A', countryCode: 'SY' },
      { id: ids.buyerB, email: `d1-b+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Buyer B', countryCode: 'SY' },
      { id: ids.buyerC, email: `d1-c+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Buyer C', countryCode: 'SY' },
      { id: ids.engineerUser, email: `d1-eng+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `d1-eng-${suffix}`,
      settlementCode: `D1E${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `d1-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 94,
    });
    await tx.insert(products).values([
      { id: ids.product, slug, titleAr: 'دليل الخصم', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
      { id: ids.second, slug: secondSlug, titleAr: 'دليل ثانٍ', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
    ]);
    await tx.insert(productContributors).values([
      { productId: ids.product, contributorId: ids.contributor, shareBp: 10000 },
      { productId: ids.second, contributorId: ids.contributor, shareBp: 10000 },
    ]);
    await tx.insert(productPrices).values([
      { productId: ids.product, amountMinor: PRICE, currency: 'USD' },
      { productId: ids.second, amountMinor: PRICE, currency: 'USD' },
    ]);
    // 80/20 — the owner's worked example on OPEN-1.
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE',
      engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `d1-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل بنكي', instructionsAr: 'حوّل', accountDetailsAr: 'IBAN TEST', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });
}, 120_000);

afterAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    const buyers = [ids.buyerA, ids.buyerB, ids.buyerC];
    await tx.delete(invoices).where(inArray(invoices.customerId, buyers));
    await tx.delete(entitlements).where(inArray(entitlements.customerId, buyers));
    await tx.delete(orders).where(inArray(orders.customerId, buyers));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.delete(productContributors).where(inArray(productContributors.productId, [ids.product, ids.second]));
    await tx.delete(products).where(inArray(products.id, [ids.product, ids.second]));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(inArray(users.id, [...buyers, ids.engineerUser]));
  });
  await closeDb();
}, 60_000);


// ===========================================================================
describe('OPEN-1 — a discounted sale, end to end', () => {
  let orderId = '';

  /**
   * The discount is written onto the DRAFT order as the owner, because nothing
   * in the platform grants one yet (§43 — coupons are not in the first
   * release). That is the whole scope of the decision: the pipeline carries a
   * discount correctly, and whatever creates one later writes these two
   * columns and touches no money code.
   */
  it('splits what was PAID, not what was listed', async () => {
    const order = await createOrder(buyerA, { productSlugs: [slug] });
    orderId = order.orderId;

    await withRawActorContext(OWNER_RAW, async (tx) => {
      await tx.update(orderItems)
        .set({ discountMinor: DISCOUNT })
        .where(eq(orderItems.orderId, orderId));
      await tx.update(orders)
        .set({ discountMinor: DISCOUNT, totalMinor: PRICE - DISCOUNT })
        .where(eq(orders.id, orderId));
    });

    await placeOrder(buyerA, { orderId, paymentMethodId: ids.method });
    const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId)),
    );
    await approvePayment(owner, { paymentId: payment!.id });

    const [item] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    );

    // The owner's worked example: 100 less 20, at 80/20, is 64 and 16.
    expect(item!.unitPriceMinor).toBe(PRICE);
    expect(item!.discountMinor).toBe(DISCOUNT);
    expect(item!.engineerAmountMinor).toBe(6_400n);
    expect(item!.platformAmountMinor).toBe(1_600n);

    // NOT the rejected answers. Stated explicitly so that a future edit
    // switching the commission base fails here by name.
    expect(item!.engineerAmountMinor).not.toBe(8_000n);  // engineer bears it all
    expect(item!.platformAmountMinor).not.toBe(2_000n);  // platform bears it all

    // And the whole equation the database also checks in two halves:
    //   engineer + platform + tax + discount = the list price
    expect(
      item!.engineerAmountMinor! + item!.platformAmountMinor!
      + item!.taxMinor! + item!.discountMinor,
    ).toBe(PRICE);
  });

  it('books the discounted amount, so the ledger balances against what was paid', async () => {
    const lines = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT l.account_code, l.amount_minor::text AS amount
          FROM ledger_lines l
          JOIN ledger_transactions t ON t.id = l.transaction_id
         WHERE t.reference_type = 'order' AND t.reference_id = ${orderId}
      `),
    ) as unknown as Array<{ account_code: string; amount: string }>;

    const cash = lines.find((l) => l.account_code === 'PLATFORM_CASH');
    // The platform received 80, not the 100 nobody paid.
    expect(BigInt(cash!.amount)).toBe(PAID);

    // Double entry: a discounted sale is still a balanced one.
    expect(lines.reduce((total, l) => total + BigInt(l.amount), 0n)).toBe(0n);
  });

  it('issues an invoice that states the list price, the discount and the total', async () => {
    const [invoice] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(invoices).where(eq(invoices.orderId, orderId)),
    );

    expect(invoice!.listMinor).toBe(PRICE);
    expect(invoice!.discountMinor).toBe(DISCOUNT);
    expect(invoice!.grossMinor).toBe(PAID);
    // The document reconciles with itself in both directions.
    expect(invoice!.listMinor - invoice!.discountMinor).toBe(invoice!.grossMinor);
    expect(invoice!.taxMinor + invoice!.netMinor).toBe(invoice!.grossMinor);
  });

  it('freezes the discount with the rest of the snapshot — the owner included', async () => {
    const message = await rejectionText(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.update(orderItems)
          .set({ discountMinor: 0n })
          .where(eq(orderItems.orderId, orderId)),
      ),
    );
    // Editing the discount after the sale would rewrite the commission, since
    // one is computed from the other.
    expect(message).toMatch(/immutable/i);
  });

  it('refuses to change the amounts on a settled order, even as the owner', async () => {
    const message = await rejectionText(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.update(orders).set({ discountMinor: 0n, totalMinor: PRICE }).where(eq(orders.id, orderId)),
      ),
    );
    expect(message).toMatch(/immutable/i);
  });
});

// ===========================================================================
describe('OPEN-1 — the calculation cannot be altered unsafely', () => {
  it('refuses a customer editing the money on their own draft order', async () => {
    const order = await createOrder(buyerB, { productSlugs: [secondSlug] });

    /*
     * RLS on `orders` deliberately LETS a customer update their own draft —
     * that is how an order reaches AWAITING_PAYMENT — and row-level security
     * cannot say "this row, but not these columns of it". So the guard is a
     * trigger, and this is the case that proves it: the customer's own
     * context, their own row, and a discount they awarded themselves.
     */
    const message = await rejectionText(
      withRawActorContext(ctxOf(buyerB), (tx) =>
        tx.update(orders)
          .set({ discountMinor: PRICE - 1n, totalMinor: 1n })
          .where(eq(orders.id, order.orderId)),
      ),
    );
    expect(message).toMatch(/owner/i);

    const [after] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orders).where(eq(orders.id, order.orderId)),
    );
    expect(after!.discountMinor).toBe(0n);
    expect(after!.totalMinor).toBe(PRICE);

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.delete(orders).where(eq(orders.id, order.orderId)),
    );
  });

  it('refuses a discount larger than the price', async () => {
    const order = await createOrder(buyerB, { productSlugs: [secondSlug] });

    const message = await rejectionText(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.update(orderItems)
          .set({ discountMinor: PRICE + 1n })
          .where(eq(orderItems.orderId, order.orderId)),
      ),
    );
    expect(message).toMatch(/order_items_discount_within_price/);

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.delete(orders).where(eq(orders.id, order.orderId)),
    );
  });

  it('refuses an order whose total is not its subtotal less its discount', async () => {
    const order = await createOrder(buyerB, { productSlugs: [secondSlug] });

    // A discount that reduces nothing: the header would say 20 came off while
    // still charging the full price.
    const message = await rejectionText(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.update(orders)
          .set({ discountMinor: DISCOUNT })
          .where(eq(orders.id, order.orderId)),
      ),
    );
    expect(message).toMatch(/orders_amounts_non_negative/);

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.delete(orders).where(eq(orders.id, order.orderId)),
    );
  });

  it('refuses to approve a payment whose line discounts contradict the header', async () => {
    const order = await createOrder(buyerB, { productSlugs: [secondSlug] });

    // The header grants a discount; no line carries it. Both rows are legal on
    // their own — this is the disagreement only the reconciliation catches.
    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(orders)
        .set({ discountMinor: DISCOUNT, totalMinor: PRICE - DISCOUNT })
        .where(eq(orders.id, order.orderId)),
    );

    await placeOrder(buyerB, { orderId: order.orderId, paymentMethodId: ids.method });
    const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)),
    );

    await expect(approvePayment(owner, { paymentId: payment!.id }))
      .rejects.toThrow(RuleViolationError);

    // Nothing was half-done: no invoice, no entitlement, no books.
    const invoiced = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(invoices).where(eq(invoices.orderId, order.orderId)),
    );
    expect(invoiced).toHaveLength(0);

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.delete(orders).where(eq(orders.id, order.orderId)),
    );
  });
});

// ===========================================================================
describe('OPEN-11 — a product is bought once', () => {
  it('refuses a second order for a product the customer already owns', async () => {
    // buyerA bought `slug` in the first describe and holds a live entitlement.
    await expect(createOrder(buyerA, { productSlugs: [slug] }))
      .rejects.toThrow(RuleViolationError);
  });

  it('refuses it in the DATABASE too, not only in the application check', async () => {
    /*
     * The application refusal above is a courtesy — it produces a sentence in
     * Arabic. This is the control: the same insert, written directly as the
     * OWNER, with `assertNotAlreadyBought` nowhere in the path.
     */
    const message = await rejectionText(
      withRawActorContext(OWNER_RAW, async (tx) => {
        const [order] = await tx.insert(orders).values({
          orderNumber: `T-DUP-${suffix}`, customerId: ids.buyerA, status: 'DRAFT',
          currency: 'USD', subtotalMinor: PRICE, discountMinor: 0n, totalMinor: PRICE,
        }).returning({ id: orders.id });

        await tx.insert(orderItems).values({
          orderId: order!.id, productId: ids.product,
          titleSnapshot: 'دليل الخصم', unitPriceMinor: PRICE, currency: 'USD',
        });
      }),
    );
    expect(message).toMatch(/already owns this product/i);
  });

  it('refuses a second LIVE ENTITLEMENT outright, whatever wrote it', async () => {
    /*
     * The last line of defence, and the only one no trigger ordering, policy
     * or future code path can talk its way past. The index this replaced named
     * `order_item_id` as well, which made this exact insert succeed.
     */
    const message = await rejectionText(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.insert(entitlements).values({
          customerId: ids.buyerA, productId: ids.product, orderItemId: null,
        }),
      ),
    );
    expect(message).toMatch(/entitlements_live_unique/);
  });

  it('refuses a second order while the first is still awaiting payment', async () => {
    // The window that an entitlement check alone would miss: payment here is
    // manual, so an unapproved order can sit for a day.
    const first = await createOrder(buyerC, { productSlugs: [slug] });
    await placeOrder(buyerC, { orderId: first.orderId, paymentMethodId: ids.method });

    await expect(createOrder(buyerC, { productSlugs: [slug] }))
      .rejects.toThrow(RuleViolationError);

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.delete(orders).where(eq(orders.id, first.orderId)),
    );
  });

  it('lets the customer buy again after cancelling the order that blocked them', async () => {
    const first = await createOrder(buyerC, { productSlugs: [slug] });

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(orders).set({ status: 'CANCELLED' }).where(eq(orders.id, first.orderId)),
    );

    // A cancelled order is not a purchase in progress, so the way is clear.
    const second = await createOrder(buyerC, { productSlugs: [slug] });
    expect(second.orderId).not.toBe(first.orderId);

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.delete(orders).where(inArray(orders.id, [first.orderId, second.orderId])),
    );
  });

  it('refuses the second of two SIMULTANEOUS orders for the same product', async () => {
    /*
     * The case a read-then-write check cannot pass on its own. Under READ
     * COMMITTED neither transaction sees the other's uncommitted row, so both
     * would find nothing and both would insert — and the buyer would end up
     * paying for two orders the owner can only approve one of.
     *
     * An advisory lock on (buyer, product), taken inside the trigger, makes
     * the second wait for the first to commit and then see it.
     */
    const results = await Promise.allSettled([
      createOrder(buyerC, { productSlugs: [slug] }),
      createOrder(buyerC, { productSlugs: [slug] }),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);

    const orderIds = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: orders.id }).from(orders).where(eq(orders.customerId, ids.buyerC)),
    );
    expect(orderIds).toHaveLength(1);

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.delete(orders).where(eq(orders.customerId, ids.buyerC)),
    );
  });

  it('does not tell the PLATFORM OWNER they own what a customer bought', async () => {
    /*
     * The policy on `entitlements` reads `app_is_owner() OR customer_id =
     * app_actor_id()`. For a customer that narrows to their own rows; for the
     * owner it resolves EVERYONE'S. A `purchaseState` that leaned on RLS alone
     * would therefore tell the owner they personally own every product any
     * customer has ever bought, and offer them a download link for it.
     *
     * buyerA owns `slug` from the first describe in this file.
     */
    expect(await purchaseState(owner, ids.product)).toEqual({ kind: 'BUYABLE' });
    expect(await purchaseState(buyerA, ids.product)).toEqual({ kind: 'OWNED' });
  });

  it('refuses the same product twice inside ONE order', async () => {
    await expect(createOrder(buyerB, { productSlugs: [secondSlug, secondSlug] }))
      .rejects.toThrow(RuleViolationError);
  });
});
