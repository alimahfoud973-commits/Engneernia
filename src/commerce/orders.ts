import 'server-only';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  entitlements, orderEvents, orderItemContributors, orderItems, orders,
  payments, productPrices, products,
} from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { notifyProductContributors, notifyUser } from '@/notifications/notify';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError, UnauthenticatedError } from '@/lib/errors';
import { resolveTermsForSale } from '@/finance/commission-resolver';
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

/** Build a draft order from a set of products, priced at today's price. */
export async function createOrder(
  actor: Actor,
  input: { productSlugs: readonly string[]; buyerCountry?: string | null },
): Promise<{ orderId: string; orderNumber: string; totalMinor: bigint; currency: string }> {
  const customerId = requireUser(actor);

  if (input.productSlugs.length === 0) {
    throw new RuleViolationError('لا يمكن إنشاء طلب بلا منتجات');
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

    const [order] = await tx
      .insert(orders)
      .values({
        orderNumber: numberRow!.number,
        customerId,
        status: 'DRAFT',
        currency,
        subtotalMinor: subtotal,
        totalMinor: subtotal,
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
      totalMinor: subtotal,
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
 *   5. records the audit entry and notifies the people involved.
 *
 * If any step fails, none of them happened. There is no path that grants a
 * download without a snapshot, or takes a snapshot without granting access.
 */
export async function approvePayment(
  actor: Actor,
  input: { paymentId: string; providerRef?: string | null; note?: string | null },
): Promise<{ orderId: string; itemsSettled: number; entitlementsGranted: number }> {
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

    for (const item of items) {
      if (item.snapshotTakenAt !== null) {
        throw new RuleViolationError('هذا البند يحمل لقطة مالية مسبقاً', { itemId: item.id });
      }

      const terms = await resolveTermsForSale(tx, item.productId);

      if (terms.snapshot.netPriceMinor !== item.unitPriceMinor) {
        // The price moved between placing the order and approving payment.
        // The customer agreed to the price they saw, so that price stands and
        // the owner is told rather than the difference being absorbed silently.
        throw new RuleViolationError(
          'تغيّر سعر المنتج بعد إنشاء الطلب — راجع الطلب قبل الاعتماد',
          {
            itemId: item.id,
            orderedPriceMinor: item.unitPriceMinor.toString(),
            currentPriceMinor: terms.snapshot.netPriceMinor.toString(),
          },
        );
      }

      await tx
        .update(orderItems)
        .set({
          commissionModel: terms.snapshot.model,
          engineerBp: terms.snapshot.engineerBp,
          engineerAmountMinor: terms.snapshot.engineerAmountMinor,
          platformAmountMinor: terms.snapshot.platformAmountMinor,
          agreementId: terms.agreementId,
          priceRowId: terms.priceRowId,
          commissionClamped: terms.snapshot.clamped,
          snapshotTakenAt: new Date(),
        })
        .where(eq(orderItems.id, item.id));

      await tx.insert(orderItemContributors).values(
        terms.distribution.map((d) => ({
          orderItemId: item.id,
          contributorId: d.contributorId,
          shareBp: d.shareBp,
          amountMinor: d.amountMinor,
        })),
      );

      // §41: ownership is a row, not a success message.
      await tx
        .insert(entitlements)
        .values({
          customerId: order.customerId,
          productId: item.productId,
          orderItemId: item.id,
        })
        .onConflictDoNothing();
      entitlementsGranted += 1;

      await tx
        .update(products)
        .set({ salesCount: sql`${products.salesCount} + 1` })
        .where(eq(products.id, item.productId));

      await notifyProductContributors(tx, item.productId, 'ORDER_PAID', {
        productTitle: item.titleSnapshot,
      });
    }

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
      },
    });

    return { orderId: order.id, itemsSettled: items.length, entitlementsGranted };
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
