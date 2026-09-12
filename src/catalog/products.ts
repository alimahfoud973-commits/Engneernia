import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { products, productPrices, productContributors } from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { authorize } from '@/authz/policy';
import { isOwner, type Actor } from '@/authz/actor';
import { notifyProductContributors } from '@/notifications/notify';
import { assertTransition, type ProductStatus, type PublishReadiness } from './publication';
import { money, type Money } from '@/lib/money/money';
import { assertSharesValid, type ContributorShare } from '@/lib/money/distribution';
import { NotFoundError, RuleViolationError } from '@/lib/errors';

/**
 * Owner-facing catalogue operations.
 *
 * Every function here follows the same shape: authorise, act, audit, notify —
 * all inside ONE transaction, so an action cannot be recorded without being
 * performed, or performed without being recorded.
 */

/** The price in force right now: the single open row (effective_to IS NULL). */
export async function currentPrice(tx: Transaction, productId: string): Promise<Money | null> {
  const [row] = await tx
    .select({ amountMinor: productPrices.amountMinor, currency: productPrices.currency })
    .from(productPrices)
    .where(and(eq(productPrices.productId, productId), isNull(productPrices.effectiveTo)))
    .limit(1);

  return row ? money(row.amountMinor, row.currency) : null;
}

/** Full price history, newest first. Owner and credited contributors only —
 *  RLS enforces that independently of this function being called correctly. */
export async function priceHistory(tx: Transaction, productId: string) {
  return tx
    .select()
    .from(productPrices)
    .where(eq(productPrices.productId, productId))
    .orderBy(desc(productPrices.effectiveFrom));
}

/**
 * Change a product's price (specification §34).
 *
 * Five things happen together or not at all:
 *   1. the old price row is closed, the new one opened (never updated in place);
 *   2. the product's derived flags are refreshed;
 *   3. the change is written to the audit log;
 *   4. ONLY the credited engineers are notified;
 *   5. historical orders are not touched — they carry their own snapshot.
 */
export async function changeProductPrice(
  actor: Actor,
  input: {
    productId: string;
    newAmountMinor: bigint;
    currency: string;
    reason?: string;
  },
): Promise<{ previous: Money | null; next: Money; notified: number }> {
  authorize(actor, 'contributor.readAnyFinancials');
  if (!isOwner(actor)) {
    throw new RuleViolationError('تغيير السعر من صلاحية مالك المنصة وحده');
  }

  return withActor(actor, async (tx) => {
    const [product] = await tx
      .select({ id: products.id, titleAr: products.titleAr })
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);

    if (!product) throw new NotFoundError('المنتج غير موجود');

    const previous = await currentPrice(tx, input.productId);

    // Atomic close-and-open, guarded by the partial unique index that permits
    // exactly one open price row per product.
    await tx.execute(sql`
      SELECT app_set_product_price(
        ${input.productId}::uuid,
        ${input.newAmountMinor}::bigint,
        ${input.currency},
        ${actor.kind === 'USER' ? actor.userId : null}::uuid,
        ${input.reason ?? null}
      )
    `);

    const next = money(input.newAmountMinor, input.currency);

    await recordAudit(tx, actor, {
      action: 'PRICE_CHANGED',
      entityType: 'product',
      entityId: input.productId,
      before: previous
        ? { amountMinor: previous.amountMinor.toString(), currency: previous.currency }
        : null,
      after: { amountMinor: next.amountMinor.toString(), currency: next.currency },
    });

    // §33: only the responsible contributor hears about it.
    const notified = await notifyProductContributors(tx, input.productId, 'PRODUCT_PRICE_CHANGED', {
      productTitle: product.titleAr,
      newAmountMinor: next.amountMinor.toString(),
      currency: next.currency,
    });

    return { previous, next, notified };
  });
}

/** Move a product through the publication workflow. */
export async function changeProductStatus(
  actor: Actor,
  input: { productId: string; to: ProductStatus; note?: string },
): Promise<ProductStatus> {
  return withActor(actor, async (tx) => {
    const [product] = await tx
      .select({ id: products.id, status: products.status, titleAr: products.titleAr })
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);

    // RLS already hid products this actor may not see, so "not found" here
    // covers both "absent" and "not yours" without distinguishing them.
    if (!product) throw new NotFoundError('المنتج غير موجود');

    const readiness = await publishReadiness(tx, input.productId);
    assertTransition(product.status, input.to, actor, readiness);

    if (isOwner(actor)) {
      const updated = await tx
        .update(products)
        .set({
          status: input.to,
          publishedAt: input.to === 'PUBLISHED' ? new Date() : undefined,
          updatedAt: new Date(),
        })
        .where(eq(products.id, input.productId))
        .returning({ id: products.id });

      // RLS refuses a write by returning ZERO ROWS, not by raising. Without
      // this check an unauthorised transition would look like a success and
      // the audit log would record a change that never happened.
      if (updated.length === 0) {
        throw new RuleViolationError('لم يُطبَّق تغيير الحالة', {
          productId: input.productId,
          to: input.to,
        });
      }
    } else {
      // A contributor has no write policy on `products` at all. Their one
      // permitted move goes through a narrow SECURITY DEFINER function that
      // can only reach products they are credited on, only when the owner has
      // granted draft rights, and only into SUBMITTED.
      if (input.to !== 'SUBMITTED') {
        throw new RuleViolationError('انتقال غير مسموح في سير عمل النشر', {
          from: product.status,
          to: input.to,
        });
      }
      await tx.execute(
        sql`SELECT app_submit_product_for_review(${input.productId}::uuid)`,
      );
    }

    await recordAudit(tx, actor, {
      action:
        input.to === 'PUBLISHED'
          ? 'PRODUCT_PUBLISHED'
          : input.to === 'UNPUBLISHED'
            ? 'PRODUCT_UNPUBLISHED'
            : 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: input.productId,
      before: { status: product.status },
      after: { status: input.to, note: input.note ?? null },
    });

    const notificationType =
      input.to === 'PUBLISHED'
        ? 'PRODUCT_PUBLISHED'
        : input.to === 'UNPUBLISHED'
          ? 'PRODUCT_UNPUBLISHED'
          : input.to === 'APPROVED'
            ? 'PRODUCT_APPROVED'
            : input.to === 'REVISION_REQUESTED'
              ? 'PRODUCT_REVISION_REQUESTED'
              : null;

    if (notificationType) {
      await notifyProductContributors(tx, input.productId, notificationType, {
        productTitle: product.titleAr,
        note: input.note ?? null,
      });
    }

    return input.to;
  });
}

async function publishReadiness(tx: Transaction, productId: string): Promise<PublishReadiness> {
  const [credits] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(productContributors)
    .where(eq(productContributors.productId, productId));

  const price = await currentPrice(tx, productId);

  return {
    hasContributor: (credits?.count ?? 0) > 0,
    hasCurrentPrice: price !== null,
    // Media arrives in phase P3; until then these are not yet gating.
    hasOriginalFile: true,
    hasPreview: true,
  };
}

/**
 * Set who is credited on a product and with what share (decisions §6).
 * Owner-only: a contributor can neither add themselves nor change a share.
 */
export async function setProductContributors(
  actor: Actor,
  productId: string,
  shares: readonly ContributorShare[],
): Promise<void> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('توزيع الحصص من صلاحية مالك المنصة وحده');
  }

  // Throws unless the shares total exactly 100%.
  assertSharesValid(shares);

  await withActor(actor, async (tx) => {
    const before = await tx
      .select()
      .from(productContributors)
      .where(eq(productContributors.productId, productId));

    await tx.delete(productContributors).where(eq(productContributors.productId, productId));
    await tx.insert(productContributors).values(
      shares.map((share) => ({
        productId,
        contributorId: share.contributorId,
        shareBp: share.shareBp,
      })),
    );

    await recordAudit(tx, actor, {
      action: 'COMMISSION_CHANGED',
      entityType: 'product',
      entityId: productId,
      before: before.map((r) => ({ contributorId: r.contributorId, shareBp: r.shareBp })),
      after: shares.map((s) => ({ contributorId: s.contributorId, shareBp: s.shareBp })),
    });

    await notifyProductContributors(tx, productId, 'COMMISSION_CHANGED', {});
  });
}
