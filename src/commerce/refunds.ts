import 'server-only';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  entitlements, orderItemContributors, orderItems, orders, products,
  refundRequestItems, refundRequests,
} from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { notifyProductContributors, notifyUser } from '@/notifications/notify';
import { isOwner, type Actor } from '@/authz/actor';
import {
  MoneyInvariantError, NotFoundError, RuleViolationError, UnauthenticatedError,
} from '@/lib/errors';
import { postLedgerTransaction } from '@/ledger/post';
import { refundEntry, refundPayoutEntry, type ContributorShare } from '@/ledger/entries';
import { isWithinRefundWindow, readFinancialPolicy } from '@/finance/policy';
import { requireDate } from '@/db';
import type { refundReasonEnum } from '@/db/schema';

/**
 * ===========================================================================
 * REFUNDS (specification §17 — decisions §7)
 * ===========================================================================
 *
 * The owner's rule, in their words: "لا يوجد Refund تلقائي بعد منح الوصول
 * إلى الملف الكامل" — nothing here refunds anything automatically. A customer
 * ASKS; the owner DECIDES; the books record both.
 *
 * Four properties this module exists to guarantee:
 *
 *   1. THE SALE IS NEVER TOUCHED. No row of the original order's financial
 *      snapshot is edited or deleted. The refund is a separate record that
 *      points at it, and the reversal is a new ledger entry.
 *
 *   2. THE REVERSAL IS EXACT. Every amount is copied from what was frozen at
 *      sale time. Nothing is recomputed, so nothing can round differently the
 *      second time.
 *
 *   3. APPROVING IS ATOMIC. The ledger entry, the entitlement revocation, the
 *      sales counter, the order status and the audit record either all happen
 *      or none do. A customer whose access was revoked but whose money was
 *      never booked back is not a state this code can produce.
 *
 *   4. NO NUMBER IS INVENTED. The time window and the download rule come from
 *      the settings table (decisions §7), read at the moment of asking.
 * ===========================================================================
 */

export type RefundReason = (typeof refundReasonEnum)['enumValues'][number];

function requireUser(actor: Actor): string {
  if (actor.kind !== 'USER') throw new UnauthenticatedError();
  return actor.userId;
}

function requireOwner(actor: Actor, what: string): void {
  if (!isOwner(actor)) {
    throw new RuleViolationError(`${what} من صلاحية مالك المنصة وحده`);
  }
}

export interface RefundRequestInput {
  readonly orderId: string;
  /** Which lines. Empty means the whole order. */
  readonly orderItemIds?: readonly string[];
  readonly reason: RefundReason;
  readonly customerNote: string;
}

/**
 * A customer asks for their money back.
 *
 * Refunds are per ORDER LINE. A line carries a frozen engineer/platform split,
 * and reversing a whole line reverses exactly those numbers. A partial-amount
 * refund would need a rule for apportioning a fraction between the parties —
 * that is the owner's decision (OPEN-16), so this function does not offer it
 * rather than picking one.
 */
export async function requestRefund(
  actor: Actor,
  input: RefundRequestInput,
): Promise<{ refundRequestId: string; reference: string; amountMinor: bigint; currency: string }> {
  const customerId = requireUser(actor);

  const note = input.customerNote.trim();
  if (note.length < 10) {
    // A reason code alone explains nothing, and the owner has to decide on
    // something. Ten characters is a floor on effort, not a quality bar.
    throw new RuleViolationError('اشرح سبب طلب الاسترجاع بجملة مفيدة على الأقل');
  }

  return withActor(actor, async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);

    // RLS already restricted this to the customer's own orders, so "not
    // found" covers both "does not exist" and "not yours" — deliberately.
    if (!order) throw new NotFoundError('الطلب غير موجود');

    if (order.status !== 'COMPLETED') {
      throw new RuleViolationError('لا يمكن طلب استرجاع إلا لطلب مكتمل', {
        status: order.status,
      });
    }

    const paidAt = order.paidAt;
    if (paidAt === null) {
      throw new RuleViolationError('الطلب بلا تاريخ دفع مسجَّل');
    }

    const policy = await readFinancialPolicy(tx);
    if (!isWithinRefundWindow(policy.refunds, requireDate(paidAt, 'paidAt'))) {
      throw new RuleViolationError('انقضت المدة المسموحة لطلب الاسترجاع', {
        windowDays: policy.refunds.requestWindowDays,
      });
    }

    const lines = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));

    const wanted =
      input.orderItemIds && input.orderItemIds.length > 0
        ? lines.filter((line) => input.orderItemIds!.includes(line.id))
        : lines;

    if (wanted.length === 0) {
      throw new NotFoundError('لا توجد بنود مطابقة في هذا الطلب');
    }

    for (const line of wanted) {
      if (line.refundedAt !== null) {
        throw new RuleViolationError('أحد البنود مسترجَع مسبقاً', { orderItemId: line.id });
      }
      if (line.snapshotTakenAt === null) {
        // No snapshot means the sale was never settled, so there is nothing
        // to reverse. This should be unreachable for a COMPLETED order.
        throw new RuleViolationError('أحد البنود بلا لقطة مالية', { orderItemId: line.id });
      }
    }

    const alreadyOpen = await tx
      .select({ id: refundRequests.id })
      .from(refundRequests)
      .where(and(eq(refundRequests.orderId, order.id), eq(refundRequests.status, 'REQUESTED')))
      .limit(1);

    if (alreadyOpen.length > 0) {
      throw new RuleViolationError('يوجد طلب استرجاع قيد المراجعة لهذا الطلب');
    }

    if (policy.refunds.blockAfterDownload) {
      const downloaded = await tx
        .select({ count: entitlements.downloadCount })
        .from(entitlements)
        .where(
          and(
            inArray(entitlements.orderItemId, wanted.map((line) => line.id)),
            isNull(entitlements.revokedAt),
          ),
        );
      if (downloaded.some((row) => row.count > 0)) {
        throw new RuleViolationError('لا يمكن طلب الاسترجاع بعد تنزيل الملف الأصلي');
      }
    }

    const amountMinor = wanted.reduce((total, line) => total + line.unitPriceMinor, 0n);

    const [referenceRow] = (await tx.execute(
      sql`SELECT app_next_refund_reference() AS reference`,
    )) as unknown as Array<{ reference: string }>;

    const [created] = await tx
      .insert(refundRequests)
      .values({
        reference: referenceRow!.reference,
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerId,
        status: 'REQUESTED',
        reason: input.reason,
        customerNote: note,
        currency: order.currency,
        amountMinor,
      })
      .returning({ id: refundRequests.id, reference: refundRequests.reference });

    if (!created) {
      // RLS refuses a write by returning no rows, not by raising.
      throw new RuleViolationError('تعذّر تسجيل طلب الاسترجاع');
    }

    await tx.insert(refundRequestItems).values(
      wanted.map((line) => ({
        refundRequestId: created.id,
        orderItemId: line.id,
        productId: line.productId,
        titleSnapshot: line.titleSnapshot,
        currency: line.currency,
        // Copied from the sale, never recalculated.
        grossMinor: line.unitPriceMinor,
        engineerAmountMinor: line.engineerAmountMinor ?? 0n,
        platformAmountMinor: line.platformAmountMinor ?? 0n,
      })),
    );

    await recordAudit(tx, actor, {
      action: 'REFUND_REQUESTED',
      entityType: 'refund_request',
      entityId: created.id,
      after: {
        reference: created.reference,
        orderNumber: order.orderNumber,
        reason: input.reason,
        amountMinor: amountMinor.toString(),
        currency: order.currency,
        itemCount: wanted.length,
      },
    });

    return {
      refundRequestId: created.id,
      reference: created.reference,
      amountMinor,
      currency: order.currency,
    };
  });
}

/** The customer changes their mind, while the owner has not yet decided. */
export async function withdrawRefundRequest(
  actor: Actor,
  refundRequestId: string,
): Promise<void> {
  requireUser(actor);

  await withActor(actor, async (tx) => {
    const updated = await tx
      .update(refundRequests)
      .set({ status: 'WITHDRAWN', updatedAt: new Date() })
      .where(and(eq(refundRequests.id, refundRequestId), eq(refundRequests.status, 'REQUESTED')))
      .returning({ id: refundRequests.id, reference: refundRequests.reference });

    if (updated.length === 0) {
      throw new NotFoundError('لا يوجد طلب استرجاع قيد المراجعة بهذا المعرّف');
    }

    await recordAudit(tx, actor, {
      action: 'REFUND_WITHDRAWN',
      entityType: 'refund_request',
      entityId: refundRequestId,
      after: { reference: updated[0]!.reference },
    });
  });
}

interface LoadedRequest {
  readonly id: string;
  readonly reference: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly status: string;
}

async function loadPendingRequest(tx: Transaction, id: string): Promise<LoadedRequest> {
  const [row] = await tx.select().from(refundRequests).where(eq(refundRequests.id, id)).limit(1);
  if (!row) throw new NotFoundError('طلب الاسترجاع غير موجود');
  if (row.status !== 'REQUESTED') {
    throw new RuleViolationError('هذا الطلب تمت مراجعته مسبقاً', { status: row.status });
  }
  return row as LoadedRequest;
}

/**
 * THE OWNER APPROVES (specification §17).
 *
 * One transaction:
 *   1. reverse the sale in the ledger, with the sale's own frozen numbers;
 *   2. mark the order lines refunded — WITHOUT touching their snapshot;
 *   3. revoke the entitlements, so the file closes;
 *   4. decrement the product's sales counter, because a refunded sale must
 *      not keep counting as one (§17);
 *   5. move the order to REFUNDED when nothing is left unrefunded;
 *   6. notify the customer and the credited engineers, separately;
 *   7. record the audit entry.
 */
export async function approveRefund(
  actor: Actor,
  input: { refundRequestId: string; decisionNote?: string | null },
): Promise<{ ledgerTransactionId: string; reversedItems: number; amountMinor: bigint }> {
  requireOwner(actor, 'اعتماد الاسترجاع');

  return withActor(actor, async (tx) => {
    const request = await loadPendingRequest(tx, input.refundRequestId);

    const items = await tx
      .select()
      .from(refundRequestItems)
      .where(eq(refundRequestItems.refundRequestId, request.id));

    if (items.length === 0) {
      throw new RuleViolationError('طلب الاسترجاع بلا بنود');
    }

    const orderItemIds = items.map((item) => item.orderItemId);

    // Re-read the sale lines under the owner's own transaction. If any was
    // refunded since the request was made, stop: refunding twice would pay
    // the customer twice and claw back the engineer twice.
    const saleLines = await tx
      .select()
      .from(orderItems)
      .where(inArray(orderItems.id, orderItemIds));

    for (const line of saleLines) {
      if (line.refundedAt !== null) {
        throw new RuleViolationError('أحد البنود مسترجَع مسبقاً', { orderItemId: line.id });
      }
    }

    /*
     * The per-contributor breakdown of the reversal comes from the SPLIT
     * FROZEN AT SALE TIME, not from the product's current credits. A
     * contributor added to the product after the sale is not clawed back for
     * money they were never credited with — and one removed since still is.
     */
    const frozenSplit = await tx
      .select({
        contributorId: orderItemContributors.contributorId,
        amountMinor: orderItemContributors.amountMinor,
      })
      .from(orderItemContributors)
      .where(inArray(orderItemContributors.orderItemId, orderItemIds));

    const sharesByContributor = new Map<string, bigint>();
    for (const row of frozenSplit) {
      sharesByContributor.set(
        row.contributorId,
        (sharesByContributor.get(row.contributorId) ?? 0n) + row.amountMinor,
      );
    }

    const grossMinor = items.reduce((total, item) => total + item.grossMinor, 0n);
    const platformMinor = items.reduce((total, item) => total + item.platformAmountMinor, 0n);
    const engineerMinor = items.reduce((total, item) => total + item.engineerAmountMinor, 0n);
    const splitTotal = [...sharesByContributor.values()].reduce((a, b) => a + b, 0n);

    if (splitTotal !== engineerMinor) {
      // The frozen split and the frozen engineer total disagree. Something is
      // wrong with the SALE, and reversing it would spread the error further.
      throw new MoneyInvariantError(
        'توزيع المساهمين المجمَّد لا يطابق حصة المهندس المجمَّدة',
        {
          refundRequestId: request.id,
          engineerMinor: engineerMinor.toString(),
          splitTotal: splitTotal.toString(),
        },
      );
    }

    const contributorShares: ContributorShare[] = [...sharesByContributor].map(
      ([contributorId, amountMinor]) => ({ contributorId, amountMinor }),
    );

    const now = new Date();

    const ledgerTransactionId = await postLedgerTransaction(
      tx,
      refundEntry({
        refundRequestId: request.id,
        reference: request.reference,
        orderNumber: request.orderNumber,
        currency: request.currency,
        grossMinor,
        platformMinor,
        contributorShares,
        occurredAt: now,
      }),
    );

    // The snapshot columns are untouched; only the refund marks are written.
    // The immutability trigger on order_items enforces that independently.
    const marked = await tx
      .update(orderItems)
      .set({ refundedAt: now, refundRequestId: request.id })
      .where(inArray(orderItems.id, orderItemIds))
      .returning({ id: orderItems.id });

    if (marked.length !== orderItemIds.length) {
      throw new RuleViolationError('لم تُعلَّم كل البنود كمسترجَعة', {
        expected: orderItemIds.length,
        marked: marked.length,
      });
    }

    // §41: access ends when the sale does. The row is revoked, never deleted.
    await tx
      .update(entitlements)
      .set({ revokedAt: now, revokedReason: `استرجاع ${request.reference}` })
      .where(and(inArray(entitlements.orderItemId, orderItemIds), isNull(entitlements.revokedAt)));

    for (const item of items) {
      // §17: a refunded transaction must not keep counting as a final sale.
      // GREATEST guards the counter against going negative if it was ever
      // corrected by hand.
      await tx
        .update(products)
        .set({ salesCount: sql`GREATEST(${products.salesCount} - 1, 0)` })
        .where(eq(products.id, item.productId));

      await notifyProductContributors(tx, item.productId, 'SALE_REVERSED', {
        productTitle: item.titleSnapshot,
        reference: request.reference,
      });
    }

    const remaining = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, request.orderId), isNull(orderItems.refundedAt)));

    if (remaining.length === 0) {
      // Every line is refunded, so the order as a whole is.
      await tx
        .update(orders)
        .set({ status: 'REFUNDED', updatedAt: now })
        .where(eq(orders.id, request.orderId));
    }

    const decided = await tx
      .update(refundRequests)
      .set({
        status: 'APPROVED',
        decidedBy: actor.kind === 'USER' ? actor.userId : null,
        decidedAt: now,
        decisionNote: input.decisionNote ?? null,
        reversalTransactionId: ledgerTransactionId,
        updatedAt: now,
      })
      .where(eq(refundRequests.id, request.id))
      .returning({ id: refundRequests.id });

    if (decided.length === 0) {
      throw new RuleViolationError('تعذّر تسجيل قرار الاسترجاع');
    }

    await notifyUser(tx, {
      userId: request.customerId,
      type: 'REFUND_APPROVED',
      payload: { reference: request.reference, orderNumber: request.orderNumber },
    });

    await recordAudit(tx, actor, {
      action: 'REFUND_ISSUED',
      entityType: 'refund_request',
      entityId: request.id,
      after: {
        reference: request.reference,
        orderNumber: request.orderNumber,
        grossMinor: grossMinor.toString(),
        platformMinor: platformMinor.toString(),
        engineerMinor: engineerMinor.toString(),
        currency: request.currency,
        ledgerTransactionId,
        reversedItems: items.length,
      },
    });

    return { ledgerTransactionId, reversedItems: items.length, amountMinor: grossMinor };
  });
}

/** The owner declines. Nothing financial happens; the refusal is recorded. */
export async function rejectRefund(
  actor: Actor,
  input: { refundRequestId: string; decisionNote: string },
): Promise<void> {
  requireOwner(actor, 'رفض الاسترجاع');

  const note = input.decisionNote.trim();
  if (note.length === 0) {
    throw new RuleViolationError('اذكر سبب رفض طلب الاسترجاع');
  }

  await withActor(actor, async (tx) => {
    const request = await loadPendingRequest(tx, input.refundRequestId);

    const updated = await tx
      .update(refundRequests)
      .set({
        status: 'REJECTED',
        decidedBy: actor.kind === 'USER' ? actor.userId : null,
        decidedAt: new Date(),
        decisionNote: note,
        updatedAt: new Date(),
      })
      .where(eq(refundRequests.id, request.id))
      .returning({ id: refundRequests.id });

    if (updated.length === 0) {
      throw new RuleViolationError('تعذّر تسجيل رفض الاسترجاع');
    }

    await notifyUser(tx, {
      userId: request.customerId,
      type: 'REFUND_REJECTED',
      payload: { reference: request.reference, reason: note },
    });

    await recordAudit(tx, actor, {
      action: 'REFUND_REJECTED',
      entityType: 'refund_request',
      entityId: request.id,
      after: { reference: request.reference, reason: note },
    });
  });
}

/**
 * The money actually went back.
 *
 * A separate step from approval because on a manual payment method they are a
 * separate act, often days apart. Until this runs, the books correctly say the
 * platform still holds cash it owes the customer.
 */
export async function markRefundPaid(
  actor: Actor,
  input: { refundRequestId: string; payoutReference?: string | null },
): Promise<{ ledgerTransactionId: string }> {
  requireOwner(actor, 'تسجيل صرف الاسترجاع');

  return withActor(actor, async (tx) => {
    const [request] = await tx
      .select()
      .from(refundRequests)
      .where(eq(refundRequests.id, input.refundRequestId))
      .limit(1);

    if (!request) throw new NotFoundError('طلب الاسترجاع غير موجود');
    if (request.status !== 'APPROVED') {
      throw new RuleViolationError('لا يُسجَّل الصرف إلا لاسترجاع معتمد', {
        status: request.status,
      });
    }

    const now = new Date();
    const ledgerTransactionId = await postLedgerTransaction(
      tx,
      refundPayoutEntry({
        refundRequestId: request.id,
        reference: request.reference,
        currency: request.currency,
        grossMinor: request.amountMinor,
        occurredAt: now,
        payoutReference: input.payoutReference ?? null,
      }),
    );

    const updated = await tx
      .update(refundRequests)
      .set({
        status: 'PAID',
        paidAt: now,
        payoutReference: input.payoutReference ?? null,
        updatedAt: now,
      })
      .where(eq(refundRequests.id, request.id))
      .returning({ id: refundRequests.id });

    if (updated.length === 0) {
      throw new RuleViolationError('تعذّر تسجيل صرف الاسترجاع');
    }

    await notifyUser(tx, {
      userId: request.customerId,
      type: 'REFUND_PAID',
      payload: { reference: request.reference, orderNumber: request.orderNumber },
    });

    await recordAudit(tx, actor, {
      action: 'REFUND_PAID',
      entityType: 'refund_request',
      entityId: request.id,
      after: {
        reference: request.reference,
        amountMinor: request.amountMinor.toString(),
        currency: request.currency,
        payoutReference: input.payoutReference ?? null,
        ledgerTransactionId,
      },
    });

    return { ledgerTransactionId };
  });
}
