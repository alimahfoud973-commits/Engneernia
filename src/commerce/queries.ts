import 'server-only';
import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import {
  entitlements, orderItems, orders, paymentProofs, payments, productPrices,
  products, productVersions,
} from '@/db/schema';
import { money, percentOf, subtract } from '@/lib/money/money';
import { readUpgradeDiscountBp } from './version-policy';
import { isOpenPayment } from './payment-status';
import { withActor } from '@/db/actor-context';
import { availableMethods, whatsappHelpLink } from '@/payments/registry';
import type { Actor } from '@/authz/actor';
import type { PaymentContext } from '@/payments/port';

/**
 * Read models for the purchase screens.
 *
 * Every one runs inside an actor-scoped transaction, so RLS decides what
 * resolves. A customer asking for "the order at this id" gets nothing if it
 * is not theirs — the queries do not re-implement that check.
 */

/** Where the buyer still chooses, changes or cancels (Stage 7, D2/D4). */
const BUYER_CAN_ACT: readonly string[] = ['DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_ISSUE'];

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

    // What the customer was told when they chose the method — kept on the
    // payment (migration 0055), not read from the method, which the owner may
    // since have changed or disabled (and RLS hides a disabled one).
    //
    // Every attempt is its own row (Stage 7, K1). The page shows the OPEN one
    // — at most one exists — and, when there is none, why the last one was
    // rejected. A rejected or cancelled attempt is never shown as if it were
    // still waiting for a receipt: that was the dead end S7-01.
    const paymentRows = await tx
      .select({
        id: payments.id,
        status: payments.status,
        methodId: payments.paymentMethodId,
        methodName: payments.methodNameSnapshot,
        instructionsAr: payments.instructionsSnapshot,
        accountDetailsAr: payments.accountDetailsSnapshot,
        requiresProof: payments.requiresProofSnapshot,
        rejectedReason: payments.rejectedReason,
        updatedAt: payments.updatedAt,
      })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(desc(payments.createdAt), desc(payments.id));
    const openPayment = paymentRows.find((row) => isOpenPayment(row.status)) ?? null;
    const latest = paymentRows[0] ?? null;
    const lastRejection = !openPayment && latest?.status === 'REJECTED'
      ? { reason: latest.rejectedReason, at: latest.updatedAt }
      : null;

    const context: PaymentContext = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountMinor: order.totalMinor,
      currency: order.currency,
      buyerCountry: order.buyerCountry,
      itemTitles: items.map((i) => i.title),
    };

    const methods = await availableMethods(tx, context);
    // §23: the WhatsApp fallback for this order, when a number is set (W2).
    const whatsappHelp = await whatsappHelpLink(tx, context);

    // What the buyer may do from here (Stage 7). For rendering only: every
    // one of these is refused on the server again (CLAUDE.md rule 4).
    const isBuyer = actor.kind === 'USER' && actor.userId === order.customerId;
    const waitsForPayment = BUYER_CAN_ACT.includes(order.status);
    const canChangeMethod = isBuyer
      && waitsForPayment
      && order.totalMinor > 0n
      && (openPayment === null || openPayment.status !== 'PROOF_SUBMITTED');
    const canCancel = isBuyer && waitsForPayment;

    return {
      order,
      items,
      payment: openPayment,
      lastRejection,
      canChangeMethod,
      canCancel,
      whatsappHelp,
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
  /** Holds the version on sale. `windowOpen` false: bought, but the six months are over. */
  | { readonly kind: 'OWNED'; readonly expiresAt: Date; readonly windowOpen: boolean }
  /**
   * Holds an earlier version (S4-09): offered the version on sale at the
   * upgrade price. `priceMinor` null when the policy row is missing — the
   * order itself then refuses with a sentence rather than guess a price.
   */
  | {
    readonly kind: 'UPGRADE';
    readonly heldVersionNo: number | null;
    readonly heldWindowOpen: boolean;
    readonly listMinor: bigint;
    readonly priceMinor: bigint | null;
    readonly currency: string;
  }
  | { readonly kind: 'IN_ORDER'; readonly orderId: string }
  /**
   * Credited to a deactivated engineer (owner's final Stage 5 decision): on
   * the platform, not for sale. Asked of `app_product_on_hold` — the same
   * answer the order-line trigger gives — since neither a buyer nor a guest
   * may read who is credited.
   */
  | { readonly kind: 'ON_HOLD' };

export async function purchaseState(actor: Actor, productId: string): Promise<PurchaseState> {
  if (actor.kind !== 'USER') {
    return (await productOnHold(actor, productId)) ? { kind: 'ON_HOLD' } : { kind: 'BUYABLE' };
  }

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
    const [product] = await tx
      .select({
        currentVersionId: products.currentVersionId,
        priceMinor: productPrices.amountMinor,
        currency: productPrices.currency,
      })
      .from(products)
      .leftJoin(productPrices, and(eq(productPrices.productId, products.id), isNull(productPrices.effectiveTo)))
      .where(eq(products.id, productId))
      .limit(1);

    const held = await tx
      .select({
        versionId: entitlements.versionId,
        versionNo: productVersions.versionNo,
        expiresAt: entitlements.expiresAt,
        windowOpen: sql<boolean>`${entitlements.expiresAt} > now()`,
      })
      .from(entitlements)
      .leftJoin(productVersions, eq(productVersions.id, entitlements.versionId))
      .where(and(
        eq(entitlements.productId, productId),
        eq(entitlements.customerId, me),
        isNull(entitlements.revokedAt),
      ))
      .orderBy(desc(entitlements.grantedAt));

    const current = held.find((h) => h.versionId !== null && h.versionId === product?.currentVersionId);
    if (current) {
      return { kind: 'OWNED', expiresAt: current.expiresAt, windowOpen: Boolean(current.windowOpen) } as const;
    }

    const [pending] = await tx
      .select({ orderId: orders.id, versionId: orderItems.versionId, status: orders.status })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(
        eq(orderItems.productId, productId),
        eq(orders.customerId, me),
        ne(orders.status, 'CANCELLED'),
        // A completed order on an earlier version is the purchase an upgrade
        // is offered on, not an order in progress (the rule createOrder applies).
        sql`(${orders.status} <> 'COMPLETED' OR ${orderItems.versionId} IS NULL OR ${orderItems.versionId} IS NOT DISTINCT FROM ${product?.currentVersionId ?? null})`,
      ))
      .orderBy(desc(orders.createdAt))
      .limit(1);

    if (pending) return { kind: 'IN_ORDER', orderId: pending.orderId } as const;

    // What they hold and what they have ordered stay theirs; only a NEW
    // purchase — or an upgrade — waits while the product is on hold.
    const [hold] = (await tx.execute(
      sql`SELECT app_product_on_hold(${productId}::uuid) AS on_hold`,
    )) as unknown as Array<{ on_hold: boolean }>;
    if (hold?.on_hold) return { kind: 'ON_HOLD' } as const;

    const earlier = held[0];
    if (earlier && product?.currentVersionId && product.priceMinor !== null && product.currency) {
      let priceMinor: bigint | null = null;
      try {
        const bp = await readUpgradeDiscountBp(tx);
        const list = money(product.priceMinor, product.currency);
        priceMinor = subtract(list, percentOf(list, bp)).amountMinor;
      } catch {
        priceMinor = null;
      }
      return {
        kind: 'UPGRADE',
        heldVersionNo: earlier.versionNo ?? null,
        heldWindowOpen: held.some((h) => Boolean(h.windowOpen)),
        listMinor: product.priceMinor,
        priceMinor,
        currency: product.currency,
      } as const;
    }

    return { kind: 'BUYABLE' } as const;
  });
}

async function productOnHold(actor: Actor, productId: string): Promise<boolean> {
  return withActor(actor, async (tx) => {
    const [row] = (await tx.execute(
      sql`SELECT app_product_on_hold(${productId}::uuid) AS on_hold`,
    )) as unknown as Array<{ on_hold: boolean }>;
    return row?.on_hold === true;
  });
}

/**
 * The caller's OWN purchases and orders (specification §40) — `/account`.
 *
 * BOTH QUERIES NAME THE CUSTOMER, for the reason `purchaseState` above gives:
 * the policies on `entitlements` and `orders` admit the owner to every row, so
 * an unfiltered query answered the platform owner's "my purchases" with every
 * customer's purchases and the latest 25 orders on the platform (Stage 3, W12).
 * The owner's global view is the admin screens'; this is a personal page for
 * everyone who opens it, the owner included. RLS still decides what the query
 * may see at all — the filter only narrows it to the caller.
 */
export async function myPurchases(actor: Actor) {
  if (actor.kind !== 'USER') return { owned: [], orders: [] };
  const me = actor.userId;

  return withActor(actor, async (tx) => {
    /*
     * One row per version bought (S4-09), with its six-month window (S4-03).
     * The product row is visible to its buyer even after it leaves the
     * catalogue (0059), so an unpublished or archived purchase still lists.
     */
    const rows = await tx
      .select({
        id: entitlements.id,
        grantedAt: entitlements.grantedAt,
        expiresAt: entitlements.expiresAt,
        windowOpen: sql<boolean>`${entitlements.expiresAt} > now()`,
        revokedAt: entitlements.revokedAt,
        downloadCount: entitlements.downloadCount,
        productSlug: products.slug,
        productTitle: products.titleAr,
        productStatus: products.status,
        fileType: products.fileType,
        versionId: entitlements.versionId,
        versionNo: productVersions.versionNo,
        filesPurgedAt: productVersions.filesPurgedAt,
        currentVersionId: products.currentVersionId,
      })
      .from(entitlements)
      .innerJoin(products, eq(products.id, entitlements.productId))
      .leftJoin(productVersions, eq(productVersions.id, entitlements.versionId))
      .where(eq(entitlements.customerId, me))
      .orderBy(desc(entitlements.grantedAt));

    const heldVersions = new Set(rows.map((r) => r.versionId).filter(Boolean));
    const owned = rows.map((row) => {
      const windowOpen = Boolean(row.windowOpen);
      const isCurrent = row.versionId !== null && row.versionId === row.currentVersionId;
      return {
        id: row.id,
        grantedAt: row.grantedAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        downloadCount: row.downloadCount,
        productSlug: row.productSlug,
        productTitle: row.productTitle,
        fileType: row.fileType,
        versionId: row.versionId,
        versionNo: row.versionNo,
        windowOpen,
        downloadable: windowOpen && row.revokedAt === null && row.filesPurgedAt === null,
        // A newer version is on sale and this buyer does not hold it yet.
        upgradeAvailable: !isCurrent
          && row.productStatus === 'PUBLISHED'
          && row.currentVersionId !== null
          && !heldVersions.has(row.currentVersionId),
      };
    });

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
      .where(eq(orders.customerId, me))
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
        // The name the buyer chose, as it was then (S7-11) — not the method's
        // name today, which the owner may have changed since.
        methodName: payments.methodNameSnapshot,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(and(
        inArray(payments.status, ['PROOF_SUBMITTED', 'AWAITING_PROOF', 'INITIATED']),
        // An open payment on a settled or cancelled order can never be
        // decided; it is not work for the owner (C-2). Migration 0066 closed
        // the ones the old code left, and none can be made now.
        notInArray(orders.status, ['PAID', 'COMPLETED', 'CANCELLED', 'REFUNDED']),
      ))
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
