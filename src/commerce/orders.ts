import 'server-only';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  entitlements, orderEvents, orderItemContributors, orderItems, orders,
  paymentProofs, payments, productPrices, products, users,
} from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { notifyContributor, notifyUser } from '@/notifications/notify';
import { isOwner, type Actor } from '@/authz/actor';
import {
  ConflictError, NotFoundError, RuleViolationError, UnauthenticatedError, ValidationError,
} from '@/lib/errors';
import { resolveTermsForSale } from '@/finance/commission-resolver';
import { readTaxPolicy } from '@/finance/tax-policy';
import { issueInvoice } from '@/finance/invoices';
import { postLedgerTransaction } from '@/ledger/post';
import { saleEntry, type ContributorShare } from '@/ledger/entries';
import { assertOrderTransition, orderActorOf, type OrderStatus } from './order-status';
import { resolveMethod } from '@/payments/registry';
import type { InitiationResult, PaymentContext } from '@/payments/port';
import { isProviderRefTaken, normalizeProviderRef } from './provider-ref';
import { readUpgradeDiscountBp } from './version-policy';
import { lockOrder } from './order-lock';
import {
  OPEN_PAYMENT_STATUSES, assertPaymentTransition, isOpenPayment, payableFrom, type PaymentStatus,
} from './payment-status';
import { money, percentOf } from '@/lib/money/money';

/**
 * ===========================================================================
 * THE PURCHASE (specification §24, §41)
 * ===========================================================================
 * Every state change goes through one function that records the event, so an
 * order's history is complete by construction rather than by remembering to
 * log. The transition that matters — PAID — does five things in ONE
 * transaction, or none of them.
 * ===========================================================================
 */

function requireUser(actor: Actor): string {
  if (actor.kind !== 'USER') throw new UnauthenticatedError();
  return actor.userId;
}

async function moveOrder(
  tx: Transaction,
  actor: Actor,
  order: { id: string; status: OrderStatus; orderNumber?: string },
  to: OrderStatus,
  note?: string | null,
): Promise<void> {
  assertOrderTransition(order.status, to, orderActorOf(actor));

  const patch: Record<string, unknown> = { status: to, updatedAt: new Date() };
  if (to === 'AWAITING_PAYMENT') patch.placedAt = new Date();
  if (to === 'PAID') patch.paidAt = new Date();
  if (to === 'COMPLETED') patch.completedAt = new Date();

  const updated = await tx
    .update(orders)
    .set(patch)
    // Only from the status the caller saw (Stage 7, S7-04): a decision made on
    // a stale read moves nothing instead of overwriting the one that won.
    .where(and(eq(orders.id, order.id), eq(orders.status, order.status)))
    .returning({ id: orders.id });

  // RLS refuses a write by returning zero rows, not by raising. Without this
  // check an unauthorised — or stale — transition would look like a success.
  if (updated.length === 0) {
    throw new RuleViolationError('لم يُطبَّق تغيير حالة الطلب', { orderId: order.id, to });
  }

  await tx.insert(orderEvents).values({
    orderId: order.id,
    // Denormalised: the event outlives the order row, and a bare uuid in a
    // support conversation is useless.
    orderNumber: order.orderNumber ?? null,
    fromStatus: order.status,
    toStatus: to,
    actorUserId: actor.kind === 'USER' ? actor.userId : null,
    note: note ?? null,
  });
}

/**
 * The price row an order line was priced from, for a line written before
 * Stage 7 recorded it: the row with the same amount and currency that was in
 * force when the order was made. Null if none matches — the line's own price
 * still stands (K3); only the pointer to its catalogue row is missing.
 */
async function priceRowAt(
  tx: Transaction,
  line: { productId: string; unitPriceMinor: bigint; currency: string },
  madeAt: Date,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: productPrices.id })
    .from(productPrices)
    .where(and(
      eq(productPrices.productId, line.productId),
      eq(productPrices.amountMinor, line.unitPriceMinor),
      eq(productPrices.currency, line.currency),
      lte(productPrices.effectiveFrom, madeAt),
      or(isNull(productPrices.effectiveTo), gt(productPrices.effectiveTo, madeAt)),
    ))
    .orderBy(desc(productPrices.effectiveFrom))
    .limit(1);
  return row?.id ?? null;
}

/**
 * ===========================================================================
 * A PRODUCT IS BOUGHT ONCE (owner decision on OPEN-11)
 * ===========================================================================
 * What is sold here is ONE VERSION of a file and a six-month right to
 * download it (Stage 4 repair, migration 0059). A second purchase of the same
 * version buys the buyer nothing they do not already have,
 * so it is not a sale — it is a mistake that happens to take money, and the
 * platform has no refund with which to undo it (owner decision, §7 revoked).
 *
 * TWO CONDITIONS, BECAUSE A PURCHASE IS NOT INSTANT. Payment here is manual:
 * an order can sit awaiting the owner's approval for a day. Checking only for
 * an entitlement would let a buyer place a second order in that window and pay
 * twice before the first was approved — and both approvals would look
 * perfectly legitimate to everything downstream.
 *
 *   1. a live entitlement — they already own it;
 *   2. an order line on any order of theirs that is not CANCELLED — they are
 *      already in the middle of buying it.
 *
 * THIS IS NOT THE CONTROL. The refusal that cannot be forgotten is in the
 * database: a trigger on `order_items` and a partial unique index on
 * `entitlements` (migration 0048). This runs first only so that a person gets
 * a sentence in Arabic instead of a constraint violation.
 *
 * A REVOKED entitlement does not count as owning. Nothing revokes one today —
 * there are no refunds — but if the owner ever takes access away, taking away
 * the ability to buy it again with it would be a second punishment nobody
 * decided on.
 * ===========================================================================
 */
interface SaleRow {
  readonly id: string;
  readonly titleAr: string;
  readonly currentVersionId: string;
}

/**
 * Bought once PER VERSION (Stage 4 repair, owner decision): the version on
 * sale may be bought by anyone who does not already hold it or have a live
 * order for it. Returns the products on which this buyer holds an EARLIER
 * version — those lines are sold as an upgrade. The offer has no time limit
 * (owner decision): an expired window still proves the earlier purchase.
 */
async function assertNotAlreadyBought(
  tx: Transaction,
  customerId: string,
  rows: readonly SaleRow[],
): Promise<Set<string>> {
  const productIds = rows.map((row) => row.id);
  const titleOf = (productId: string) =>
    rows.find((row) => row.id === productId)?.titleAr ?? 'هذا المنتج';
  const currentOf = (productId: string) => rows.find((row) => row.id === productId)?.currentVersionId;

  const held = await tx
    .select({ productId: entitlements.productId, versionId: entitlements.versionId })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.customerId, customerId),
        inArray(entitlements.productId, productIds),
        isNull(entitlements.revokedAt),
      ),
    );

  const owned = held.find((h) => h.versionId !== null && h.versionId === currentOf(h.productId));
  if (owned) {
    throw new RuleViolationError(
      `«${titleOf(owned.productId)}» بإصداره الحالي ضمن مشترياتك بالفعل — يمكنك تنزيله من صفحة مشترياتي.`,
      { productId: owned.productId },
    );
  }

  /*
   * A live order on the product blocks a second one whatever version it
   * names: one still waiting for payment, or any order on the version on
   * sale. A COMPLETED order on an earlier version is the purchase that makes
   * this one an upgrade, not a reason to refuse it.
   */
  const pending = await tx
    .select({ productId: orderItems.productId, orderId: orders.id, versionId: orderItems.versionId, status: orders.status })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orders.customerId, customerId),
        inArray(orderItems.productId, productIds),
        ne(orders.status, 'CANCELLED'),
      ),
    );
  const blocking = pending.find((line) =>
    line.status !== 'COMPLETED'
    || line.versionId === null
    || line.versionId === currentOf(line.productId));

  if (blocking) {
    throw new RuleViolationError(
      `لديك طلب قائم على «${titleOf(blocking.productId)}» — أكمِل ذلك الطلب أو ألغِه قبل إنشاء طلب جديد.`,
      { productId: blocking.productId, orderId: blocking.orderId },
    );
  }

  return new Set(held.map((h) => h.productId));
}

/** Build a draft order from a set of products, priced at today's price. */
export async function createOrder(
  actor: Actor,
  input: { productSlugs: readonly string[]; buyerCountry?: string | null },
): Promise<{ orderId: string; orderNumber: string; totalMinor: bigint; currency: string }> {
  const customerId = requireUser(actor);

  if (input.productSlugs.length === 0) {
    throw new RuleViolationError('لا يمكن إنشاء طلب بلا منتجات');
  }

  // The same product twice in one order is the same mistake as buying it
  // twice in two orders (OPEN-11), and it is worth its own sentence: without
  // this the duplicate is caught further down by a row count that does not
  // match, and reported as "one of the products is unavailable".
  if (new Set(input.productSlugs).size !== input.productSlugs.length) {
    throw new RuleViolationError('لا يمكن إضافة المنتج نفسه أكثر من مرة إلى الطلب');
  }

  return withActor(actor, async (tx) => {
    const rows = await tx
      .select({
        id: products.id,
        slug: products.slug,
        titleAr: products.titleAr,
        status: products.status,
        currency: products.currency,
        currentVersionId: products.currentVersionId,
        priceMinor: productPrices.amountMinor,
        priceCurrency: productPrices.currency,
        priceRowId: productPrices.id,
      })
      .from(products)
      .leftJoin(
        productPrices,
        and(eq(productPrices.productId, products.id), isNull(productPrices.effectiveTo)),
      )
      .where(and(
        inArray(products.slug, [...input.productSlugs]),
        /*
         * Stated here, not left to RLS: since migration 0059 a buyer can SEE
         * an unpublished product they hold (to keep downloading it for six
         * months), and seeing is not buying. A product on sale also has a
         * version on sale — the one this order will name.
         */
        eq(products.status, 'PUBLISHED'),
        isNotNull(products.currentVersionId),
      ));

    if (rows.length !== input.productSlugs.length) {
      // A missing row means the product does not exist OR is not for sale —
      // indistinguishable, and deliberately so.
      throw new NotFoundError('أحد المنتجات غير متاح للشراء');
    }

    const saleRows = rows.map((row) => ({ ...row, currentVersionId: row.currentVersionId! }));
    const upgrades = await assertNotAlreadyBought(tx, customerId, saleRows);
    const upgradeBp = upgrades.size > 0 ? await readUpgradeDiscountBp(tx) : null;

    const currencies = new Set(rows.map((r) => r.priceCurrency ?? r.currency));
    if (currencies.size > 1) {
      // Mixing currencies in one order would make a single payment ambiguous.
      throw new RuleViolationError('لا يمكن الجمع بين عملات مختلفة في طلب واحد', {
        currencies: [...currencies],
      });
    }
    const currency = [...currencies][0]!;

    let subtotal = 0n;
    let discount = 0n;
    const lines = saleRows.map((row) => {
      if (row.priceMinor === null) {
        throw new RuleViolationError('أحد المنتجات بلا سعر حالي', { slug: row.slug });
      }
      const isUpgrade = upgrades.has(row.id);
      /*
       * The upgrade price (S4-09): the discount is the rounded side,
       * `percentOf` the current price, and what is paid is the remainder
       * (CLAUDE.md rule 3). It rides the per-line discount OPEN-1 built, so
       * commission is taken on the price AFTER it and no money code changes.
       */
      const lineDiscount = isUpgrade
        ? percentOf(money(row.priceMinor, currency), upgradeBp!).amountMinor
        : 0n;
      subtotal += row.priceMinor;
      discount += lineDiscount;
      return { row, isUpgrade, lineDiscount };
    });

    const [numberRow] = (await tx.execute(
      sql`SELECT app_next_order_number() AS number`,
    )) as unknown as Array<{ number: string }>;

    /*
     * The three money columns are three separate statements of fact:
     * `subtotal - discount` is the definition, and the database checks it
     * holds. The only discount the platform grants is the upgrade price
     * (S4-09); coupons and promotions are still §43, not built.
     */

    const [order] = await tx
      .insert(orders)
      .values({
        orderNumber: numberRow!.number,
        customerId,
        status: 'DRAFT',
        currency,
        subtotalMinor: subtotal,
        discountMinor: discount,
        totalMinor: subtotal - discount,
        buyerCountry: input.buyerCountry ?? null,
      })
      .returning({ id: orders.id, orderNumber: orders.orderNumber });

    if (!order) throw new RuleViolationError('تعذّر إنشاء الطلب');

    await insertOrderLines(tx, lines.map(({ row, isUpgrade, lineDiscount }) => ({
        orderId: order.id,
        productId: row.id,
        // Copied now: renaming a product later must not rewrite an old order.
        titleSnapshot: row.titleAr,
        unitPriceMinor: row.priceMinor!,
        discountMinor: lineDiscount,
        currency,
        // The version sold, fixed once written (0059): the buyer is granted
        // THIS file even if another is released before the payment clears.
        versionId: row.currentVersionId,
        isUpgrade,
        // The price row this line was priced from (Stage 7, K3): the price the
        // buyer agreed to, which approval books whatever the product costs by then.
        priceRowId: row.priceRowId,
      })));

    await tx.insert(orderEvents).values({
      orderId: order.id,
      orderNumber: order.orderNumber,
      toStatus: 'DRAFT',
      actorUserId: customerId,
      note: 'تم إنشاء الطلب',
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalMinor: subtotal - discount,
      currency,
    };
  });
}

/**
 * Write the order's lines, translating the one refusal a buyer can meet here.
 *
 * `order_items_credits_active` (migration 0062, owner decision D-05) refuses
 * a line for a product credited to a deactivated engineer. The buyer cannot
 * see who is credited — nor should they — so they are told only that the
 * product cannot be bought right now, and the whole order rolls back.
 */
async function insertOrderLines(
  tx: Transaction,
  values: Array<typeof orderItems.$inferInsert>,
): Promise<void> {
  try {
    await tx.insert(orderItems).values(values);
  } catch (error) {
    if (isInactiveCreditRefusal(error)) {
      throw new RuleViolationError('أحد المنتجات غير متاح للشراء حالياً');
    }
    throw error;
  }
}

/** The write hit `order_items_credits_active` — and only that rule. */
export function isInactiveCreditRefusal(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } })?.cause;
  const direct = error as { code?: string; constraint_name?: string };
  const code = cause?.code ?? direct?.code;
  const constraint = cause?.constraint_name ?? direct?.constraint_name;
  return code === '23514' && constraint === 'order_items_credits_active';
}

/** The order states from which the customer may choose how to pay (W14). */
const PAYMENT_CAN_START: readonly OrderStatus[] = ['DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_ISSUE'];

/**
 * Choose how to pay, and get the instructions or the handoff (§24).
 *
 * EVERY ATTEMPT IS ITS OWN PAYMENT ROW (Stage 7 — K1, K2, D2).
 *
 *   - At most one payment is OPEN at a time (INITIATED, AWAITING_PROOF,
 *     PROOF_SUBMITTED); the index `payments_one_open_per_order` (0066)
 *     refuses a second one however it is written.
 *   - The same method again (a double-click, a refresh, WhatsApp twice) opens
 *     nothing new: the open attempt's instructions or chat link come back.
 *   - Another method before a receipt — WhatsApp included — closes the open
 *     attempt as CANCELLED and opens a new one. After a receipt the order is
 *     PROOF_SUBMITTED and no method can be chosen at all.
 *   - After a rejection there is no open attempt: the next choice, with the
 *     same method or another, is a new row. The rejected one is history.
 *
 * The idempotency key names the attempt (`<order>:attempt:<n>`), counted
 * while the order row is locked, so two requests cannot both be attempt n.
 */
export async function placeOrder(
  actor: Actor,
  input: { orderId: string; paymentMethodId: string },
): Promise<InitiationResult> {
  const customerId = requireUser(actor);

  return withActor(actor, async (tx) => {
    const [seen] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);

    if (!seen) throw new NotFoundError('الطلب غير موجود');

    /*
     * THE CHECKOUT IS THE CUSTOMER'S OWN STEP (Stage 3, W14). Named here, not
     * left to row-level security: the policies on `orders` and `payments`
     * admit the owner to every row — rightly, the owner reads every order —
     * so for the owner RLS alone let this open a payment on a customer's
     * order and move it to AWAITING_PAYMENT. Reading stays; acting as the
     * customer does not. Both checks run before anything is written.
     */
    if (seen.customerId !== customerId) {
      throw new RuleViolationError('إتمام الدفع خطوة صاحب الطلب وحده', { orderId: seen.id });
    }
    // A payment starts only where the order still waits for one — never
    // after a receipt, so the method cannot change once one is uploaded (D2).
    if (!PAYMENT_CAN_START.includes(seen.status)) {
      throw new RuleViolationError('لا يمكن بدء الدفع لطلب في هذه الحالة', { orderId: seen.id, status: seen.status });
    }

    // A free order is taken, never paid for: `completeFreeOrder` below. A
    // payment of zero is refused by the database (payments_amount_positive),
    // and this says why in a sentence before it gets that far.
    if (seen.totalMinor === 0n) {
      throw new RuleViolationError('هذا الطلب مجاني ولا يحتاج إلى دفع');
    }

    // Under the lock, from here on (S7-04). The status is read again: an
    // upload or a cancellation may have landed since the read above.
    const order = await lockOrder(tx, seen.id);
    if (!order || !PAYMENT_CAN_START.includes(order.status)) {
      throw new RuleViolationError('لا يمكن بدء الدفع لطلب في هذه الحالة', { orderId: seen.id });
    }

    const items = await tx
      .select({ title: orderItems.titleSnapshot })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));

    const context: PaymentContext = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountMinor: order.totalMinor,
      currency: order.currency,
      buyerCountry: order.buyerCountry,
      itemTitles: items.map((i) => i.title),
    };

    // Re-resolved server-side. A method the browser still shows but the owner
    // has since disabled is refused here (§22).
    const resolved = await resolveMethod(tx, input.paymentMethodId, context);
    if (!resolved) {
      throw new RuleViolationError('طريقة الدفع غير متاحة لهذا الطلب');
    }

    const attempts = await tx
      .select({ id: payments.id, status: payments.status, paymentMethodId: payments.paymentMethodId })
      .from(payments)
      .where(eq(payments.orderId, order.id));
    const open = attempts.find((attempt) => isOpenPayment(attempt.status));

    if (open && open.paymentMethodId === resolved.config.id) {
      // The same choice again: the open attempt stands, and its handoff is
      // given again — nothing is written.
      return resolved.provider.initiate(resolved.config, context);
    }

    if (open) {
      // A receipt is under review: the owner decides it, the buyer does not
      // replace it (D2). The order's own status normally refuses this first.
      if (open.status === 'PROOF_SUBMITTED') {
        throw new RuleViolationError('لا يمكن تغيير طريقة الدفع بعد رفع الإيصال', { orderId: order.id });
      }
      await closeOpenPayments(tx, actor, order, 'تغيير طريقة الدفع');
    }

    const initiation = await resolved.provider.initiate(resolved.config, context);

    await tx
      .insert(payments)
      .values({
        orderId: order.id,
        paymentMethodId: resolved.config.id,
        status: resolved.config.requiresProof ? 'AWAITING_PROOF' : 'INITIATED',
        amountMinor: order.totalMinor,
        currency: order.currency,
        // One key per attempt, counted under the order lock (K1).
        idempotencyKey: `${order.id}:attempt:${attempts.length + 1}`,
        // What this customer is told to do, kept with their payment: the
        // owner changing or disabling the method later does not rewrite it.
        methodNameSnapshot: resolved.config.displayNameAr,
        instructionsSnapshot: resolved.config.instructionsAr,
        accountDetailsSnapshot: resolved.config.accountDetailsAr,
        requiresProofSnapshot: resolved.config.requiresProof,
      });

    if (order.status === 'DRAFT' || order.status === 'PAYMENT_ISSUE') {
      await moveOrder(tx, actor, order, 'AWAITING_PAYMENT', `طريقة الدفع: ${resolved.config.code}`);
    }

    return initiation;
  });
}

/**
 * Close every open payment of an order as CANCELLED — a changed method or a
 * cancelled order — and audit each one (Stage 7).
 *
 * The owner writes them directly (`payments_update` is theirs). A buyer
 * cannot, and must not be able to write a payment row at all, so theirs go
 * through `app_cancel_open_payments` (0066): only their own order, only while
 * it waits for payment, and only INITIATED or AWAITING_PROOF payments.
 * Rejected and approved payments are never touched.
 */
async function closeOpenPayments(
  tx: Transaction,
  actor: Actor,
  order: { id: string; orderNumber: string },
  why: string,
): Promise<string[]> {
  let closed: string[];
  if (isOwner(actor)) {
    const rows = await tx
      .update(payments)
      .set({ status: 'CANCELLED', updatedAt: new Date() })
      .where(and(
        eq(payments.orderId, order.id),
        inArray(payments.status, [...OPEN_PAYMENT_STATUSES] as PaymentStatus[]),
      ))
      .returning({ id: payments.id });
    closed = rows.map((row) => row.id);
  } else {
    const rows = (await tx.execute(
      sql`SELECT payment_id FROM app_cancel_open_payments(${order.id}::uuid)`,
    )) as unknown as Array<{ payment_id: string }>;
    closed = rows.map((row) => row.payment_id);
  }

  for (const paymentId of closed) {
    await recordAudit(tx, actor, {
      action: 'PAYMENT_CANCELLED',
      entityType: 'payment',
      entityId: paymentId,
      after: { orderId: order.id, orderNumber: order.orderNumber, status: 'CANCELLED', why },
    });
  }
  return closed;
}

/**
 * A FREE PRODUCT, TAKEN (OPEN-12; Stage 2 buyer audit, F1).
 *
 * Completes a zero-value DRAFT order of the caller's own and grants access, in
 * one transaction, through `app_complete_free_order` (migration 0054). No
 * payment, ledger entry, invoice or commission snapshot is written: no money
 * moved. The function proves the order is free now — every line priced at
 * zero, every product published and still free — before it grants anything,
 * and the entitlements it writes are read by the same download gate as a
 * paid one.
 */
export async function completeFreeOrder(
  actor: Actor,
  input: { orderId: string },
): Promise<{ orderId: string; orderNumber: string; entitlementsGranted: number }> {
  requireUser(actor);

  return withActor(actor, async (tx) => {
    let rows: Array<{ order_id: string; order_number: string; entitlements_granted: number }>;
    try {
      rows = (await tx.execute(
        sql`SELECT * FROM app_complete_free_order(${input.orderId}::uuid)`,
      )) as unknown as typeof rows;
    } catch (error) {
      const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code
        ?? (error as { code?: string })?.code;
      // P0002 no_data_found: not the caller's order, or no such order — one
      // answer for both, as everywhere else an order is looked up.
      if (code === 'P0002') throw new NotFoundError('الطلب غير موجود');
      // P0001: the function refused — not a DRAFT, not free, or already paid.
      if (code === 'P0001') {
        throw new RuleViolationError('لا يمكن إتمام هذا الطلب مجاناً', { orderId: input.orderId });
      }
      throw error;
    }

    const row = rows[0];
    if (!row) throw new RuleViolationError('تعذّر إتمام الطلب المجاني');
    return {
      orderId: row.order_id,
      orderNumber: row.order_number,
      entitlementsGranted: Number(row.entitlements_granted),
    };
  });
}

/**
 * THE MOMENT THAT MATTERS (specification §13, §24, §41).
 *
 * Owner-only. In one transaction it:
 *   1. moves the order to PAID;
 *   2. resolves the terms in force and FREEZES them onto each line;
 *   3. freezes how the engineer's side divides between contributors;
 *   4. grants the customer their entitlements;
 *   5. POSTS THE SALE TO THE DOUBLE-ENTRY LEDGER (phase P6);
 *   6. records the audit entry and notifies the people involved.
 *
 * If any step fails, none of them happened. There is no path that grants a
 * download without a snapshot, takes a snapshot without granting access, or
 * completes a sale the books never hear about.
 */
export async function approvePayment(
  actor: Actor,
  input: { paymentId: string; providerRef?: string | null; note?: string | null },
): Promise<{
  orderId: string;
  itemsSettled: number;
  entitlementsGranted: number;
  ledgerTransactionId: string;
}> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('اعتماد الدفع من صلاحية مالك المنصة وحده');
  }

  // Optional, trimmed, and NULL when absent — never '' (W13, provider-ref.ts).
  const providerRef = normalizeProviderRef(input.providerRef);

  return withActor(actor, async (tx) => {
    const { payment, order } = await lockPaymentAndOrder(tx, input.paymentId);

    if (payment.status === 'APPROVED') {
      // Idempotent: approving twice must not settle twice.
      throw new RuleViolationError('هذه الدفعة معتمدة مسبقاً', { paymentId: payment.id });
    }
    // Only an open payment is decided (S7-06): a rejected or cancelled one is
    // history, whatever state its order has moved on to since.
    assertPaymentTransition(payment.status, 'APPROVED');

    const items = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));

    if (items.length === 0) {
      throw new RuleViolationError('الطلب بلا بنود');
    }

    await moveOrder(tx, actor, order, 'PAID', input.note ?? null);

    let entitlementsGranted = 0;
    // Accumulated across every line so ONE order produces one payable line per
    // contributor, rather than one per product. The per-product detail already
    // lives in order_item_contributors; the ledger carries the money.
    const sharesByContributor = new Map<string, bigint>();
    let platformTotal = 0n;
    /** What the customer paid across every line: list less discount. */
    let grossTotal = 0n;
    /** Before any discount — checked against the order's own subtotal. */
    let listTotal = 0n;
    let discountTotal = 0n;
    /** Collected per line, because the rounding happens per line (OPEN-9). */
    let taxTotal = 0n;
    const invoiceLines: Array<{
      title: string; listMinor: bigint; discountMinor: bigint;
      grossMinor: bigint; taxMinor: bigint; netMinor: bigint;
    }> = [];

    /**
     * ONE READ, BEFORE THE LOOP.
     *
     * Every line of one order is taxed at the same rate — the rate in force
     * when the owner approved the payment. Reading it inside the loop would
     * let a settings change land between two lines of the same invoice, and an
     * invoice whose lines disagree about the rate is not a document anyone can
     * defend.
     */
    const { tax: taxPolicy, invoice: invoiceIdentity } = await readTaxPolicy(tx);

    for (const item of items) {
      if (item.snapshotTakenAt !== null) {
        throw new RuleViolationError('هذا البند يحمل لقطة مالية مسبقاً', { itemId: item.id });
      }

      const terms = await resolveTermsForSale(
        tx,
        item.productId,
        /*
         * THE PRICE THE BUYER AGREED TO (Stage 7, K3): the line's own price,
         * never the product's price today. A price changed while the order was
         * open is the next order's price; this one is booked as it was made.
         */
        {
          amountMinor: item.unitPriceMinor,
          currency: item.currency,
          priceRowId: item.priceRowId ?? await priceRowAt(tx, item, order.createdAt),
        },
        taxPolicy.rateBp,
        // The discount frozen on the LINE when the order was built, never one
        // recomputed now. A promotion that ended between placing the order and
        // approving the payment must not retroactively raise the bill.
        item.discountMinor,
      );

      await tx
        .update(orderItems)
        .set({
          /*
           * Null on a co-authored line (OPEN-15): with a rate per engineer
           * there is no single model or rate that describes the line, and
           * writing the primary's would name terms that governed only part of
           * the sale. The truth is on `order_item_contributors`, one row each.
           */
          commissionModel: terms.line.model,
          engineerBp: terms.line.engineerBp,
          engineerAmountMinor: terms.line.engineerAmountMinor,
          platformAmountMinor: terms.line.platformAmountMinor,
          taxBp: terms.tax.rateBp,
          taxMinor: terms.tax.taxMinor,
          netMinor: terms.tax.netMinor,
          // Written back although the line already carries it: the column is
          // part of the snapshot from this moment on, and re-stating it here
          // keeps every frozen figure written by one statement.
          discountMinor: terms.discountMinor,
          // Likewise: one agreement id only when one agreement governed.
          agreementId: terms.distribution.length === 1
            ? terms.distribution[0]!.agreementId
            : null,
          priceRowId: terms.priceRowId,
          commissionClamped: terms.line.clamped,
          snapshotTakenAt: new Date(),
        })
        .where(eq(orderItems.id, item.id));

      /*
       * THE PER-ENGINEER SNAPSHOT (OPEN-15).
       *
       * Each row records the slice, the agreement that governed it, and what
       * that agreement made of it. Frozen exactly like the line: the trigger
       * on this table refuses every UPDATE, so a rate changed next year cannot
       * reach a sale made this year — which is what §13 requires and what
       * makes a statement defensible a year later.
       */
      await tx.insert(orderItemContributors).values(
        terms.distribution.map((d) => ({
          orderItemId: item.id,
          contributorId: d.contributorId,
          shareBp: d.shareBp,
          sliceMinor: d.sliceMinor,
          amountMinor: d.amountMinor,
          platformAmountMinor: d.platformAmountMinor,
          agreementId: d.agreementId,
          commissionModel: d.model,
          engineerBp: d.engineerBp,
          engineerFixedMinor: d.engineerFixedMinor,
          platformFixedMinor: d.platformFixedMinor,
          commissionClamped: d.clamped,
          commissionRequestedMinor: d.requestedMinor,
          // The sale's own context, so the engineer can read their sales from
          // this table alone (migrations 0051, 0062).
          occurredAt: new Date(),
          currency: item.currency,
          productTitle: item.titleSnapshot,
        })),
      );

      for (const d of terms.distribution) {
        sharesByContributor.set(
          d.contributorId,
          (sharesByContributor.get(d.contributorId) ?? 0n) + d.amountMinor,
        );
      }
      platformTotal += terms.line.platformAmountMinor;
      taxTotal += terms.tax.taxMinor;
      // What the customer PAID for this line, which is what the books record.
      // Accumulating the list price here would balance against a total nobody
      // was charged the moment a discount existed.
      grossTotal += terms.payableMinor;
      listTotal += item.unitPriceMinor;
      discountTotal += terms.discountMinor;

      invoiceLines.push({
        // The title as it was at the moment of sale, not as it reads today.
        title: item.titleSnapshot,
        listMinor: item.unitPriceMinor,
        discountMinor: terms.discountMinor,
        grossMinor: terms.payableMinor,
        taxMinor: terms.tax.taxMinor,
        netMinor: terms.tax.netMinor,
      });

      /**
       * §41: ownership is a row, not a success message.
       *
       * NO `onConflictDoNothing` HERE ANY MORE (OPEN-11). It was there to make
       * the grant idempotent, and it did something quite different: with a
       * unique index that included `order_item_id`, a second order for the
       * same product never collided, so nothing was ever suppressed — and
       * after migration 0048 tightened the index, suppressing a collision is
       * precisely the wrong answer. A customer whose payment was approved for
       * a product they already own has paid twice for one file, and the only
       * correct response is to take the whole approval down: no ledger entry,
       * no invoice, no second charge recorded.
       *
       * The owner sees the refusal in the approval screen and can cancel the
       * duplicate order, which is the state the money is already in.
       */
      const granted = await tx
        .insert(entitlements)
        .values({
          customerId: order.customerId,
          productId: item.productId,
          orderItemId: item.id,
        })
        .returning({ id: entitlements.id });

      if (granted.length === 0) {
        // RLS refuses a write by returning no rows rather than raising.
        throw new RuleViolationError('رُفض منح الوصول لهذا المنتج', { itemId: item.id });
      }
      entitlementsGranted += 1;

      await tx
        .update(products)
        .set({ salesCount: sql`${products.salesCount} + 1` })
        .where(eq(products.id, item.productId));

      /*
       * One message per credited engineer, carrying THEIR OWN frozen share
       * (owner decision: a notification on every sale, a document once a
       * month). Sent from `terms.distribution` rather than from the product's
       * current credits, so each author on a co-authored product is told their
       * own number and never the others' — decisions §6.
       *
       * No buyer identity, per OPEN-4: the date, the product, the price and
       * their share, and nothing about who bought it.
       */
      for (const share of terms.distribution) {
        await notifyContributor(tx, share.contributorId, 'PRODUCT_SOLD', {
          productTitle: item.titleSnapshot,
          currency: item.currency,
          // What the sale actually fetched, not the list price. Their share was
          // computed from this number (OPEN-1), and a message pairing a full
          // price with a discounted share reads as an underpayment.
          grossMinor: terms.payableMinor.toString(),
          engineerMinor: share.amountMinor.toString(),
          soldAt: new Date().toISOString(),
        });
      }
    }

    /*
     * THE BOOKS (specification §14).
     *
     * Posted from the frozen figures collected above — never recomputed. The
     * ledger function refuses anything that does not sum to zero, so a sale
     * whose split does not re-add to what the customer paid fails here and
     * takes the whole approval down with it, snapshot and entitlements
     * included. A half-booked sale is not a state this system can reach.
     */
    /**
     * THE ORDER HEADER AND ITS LINES MUST TELL THE SAME STORY (OPEN-1).
     *
     * Three equations, not one. The old single check compared the lines to the
     * order total and was sufficient only while no discount could exist:
     * with one, a line discount and a header discount that disagree still
     * produce a matching total, because the same amount appears on both sides.
     *
     * So the subtotal and the discount are reconciled separately, and the
     * total is then the difference of two numbers that have each been checked.
     * The database enforces the third equation as a CHECK on the row; this
     * names the problem while the figures are still in hand.
     */
    if (listTotal !== order.subtotalMinor) {
      throw new RuleViolationError('مجموع أسعار بنود الطلب لا يساوي المجموع الفرعي', {
        orderId: order.id,
        itemsListMinor: listTotal.toString(),
        orderSubtotalMinor: order.subtotalMinor.toString(),
      });
    }

    if (discountTotal !== order.discountMinor) {
      throw new RuleViolationError('مجموع خصومات البنود لا يساوي خصم الطلب', {
        orderId: order.id,
        itemsDiscountMinor: discountTotal.toString(),
        orderDiscountMinor: order.discountMinor.toString(),
      });
    }

    if (grossTotal !== order.totalMinor) {
      throw new RuleViolationError('مجموع بنود الطلب لا يساوي إجمالي الطلب', {
        orderId: order.id,
        itemsTotalMinor: grossTotal.toString(),
        orderTotalMinor: order.totalMinor.toString(),
      });
    }

    const contributorShares: ContributorShare[] = [...sharesByContributor].map(
      ([contributorId, amountMinor]) => ({ contributorId, amountMinor }),
    );

    const ledgerTransactionId = await postLedgerTransaction(
      tx,
      saleEntry({
        orderId: order.id,
        orderNumber: order.orderNumber,
        currency: order.currency,
        grossMinor: grossTotal,
        platformMinor: platformTotal,
        taxMinor: taxTotal,
        contributorShares,
        occurredAt: new Date(),
        itemCount: items.length,
      }),
    );

    /**
     * THE DOCUMENT, IN THE SAME TRANSACTION AS THE MONEY (OPEN-9).
     *
     * A sale that booked but produced no invoice, or an invoice with no sale
     * behind it, are both states this system must not be able to reach — so
     * neither is written without the other. It also keeps the number series
     * gapless: a rollback here returns the number instead of burning it.
     */
    const buyer = await tx
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, order.customerId))
      .limit(1);

    const invoice = await issueInvoice(tx, {
      orderId: order.id,
      customerId: order.customerId,
      buyerName: buyer[0]?.displayName ?? '',
      buyerEmail: buyer[0]?.email ?? '',
      currency: order.currency,
      // A tax invoice states what was charged, so `grossMinor` is the amount
      // paid. The list price and the discount are stated beside it rather than
      // folded into it: a document that shows only the discounted figure
      // cannot be reconciled against the catalogue by whoever audits it.
      listMinor: listTotal,
      discountMinor: discountTotal,
      grossMinor: grossTotal,
      taxMinor: taxTotal,
      netMinor: grossTotal - taxTotal,
      tax: taxPolicy,
      identity: invoiceIdentity,
      lines: invoiceLines,
    });

    await recordAudit(tx, actor, {
      action: 'INVOICE_ISSUED',
      entityType: 'invoice',
      entityId: invoice.id,
      after: {
        invoiceNumber: invoice.invoiceNumber,
        orderNumber: order.orderNumber,
        listMinor: listTotal.toString(),
        discountMinor: discountTotal.toString(),
        grossMinor: grossTotal.toString(),
        taxMinor: taxTotal.toString(),
        taxBp: taxPolicy.rateBp,
      },
    });

    try {
      const decided = await tx
        .update(payments)
        .set({
          status: 'APPROVED',
          providerRef: providerRef ?? payment.providerRef,
          approvedBy: actor.kind === 'USER' ? actor.userId : null,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        // From the status read under the lock, and only from an open one.
        .where(and(eq(payments.id, payment.id), eq(payments.status, payment.status)))
        .returning({ id: payments.id });
      if (decided.length === 0) {
        throw new RuleViolationError('لم يُطبَّق اعتماد الدفعة', { paymentId: payment.id });
      }
    } catch (error) {
      // The unique index stays the guard against one receipt settling two
      // orders; this only names its refusal. Throwing rolls back the whole
      // sale above — invoice number included (W13).
      if (isProviderRefTaken(error)) {
        throw new ConflictError('رقم العملية هذا مستخدم لدفعة أخرى بالطريقة نفسها.', { paymentId: payment.id });
      }
      throw error;
    }

    await writeProofDecision(tx, actor, payment.id, 'APPROVED', null);

    await moveOrder(
      tx, actor,
      { id: order.id, status: 'PAID', orderNumber: order.orderNumber },
      'COMPLETED', 'منح الوصول',
    );

    await notifyUser(tx, {
      userId: order.customerId,
      type: 'ORDER_PAID',
      payload: { orderNumber: order.orderNumber },
    });

    await recordAudit(tx, actor, {
      action: 'PAYMENT_APPROVED',
      entityType: 'payment',
      entityId: payment.id,
      after: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountMinor: payment.amountMinor.toString(),
        currency: payment.currency,
        providerRef,
        itemsSettled: items.length,
        ledgerTransactionId,
      },
    });

    return {
      orderId: order.id,
      itemsSettled: items.length,
      entitlementsGranted,
      ledgerTransactionId,
    };
  });
}

/**
 * The payment and its order, both locked — the order first (S7-04).
 *
 * The payment is looked up once without a lock only to learn its order; both
 * are then read again under their locks, so what is decided below is what is
 * committed now, not what a concurrent decision has since replaced.
 */
async function lockPaymentAndOrder(tx: Transaction, paymentId: string) {
  const [seen] = await tx
    .select({ orderId: payments.orderId })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!seen) throw new NotFoundError('الدفعة غير موجودة');

  const order = await lockOrder(tx, seen.orderId);
  if (!order) throw new NotFoundError('الطلب غير موجود');

  const [payment] = await tx
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .for('update');
  if (!payment) throw new NotFoundError('الدفعة غير موجودة');

  return { payment, order };
}

/**
 * The owner's decision, written onto the receipt it was made on (Stage 7,
 * S7-08): who reviewed it, when, and — for a rejection — why. The payment row
 * and the audit log carry the decision too; the receipt used to be left
 * blank, so nothing on it said it had ever been looked at.
 */
async function writeProofDecision(
  tx: Transaction,
  actor: Actor,
  paymentId: string,
  decision: 'APPROVED' | 'REJECTED',
  reason: string | null,
): Promise<void> {
  await tx
    .update(paymentProofs)
    .set({
      decision,
      reviewedBy: actor.kind === 'USER' ? actor.userId : null,
      reviewedAt: new Date(),
      rejectionReason: decision === 'REJECTED' ? reason : null,
    })
    .where(and(eq(paymentProofs.paymentId, paymentId), eq(paymentProofs.decision, 'PENDING')));
}

/**
 * Owner rejects a proof; the customer may try again (§24).
 *
 * The rejected payment is final (K1): the buyer's next choice of method opens
 * a new payment row. Only an open payment can be rejected (S7-06) — never an
 * approved or cancelled one — and the decision is taken under the order lock,
 * so it cannot land on top of an approval that won the race (S7-04).
 */
export async function rejectPayment(
  actor: Actor,
  input: { paymentId: string; reason: string },
): Promise<void> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('رفض الدفع من صلاحية مالك المنصة وحده');
  }

  await withActor(actor, async (tx) => {
    const { payment, order } = await lockPaymentAndOrder(tx, input.paymentId);
    assertPaymentTransition(payment.status, 'REJECTED');

    const decided = await tx
      .update(payments)
      .set({ status: 'REJECTED', rejectedReason: input.reason, updatedAt: new Date() })
      .where(and(eq(payments.id, payment.id), inArray(payments.status, [...payableFrom('REJECTED')])))
      .returning({ id: payments.id });
    if (decided.length === 0) {
      throw new RuleViolationError('لم يُطبَّق رفض الدفعة', { paymentId: payment.id });
    }

    await writeProofDecision(tx, actor, payment.id, 'REJECTED', input.reason);

    await moveOrder(tx, actor, order, 'PAYMENT_ISSUE', input.reason);

    await notifyUser(tx, {
      userId: order.customerId,
      type: 'PAYMENT_REJECTED',
      payload: { orderNumber: order.orderNumber, reason: input.reason },
    });

    await recordAudit(tx, actor, {
      action: 'PAYMENT_REJECTED',
      entityType: 'payment',
      entityId: payment.id,
      after: { orderId: order.id, reason: input.reason },
    });
  });
}

/**
 * ===========================================================================
 * CANCELLING AN ORDER (Stage 7 — owner decisions K3-A, D4, D5, D6)
 * ===========================================================================
 * The state table always allowed it; nothing performed it, so an order that
 * could not be approved blocked its product for that buyer for good.
 *
 *   buyer:  DRAFT, AWAITING_PAYMENT, PAYMENT_ISSUE — their own order only
 *   owner:  the same, PROOF_SUBMITTED and PENDING_VERIFICATION, WITH a reason
 *   nobody: PAID, COMPLETED, CANCELLED, REFUNDED
 *
 * Every open payment closes as CANCELLED with the order; a rejected payment
 * stays exactly as it was. NOTHING FINANCIAL MOVES (D5): the platform has no
 * refund, writes no ledger line and claims to have returned no money — an
 * order that is not PAID has no sale to reverse. Whatever passed between the
 * owner and the buyer outside the platform stays outside it.
 *
 * The owner's cancellation is audited (rule 12) and the buyer is told, with
 * the reason and the order number and nothing else (D6). A cancelled order
 * no longer counts as "in the middle of buying" (OPEN-11), so the product can
 * be bought again at today's price.
 * ===========================================================================
 */
export async function cancelOrder(
  actor: Actor,
  input: { orderId: string; reason?: string | null },
): Promise<void> {
  if (actor.kind !== 'USER') throw new UnauthenticatedError();
  const byOwner = isOwner(actor);

  const reason = input.reason?.trim() || null;
  if (byOwner && !reason) {
    throw new ValidationError('يرجى كتابة سبب إلغاء الطلب');
  }
  if (reason && reason.length > 400) {
    throw new ValidationError('سبب الإلغاء أطول من المسموح (400 حرف)');
  }

  await withActor(actor, async (tx) => {
    const [seen] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
    // RLS hides another buyer's order; the explicit comparison is the same
    // answer for anyone who is not the owner.
    if (!seen || (!byOwner && seen.customerId !== actor.userId)) {
      throw new NotFoundError('الطلب غير موجود');
    }
    assertOrderTransition(seen.status, 'CANCELLED', orderActorOf(actor));

    const order = await lockOrder(tx, seen.id);
    if (!order) {
      throw new RuleViolationError('تغيّرت حالة الطلب؛ لا يمكن إلغاؤه الآن', { orderId: seen.id });
    }
    assertOrderTransition(order.status, 'CANCELLED', orderActorOf(actor));

    const closed = await closeOpenPayments(tx, actor, order, 'إلغاء الطلب');

    await moveOrder(tx, actor, order, 'CANCELLED', reason ?? 'ألغاه المشتري');

    if (byOwner) {
      await recordAudit(tx, actor, {
        action: 'ORDER_CANCELLED',
        entityType: 'order',
        entityId: order.id,
        before: { status: order.status },
        after: { status: 'CANCELLED', orderNumber: order.orderNumber, reason, paymentsClosed: closed },
      });
      // No amount: the buyer learns which order and why, nothing more (D6).
      await notifyUser(tx, {
        userId: order.customerId,
        type: 'ORDER_CANCELLED',
        payload: { orderNumber: order.orderNumber, reason },
      });
    }
  });
}
