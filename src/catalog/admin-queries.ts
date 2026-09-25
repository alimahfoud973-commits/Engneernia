import 'server-only';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  categories, contributors, disciplines, productContributors, productFiles,
  productPrices, products,
} from '@/db/schema';
import { withActor } from '@/db/actor-context';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError } from '@/lib/errors';
import { publishBlockers, transitionsFrom, type ProductStatus } from './publication';
import { supportsPreview } from '@/media/file-types';
import { isServable } from '@/media/scanner';
import { serverEnv } from '@/lib/config/env';
import { productSaleBlockers } from '@/finance/commission-resolver';

/**
 * Read models for the owner's catalogue screens.
 *
 * OWNER-ONLY AT THE DOOR as well as underneath. The policy on `products`
 * already admits a contributor to their own drafts, so without these guards a
 * contributor opening the admin list would see a working page containing their
 * own products — a screen that half-works, which is harder to notice than one
 * that refuses.
 */

export interface AdminProductRow {
  readonly id: string;
  readonly slug: string;
  readonly titleAr: string;
  readonly status: ProductStatus;
  readonly disciplineNameAr: string;
  readonly priceMinor: bigint | null;
  readonly currency: string;
  readonly contributorCount: number;
  readonly hasOriginal: boolean;
  readonly salesCount: number;
}

export async function adminProductList(actor: Actor): Promise<readonly AdminProductRow[]> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('إدارة الكتالوج من صلاحية مالك المنصة وحده');
  }

  return withActor(actor, async (tx) => {
    const rows = await tx
      .select({
        id: products.id,
        slug: products.slug,
        titleAr: products.titleAr,
        status: products.status,
        currency: products.currency,
        salesCount: products.salesCount,
        disciplineNameAr: disciplines.nameAr,
        priceMinor: productPrices.amountMinor,
      })
      .from(products)
      .innerJoin(disciplines, eq(disciplines.id, products.disciplineId))
      .leftJoin(
        productPrices,
        and(eq(productPrices.productId, products.id), isNull(productPrices.effectiveTo)),
      )
      .orderBy(desc(products.updatedAt))
      .limit(300);

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    /*
     * `inArray`, not a raw `= ANY(${ids})`. Interpolating a JavaScript array
     * into a template fragment expands it to one placeholder PER ELEMENT, so
     * the query became `= ANY(($1, $2, ... $300))` — a row constructor, which
     * PostgreSQL refuses with "op ANY/ALL (array) requires array on right
     * side". It compiled, it linted, and it threw on the first real page load.
     */
    const credits = await tx
      .select({ productId: productContributors.productId })
      .from(productContributors)
      .where(inArray(productContributors.productId, ids));
    const files = await tx
      .select({ productId: productFiles.productId, role: productFiles.role })
      .from(productFiles)
      .where(inArray(productFiles.productId, ids));

    const creditCount = new Map<string, number>();
    for (const c of credits) creditCount.set(c.productId, (creditCount.get(c.productId) ?? 0) + 1);
    const withOriginal = new Set(files.filter((f) => f.role === 'ORIGINAL').map((f) => f.productId));

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      titleAr: row.titleAr,
      status: row.status as ProductStatus,
      disciplineNameAr: row.disciplineNameAr,
      priceMinor: row.priceMinor,
      currency: row.currency,
      contributorCount: creditCount.get(row.id) ?? 0,
      hasOriginal: withOriginal.has(row.id),
      salesCount: row.salesCount,
    }));
  });
}

export interface AdminProductDetail {
  readonly id: string;
  readonly slug: string;
  readonly titleAr: string;
  readonly subtitleAr: string | null;
  readonly descriptionAr: string | null;
  readonly status: ProductStatus;
  readonly fileType: string;
  readonly level: string | null;
  readonly currency: string;
  readonly softwareTags: readonly string[];
  readonly disciplineNameAr: string;
  readonly priceMinor: bigint | null;
  readonly priceHistory: ReadonlyArray<{
    readonly amountMinor: bigint;
    readonly effectiveFrom: Date;
    readonly effectiveTo: Date | null;
    readonly reason: string | null;
  }>;
  readonly credits: ReadonlyArray<{
    readonly contributorId: string;
    readonly displayName: string;
    readonly shareBp: number;
  }>;
  readonly files: ReadonlyArray<{ readonly role: string; readonly scanStatus: string }>;
  /** What still stands between this product and being publishable. */
  readonly blockers: readonly string[];
  /** The moves the owner may make from here, with their Arabic labels. */
  readonly nextStates: ReadonlyArray<{ readonly to: ProductStatus; readonly label: string }>;
}

export async function adminProductDetail(
  actor: Actor,
  productId: string,
): Promise<AdminProductDetail> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('إدارة الكتالوج من صلاحية مالك المنصة وحده');
  }

  return withActor(actor, async (tx) => {
    const [product] = await tx
      .select({
        id: products.id, slug: products.slug, titleAr: products.titleAr,
        subtitleAr: products.subtitleAr, descriptionAr: products.descriptionAr,
        status: products.status, fileType: products.fileType, level: products.level,
        currency: products.currency, softwareTags: products.softwareTags,
        disciplineNameAr: disciplines.nameAr,
      })
      .from(products)
      .innerJoin(disciplines, eq(disciplines.id, products.disciplineId))
      .where(eq(products.id, productId))
      .limit(1);

    if (!product) throw new NotFoundError('المنتج غير موجود');

    const prices = await tx
      .select({
        amountMinor: productPrices.amountMinor,
        effectiveFrom: productPrices.effectiveFrom,
        effectiveTo: productPrices.effectiveTo,
        reason: productPrices.reason,
      })
      .from(productPrices)
      .where(eq(productPrices.productId, productId))
      .orderBy(desc(productPrices.effectiveFrom))
      .limit(20);

    const credits = await tx
      .select({
        contributorId: productContributors.contributorId,
        shareBp: productContributors.shareBp,
        displayName: contributors.displayName,
      })
      .from(productContributors)
      .innerJoin(contributors, eq(contributors.id, productContributors.contributorId))
      .where(eq(productContributors.productId, productId));

    const files = await tx
      .select({ role: productFiles.role, scanStatus: productFiles.scanStatus })
      .from(productFiles)
      .where(eq(productFiles.productId, productId));

    const original = files.find((f) => f.role === 'ORIGINAL');
    const isProduction = serverEnv().NODE_ENV === 'production';
    const blockers = publishBlockers({
      hasContributor: credits.length > 0,
      hasCurrentPrice: prices.some((p) => p.effectiveTo === null),
      hasOriginalFile: original !== undefined,
      hasPreview: files.some((f) => f.role === 'PREVIEW'),
      requiresPreview: supportsPreview(product.fileType),
      fileIsServable: original ? isServable(original.scanStatus, isProduction) : false,
      // The same check the publish itself runs, so the checklist cannot differ.
      commissionBlockers: (await productSaleBlockers(tx, productId)).map((b) => b.message),
    });

    return {
      ...product,
      status: product.status as ProductStatus,
      level: product.level,
      softwareTags: product.softwareTags,
      priceMinor: prices.find((p) => p.effectiveTo === null)?.amountMinor ?? null,
      priceHistory: prices,
      credits,
      files,
      blockers,
      nextStates: transitionsFrom(product.status as ProductStatus, 'OWNER').map((t) => ({
        to: t.to, label: t.label,
      })),
    };
  });
}

/** Disciplines, categories and engineers — the pickers the forms need. */
export async function catalogueOptions(actor: Actor) {
  if (!isOwner(actor)) {
    throw new RuleViolationError('إدارة الكتالوج من صلاحية مالك المنصة وحده');
  }

  return withActor(actor, async (tx) => {
    const [disciplineRows, categoryRows, contributorRows] = await Promise.all([
      tx.select({ id: disciplines.id, nameAr: disciplines.nameAr })
        .from(disciplines).orderBy(disciplines.sortOrder).limit(50),
      tx.select({ id: categories.id, nameAr: categories.nameAr, disciplineId: categories.disciplineId })
        .from(categories).orderBy(categories.nameAr).limit(300),
      tx.select({ id: contributors.id, displayName: contributors.displayName })
        .from(contributors).where(eq(contributors.isActive, true))
        .orderBy(contributors.displayName).limit(300),
    ]);
    return { disciplines: disciplineRows, categories: categoryRows, contributors: contributorRows };
  });
}
