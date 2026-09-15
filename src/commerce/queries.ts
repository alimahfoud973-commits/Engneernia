import 'server-only';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  entitlements, orderItems, orders, paymentMethods, paymentProofs, payments, products,
} from '@/db/schema';
import { withActor } from '@/db/actor-context';
import { availableMethods } from '@/payments/registry';
import type { Actor } from '@/authz/actor';
import type { PaymentContext } from '@/payments/port';

/**
 * Read models for the purchase screens.
 *
 * Every one runs inside an actor-scoped transaction, so RLS decides what
 * resolves. A customer asking for "the order at this id" gets nothing if it
 * is not theirs — the queries do not re-implement that check.
 */

export async function checkoutView(actor: Actor, orderId: string) {
  return withActor(actor, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) return null;

    const items = await tx
      .select({
        id: orderItems.id,
        title: orderItems.titleSnapshot,
        priceMinor: orderItems.unitPriceMinor,
        slug: products.slug,
      })
      .from(orderItems)
      .leftJoin(products, eq(products.id, orderItems.productId))
      .where(eq(orderItems.orderId, order.id));

    const paymentRows = await tx
      .select({
        id: payments.id,
        status: payments.status,
        methodId: payments.paymentMethodId,
        methodName: paymentMethods.displayNameAr,
        methodType: paymentMethods.type,
        instructionsAr: paymentMethods.instructionsAr,
        accountDetailsAr: paymentMethods.accountDetailsAr,
        requiresProof: paymentMethods.requiresProof,
      })
      .from(payments)
      .leftJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
      .where(eq(payments.orderId, order.id))
      .orderBy(desc(payments.createdAt))
      .limit(1);

    const context: PaymentContext = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountMinor: order.totalMinor,
      currency: order.currency,
      buyerCountry: order.buyerCountry,
      itemTitles: items.map((i) => i.title),
    };

    const methods = await availableMethods(tx, context);

    return {
      order,
      items,
      payment: paymentRows[0] ?? null,
      methods: methods.map((m) => ({
        id: m.config.id,
        code: m.config.code,
        displayNameAr: m.config.displayNameAr,
        type: m.config.type,
        requiresProof: m.config.requiresProof,
      })),
    };
  });
}

/**
 * ===========================================================================
 * WHAT THIS VISITOR CAN DO WITH THIS PRODUCT (owner decision on OPEN-11)
 * ===========================================================================
 * A product is bought once, so the product page has three states to show and
 * not one: buy it, open it because you own it, or finish the order you already
 * started for it.
 *
 * FOR RENDERING ONLY. Showing a disabled button is not what stops a second
 * purchase — the trigger and the unique index in migration 0048 are, and
 * `createOrder` refuses before either. This exists so that a buyer who already
 * owns a file is offered the file instead of being offered a purchase that is
 * going to be refused after they click it. (CLAUDE.md rule 4: hiding something
 * in the interface is not protection. It is still courtesy.)
 *
 * A guest gets `BUYABLE`: they may not have an entitlement, and the page must
 * not imply otherwise. The purchase itself sends them to log in.
 * ===========================================================================
 */
export type PurchaseState =
  | { readonly kind: 'BUYABLE' }
  | { readonly kind: 'OWNED' }
  | { readonly kind: 'IN_ORDER'; readonly orderId: string };

export async function purchaseState(actor: Actor, productId: string): Promise<PurchaseState> {
  if (actor.kind !== 'USER') return { kind: 'BUYABLE' };

  const me = actor.userId;

  return withActor(actor, async (tx) => {
    /*
     * BOTH QUERIES NAME THE CUSTOMER EXPLICITLY, and that is not belt and
     * braces — it is the whole correctness of this function for one actor.
     *
     * The policies on `entitlements` and `orders` both read
     * `app_is_owner() OR customer_id = app_actor_id()`. For every customer
     * that narrows to their own rows and an unfiltered query would be right.
     * For the PLATFORM OWNER it resolves everyone's, so the same query would
     * report that the owner personally owns any product a single customer has
     * ever bought — and offer them a download link for it on a public page.
     *
     * The first version of this function leaned on RLS and carried a comment
     * saying so. Filtering here is the fix; RLS still decides what the query
     * may see at all.
     */
    const [owned] = await tx
      .select({ id: entitlements.id })
      .from(entitlements)
      .where(and(
        eq(entitlements.productId, productId),
        eq(entitlements.customerId, me),
        isNull(entitlements.revokedAt),
      ))
      .limit(1);

    if (owned) return { kind: 'OWNED' } as const;

    const [pending] = await tx
      .select({ orderId: orders.id })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(
        eq(orderItems.productId, productId),
        eq(orders.customerId, me),
        ne(orders.status, 'CANCELLED'),
      ))
      .orderBy(desc(orders.createdAt))
      .limit(1);

    if (pending) return { kind: 'IN_ORDER', orderId: pending.orderId } as const;

    return { kind: 'BUYABLE' } as const;
  });
}

/** The customer's purchases (specification §40). */
export async function myPurchases(actor: Actor) {
  return withActor(actor, async (tx) => {
    const owned = await tx
      .select({
        id: entitlements.id,
        grantedAt: entitlements.grantedAt,
        revokedAt: entitlements.revokedAt,
        downloadCount: entitlements.downloadCount,
        productSlug: products.slug,
        productTitle: products.titleAr,
        fileType: products.fileType,
      })
      .from(entitlements)
      .innerJoin(products, eq(products.id, entitlements.productId))
      .orderBy(desc(entitlements.grantedAt));

    const orderRows = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        totalMinor: orders.totalMinor,
        currency: orders.currency,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(25);

    return { owned, orders: orderRows };
  });
}

/** The owner's verification queue (specification §24, §38). */
export async function verificationQueue(actor: Actor) {
  return withActor(actor, async (tx) => {
    const rows = await tx
      .select({
        paymentId: payments.id,
        paymentStatus: payments.status,
        amountMinor: payments.amountMinor,
        currency: payments.currency,
        submittedAt: payments.createdAt,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        orderStatus: orders.status,
        methodName: paymentMethods.displayNameAr,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .leftJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
      .where(inArray(payments.status, ['PROOF_SUBMITTED', 'AWAITING_PROOF', 'INITIATED']))
      .orderBy(desc(payments.createdAt))
      .limit(50);

    if (rows.length === 0) return [];

    const proofs = await tx
      .select({
        id: paymentProofs.id,
        paymentId: paymentProofs.paymentId,
        referenceNote: paymentProofs.referenceNote,
        contentType: paymentProofs.contentType,
        submittedAt: paymentProofs.submittedAt,
      })
      .from(paymentProofs)
      .where(inArray(paymentProofs.paymentId, rows.map((r) => r.paymentId)));

    const itemsByOrder = await tx
      .select({
        orderId: orderItems.orderId,
        title: orderItems.titleSnapshot,
        priceMinor: orderItems.unitPriceMinor,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, rows.map((r) => r.orderId)));

    return rows.map((row) => ({
      ...row,
      proof: proofs.find((p) => p.paymentId === row.paymentId) ?? null,
      items: itemsByOrder.filter((i) => i.orderId === row.orderId),
    }));
  });
}

export { sql };
