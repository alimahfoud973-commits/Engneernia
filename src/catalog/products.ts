import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { products, productPrices, productContributors, productFiles } from '@/db/schema';
import { serverEnv } from '@/lib/config/env';
import { supportsPreview } from '@/media/file-types';
import { isServable } from '@/media/scanner';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { authorize } from '@/authz/policy';
import { isOwner, type Actor } from '@/authz/actor';
import { notifyProductContributors } from '@/notifications/notify';
import { assertTransition, type ProductStatus, type PublishReadiness } from './publication';
import { money, type Money } from '@/lib/money/money';
import { assertSharesValid, type ContributorShare } from '@/lib/money/distribution';
import { keepPublishedSellable, productSaleBlockers } from '@/finance/commission-resolver';
import { NotFoundError, RuleViolationError } from '@/lib/errors';

/**
 * Owner-facing catalogue operations.
 *
 * Every function here follows the same shape: authorise, act, audit, notify —
 * all inside ONE transaction, so an action cannot be recorded without being
 * performed, or performed without being recorded.
 */

/**
 * ===========================================================================
 * CREATE A PRODUCT (specification §26, §27)
 * ===========================================================================
 * Owner-only, and it creates a DRAFT and nothing else. A product is not
 * publishable at birth: it has no price, no credited engineer and no file, and
 * `publishBlockers` refuses every one of those absences. That is deliberate —
 * the workflow exists so that a half-built product cannot reach a customer,
 * and a create that jumped straight to PUBLISHED would be a way around it.
 *
 * THE SLUG IS TYPED, NOT DERIVED. Deriving it from an Arabic title would
 * produce either a percent-encoded URL nobody can read or a transliteration
 * nobody agrees on, and the slug is permanent: it is the product's address.
 * So the owner chooses it, and the database's unique index is what makes it
 * unique — not a check here that two concurrent creates could both pass.
 * ===========================================================================
 */
export interface CreateProductInput {
  readonly slug: string;
  readonly titleAr: string;
  readonly subtitleAr?: string | null;
  readonly descriptionAr?: string | null;
  readonly disciplineId: string;
  readonly categoryId?: string | null;
  readonly fileType: 'PDF' | 'EXCEL' | 'CAD' | 'REVIT_BIM' | 'ARCHIVE' | 'TEMPLATE' | 'PROJECT' | 'OTHER';
  readonly level?: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | null;
  readonly currency: string;
  readonly softwareTags?: readonly string[];
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function createProduct(
  actor: Actor,
  input: CreateProductInput,
): Promise<{ productId: string; slug: string }> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('إنشاء المنتجات من صلاحية مالك المنصة وحده');
  }

  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new RuleViolationError(
      'العنوان اللطيف يُكتب بحروف لاتينية صغيرة وأرقام وشرطات فقط (مثال: foundation-design-guide)',
      { slug: input.slug },
    );
  }
  if (input.titleAr.trim() === '') {
    throw new RuleViolationError('عنوان المنتج مطلوب');
  }

  return withActor(actor, async (tx) => {
    const [created] = await tx
      .insert(products)
      .values({
        slug,
        titleAr: input.titleAr.trim(),
        subtitleAr: input.subtitleAr?.trim() || null,
        descriptionAr: input.descriptionAr?.trim() || null,
        disciplineId: input.disciplineId,
        categoryId: input.categoryId || null,
        fileType: input.fileType,
        level: input.level || null,
        currency: input.currency,
        softwareTags: [...(input.softwareTags ?? [])],
        // Born a draft, always. Everything else is a later, checked transition.
        status: 'DRAFT',
        createdBy: actor.kind === 'USER' ? actor.userId : null,
      })
      .returning({ id: products.id, slug: products.slug });

    if (!created) {
      // RLS refuses a write by returning zero rows rather than raising.
      throw new RuleViolationError('رُفض إنشاء المنتج');
    }

    await recordAudit(tx, actor, {
      action: 'PRODUCT_CREATED',
      entityType: 'product',
      entityId: created.id,
      after: { slug: created.slug, titleAr: input.titleAr, disciplineId: input.disciplineId },
    });

    return { productId: created.id, slug: created.slug };
  });
}

/** Edit the descriptive fields of a product that is not yet published. */
export async function updateProductDetails(
  actor: Actor,
  input: {
    productId: string;
    titleAr: string;
    subtitleAr?: string | null;
    descriptionAr?: string | null;
    level?: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | null;
    softwareTags?: readonly string[];
  },
): Promise<void> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('تعديل المنتجات من صلاحية مالك المنصة وحده');
  }

  await withActor(actor, async (tx) => {
    const [before] = await tx
      .select({ titleAr: products.titleAr, status: products.status })
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);

    if (!before) throw new NotFoundError('المنتج غير موجود');

    const updated = await tx
      .update(products)
      .set({
        titleAr: input.titleAr.trim(),
        subtitleAr: input.subtitleAr?.trim() || null,
        descriptionAr: input.descriptionAr?.trim() || null,
        level: input.level || null,
        softwareTags: [...(input.softwareTags ?? [])],
        updatedAt: new Date(),
      })
      .where(eq(products.id, input.productId))
      .returning({ id: products.id });

    if (updated.length === 0) {
      throw new RuleViolationError('لم يُطبَّق تعديل المنتج', { productId: input.productId });
    }

    await recordAudit(tx, actor, {
      action: 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: input.productId,
      before: { titleAr: before.titleAr },
      after: { titleAr: input.titleAr },
    });
  });
}

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
    // exactly one open price row per product. On a published product, refused
    // if the new price or currency has no matching agreement (F2) — a free
    // product given a price is exactly that case.
    await keepPublishedSellable(tx, [input.productId], () =>
      tx.execute(sql`
        SELECT app_set_product_price(
          ${input.productId}::uuid,
          ${input.newAmountMinor}::bigint,
          ${input.currency},
          ${actor.kind === 'USER' ? actor.userId : null}::uuid,
          ${input.reason ?? null}
        )
      `),
    );

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
    const query = tx
      .select({ id: products.id, status: products.status, titleAr: products.titleAr })
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);
    // Publishing locks the row, so a concurrent agreement, price or credit
    // change (which locks it too) cannot slip between the readiness check and
    // the publish (F2). Only the owner publishing: a lock asks for the update
    // policy, which a contributor has not got — their attempt must still be
    // refused as an illegal transition, not hidden as "not found".
    const [product] =
      input.to === 'PUBLISHED' && isOwner(actor) ? await query.for('update') : await query;

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

  const [product] = await tx
    .select({ fileType: products.fileType })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  const files = await tx
    .select({ role: productFiles.role, scanStatus: productFiles.scanStatus })
    .from(productFiles)
    .where(eq(productFiles.productId, productId));

  const original = files.find((f) => f.role === 'ORIGINAL');
  const isProduction = serverEnv().NODE_ENV === 'production';

  return {
    hasContributor: (credits?.count ?? 0) > 0,
    hasCurrentPrice: price !== null,
    hasOriginalFile: original !== undefined,
    hasPreview: files.some((f) => f.role === 'PREVIEW'),
    // Owner decision: a preview exists for PDF and for nothing else.
    requiresPreview: product ? supportsPreview(product.fileType) : false,
    fileIsServable: original ? isServable(original.scanStatus, isProduction) : false,
    commissionBlockers: (await productSaleBlockers(tx, productId)).map((b) => b.message),
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

    // On a published product, refused if a newly credited engineer has no
    // agreement matching the price (F2).
    await keepPublishedSellable(tx, [productId], async () => {
      await tx.delete(productContributors).where(eq(productContributors.productId, productId));
      await tx.insert(productContributors).values(
        shares.map((share) => ({
          productId,
          contributorId: share.contributorId,
          shareBp: share.shareBp,
        })),
      );
    });

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
