import 'server-only';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  entitlements, orderEvents, orderItemContributors, orderItems, orders,
  payments, productPrices, products, users,
} from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { notifyContributor, notifyUser } from '@/notifications/notify';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError, UnauthenticatedError } from '@/lib/errors';
import { resolveTermsForSale } from '@/finance/commission-resolver';
import { readTaxPolicy } from '@/finance/tax-policy';
import { issueInvoice } from '@/finance/invoices';
import { postLedgerTransaction } from '@/ledger/post';
import { saleEntry, type ContributorShare } from '@/ledger/entries';
import { assertOrderTransition, orderActorOf, type OrderStatus } from './order-status';
import { resolveMethod } from '@/payments/registry';
import type { InitiationResult, PaymentContext } from '@/payments/port';

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
    .where(eq(orders.id, order.id))
    .returning({ id: orders.id });

  // RLS refuses a write by returning zero rows, not by raising. Without this
  // check an unauthorised transition would look like a success.
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
 * ===========================================================================
 * A PRODUCT IS BOUGHT ONCE (owner decision on OPEN-11)
 * ===========================================================================
 * What is sold here is a file and a permanent right to download it. A second
 * purchase of the same file buys the buyer nothing they do not already have,
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
async function assertNotAlreadyBought(
  tx: Transaction,
  customerId: string,
  rows: ReadonlyArray<{ id: string; titleAr: string }>,
): Promise<void> {
  const productIds = rows.map((row) => row.id);
  const titleOf = (productId: string) =>
    rows.find((row) => row.id === productId)?.titleAr ?? 'هذا المنتج';

  const owned = await tx
    .select({ productId: entitlements.productId })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.customerId, customerId),
        inArray(entitlements.productId, productIds),
        isNull(entitlements.revokedAt),
      ),
    );

  if (owned.length > 0) {
    throw new RuleViolationError(
      `«${titleOf(owned[0]!.productId)}» ضمن مشترياتك بالفعل — يمكنك تنزيله من صفحة مشترياتي.`,
      { productId: owned[0]!.productId },
    );
  }

  const pending = await tx
    .select({ productId: orderItems.productId, orderId: orders.id })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orders.customerId, customerId),
        inArray(orderItems.productId, productIds),
        ne(orders.status, 'CANCELLED'),
      ),
    )
    .limit(1);

  if (pending.length > 0) {
    throw new RuleViolationError(
      `لديك طلب قائم على «${titleOf(pending[0]!.productId)}» — أكمِل ذلك الطلب أو ألغِه قبل إنشاء طلب جديد.`,
      { productId: pending[0]!.productId, orderId: pending[0]!.orderId },
    );
  }
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
        priceMinor: productPrices.amountMinor,
        priceCurrency: productPrices.currency,
      })
      .from(products)
      .leftJoin(
        productPrices,
        and(eq(productPrices.productId, products.id), isNull(productPrices.effectiveTo)),
      )
      .where(inArray(products.slug, [...input.productSlugs]));

    if (rows.length !== input.productSlugs.length) {
      // RLS already hid anything unpublished, so a missing row means the
      // product does not exist OR is not for sale — indistinguishable, and
      // deliberately so.
      throw new NotFoundError('أحد المنتجات غير متاح للشراء');
    }

    await assertNotAlreadyBought(tx, customerId, rows);

    const currencies = new Set(rows.map((r) => r.priceCurrency ?? r.currency));
    if (currencies.size > 1) {
      // Mixing currencies in one order would make a single payment ambiguous.
      throw new RuleViolationError('لا يمكن الجمع بين عملات مختلفة في طلب واحد', {
        currencies: [...currencies],
      });
    }
    const currency = [...currencies][0]!;

    let subtotal = 0n;
    for (const row of rows) {
      if (row.priceMinor === null) {
        throw new RuleViolationError('أحد المنتجات بلا سعر حالي', { slug: row.slug });
      }
      subtotal += row.priceMinor;
    }

    const [numberRow] = (await tx.execute(
      sql`SELECT app_next_order_number() AS number`,
    )) as unknown as Array<{ number: string }>;

    /**
     * NO DISCOUNT IS APPLIED HERE, AND NONE CAN BE (OPEN-1).
     *
     * The commission base for a discount is decided — it is computed after the
     * discount — and the whole pipeline below carries one correctly. What does
     * not exist yet is anything that GRANTS one: coupons, promotions and
     * limited-time offers are §43, deliberately not in the first release.
     *
     * So the three money columns are written as three separate statements of
     * fact rather than one value reused. `totalMinor: subtotal` would be true
     * today and silently wrong the day a discount arrives; `subtotal - discount`
     * is the definition, and the database checks it holds.
     */
    const discount = 0n;

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

    await tx.insert(orderItems).values(
      rows.map((row) => ({
        orderId: order.id,
        productId: row.id,
        // Copied now: renaming a product later must not rewrite an old order.
        titleSnapshot: row.titleAr,
        unitPriceMinor: row.priceMinor!,
        currency,
      })),
    );

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

/** Choose how to pay, and get the instructions or the handoff (§24). */
export async function placeOrder(
  actor: Actor,
  input: { orderId: string; paymentMethodId: string },
): Promise<InitiationResult> {
  requireUser(actor);

  return withActor(actor, async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);

    if (!order) throw new NotFoundError('الطلب غير موجود');

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

    const initiation = await resolved.provider.initiate(resolved.config, context);

    await tx
      .insert(payments)
      .values({
        orderId: order.id,
        paymentMethodId: resolved.config.id,
        status: resolved.config.requiresProof ? 'AWAITING_PROOF' : 'INITIATED',
        amountMinor: order.totalMinor,
        currency: order.currency,
        // One payment per order attempt; a double-click cannot create two.
        idempotencyKey: `${order.id}:${resolved.config.id}`,
      })
      .onConflictDoNothing({ target: payments.idempotencyKey });

    if (order.status === 'DRAFT' || order.status === 'PAYMENT_ISSUE') {
      await moveOrder(tx, actor, order, 'AWAITING_PAYMENT', `طريقة الدفع: ${resolved.config.code}`);
    }

    return initiation;
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

  return withActor(actor, async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .limit(1);

    if (!payment) throw new NotFoundError('الدفعة غير موجودة');
    if (payment.status === 'APPROVED') {
      // Idempotent: approving twice must not settle twice.
      throw new RuleViolationError('هذه الدفعة معتمدة مسبقاً', { paymentId: payment.id });
    }

    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, payment.orderId))
      .limit(1);
    if (!order) throw new NotFoundError('الطلب غير موجود');

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
        taxPolicy.rateBp,
        // The discount frozen on the LINE when the order was built, never one
        // recomputed now. A promotion that ended between placing the order and
        // approving the payment must not retroactively raise the bill.
        item.discountMinor,
      );

      // Compared on the LIST price: that is the number the customer saw and
      // agreed to. Neither the tax split nor the discount happens outside it,
      // so neither can make an unchanged price look changed.
      if (terms.grossMinor !== item.unitPriceMinor) {
        // The price moved between placing the order and approving payment.
        // The customer agreed to the price they saw, so that price stands and
        // the owner is told rather than the difference being absorbed silently.
        throw new RuleViolationError(
          'تغيّر سعر المنتج بعد إنشاء الطلب — راجع الطلب قبل الاعتماد',
          {
            itemId: item.id,
            orderedPriceMinor: item.unitPriceMinor.toString(),
            currentPriceMinor: terms.grossMinor.toString(),
          },
        );
      }

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
          // The sale's own context, so the engineer can read their sales from
          // this table alone (migration 0051).
          occurredAt: new Date(),
          currency: item.currency,
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

    await tx
      .update(payments)
      .set({
        status: 'APPROVED',
        providerRef: input.providerRef ?? payment.providerRef,
        approvedBy: actor.kind === 'USER' ? actor.userId : null,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

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
        providerRef: input.providerRef ?? null,
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

/** Owner rejects a proof; the customer may try again (§24). */
export async function rejectPayment(
  actor: Actor,
  input: { paymentId: string; reason: string },
): Promise<void> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('رفض الدفع من صلاحية مالك المنصة وحده');
  }

  await withActor(actor, async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .limit(1);
    if (!payment) throw new NotFoundError('الدفعة غير موجودة');

    const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).limit(1);
    if (!order) throw new NotFoundError('الطلب غير موجود');

    await tx
      .update(payments)
      .set({ status: 'REJECTED', rejectedReason: input.reason, updatedAt: new Date() })
      .where(eq(payments.id, payment.id));

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
