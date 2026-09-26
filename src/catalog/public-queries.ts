import 'server-only';
import { cache } from 'react';
import { and, asc, desc, eq, isNull, or, ilike, sql } from 'drizzle-orm';
import { withActor } from '@/db/actor-context';
import { GUEST } from '@/authz/actor';
import { categories, contributors, disciplines, productFiles, productPrices, products } from '@/db/schema';

/**
 * ===========================================================================
 * PUBLIC CATALOGUE QUERIES
 * ===========================================================================
 * Every function here runs as GUEST, so PostgreSQL's policies apply: an
 * unpublished product is not merely filtered out by the WHERE clause below,
 * it is invisible to the connection.
 *
 * The returned shapes are DTOs, never entities (CLAUDE.md rule 6). Commission,
 * revenue share and price history have no field on these types — they are
 * ABSENT, not hidden, so no template change can ever expose them.
 * ===========================================================================
 */

export interface PublicProductCard {
  readonly slug: string;
  readonly titleAr: string;
  readonly subtitleAr: string | null;
  readonly disciplineSlug: string;
  readonly disciplineNameAr: string;
  readonly categoryNameAr: string | null;
  readonly fileType: string;
  readonly level: string | null;
  readonly isFree: boolean;
  readonly priceMinor: string | null;
  readonly currency: string;
  readonly publishedAt: Date | null;
}

export interface PublicAuthor {
  readonly contributorSlug: string;
  readonly displayName: string;
  readonly specialization: string | null;
}

export interface PublicProductDetail extends PublicProductCard {
  /**
   * Declared because the query already selects it and the ratings block needs
   * it. Not a disclosure: the row it names is the public product the visitor
   * is looking at, and nothing is reachable by holding the id that is not
   * reachable by holding the slug.
   */
  readonly id: string;
  readonly descriptionAr: string | null;
  readonly language: string;
  readonly softwareTags: readonly string[];
  readonly authors: readonly PublicAuthor[];
  /** Whether a public preview exists. PDF only, by the owner's decision. */
  readonly hasPreview: boolean;
  /** Pages in the preview, and in the source — both public facts. */
  readonly previewPageCount: number | null;
  readonly totalPageCount: number | null;
}

export interface PublicDiscipline {
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly descriptionAr: string | null;
  readonly iconKey: string | null;
  readonly productCount: number;
}

const cardColumns = {
  slug: products.slug,
  titleAr: products.titleAr,
  subtitleAr: products.subtitleAr,
  disciplineSlug: disciplines.slug,
  disciplineNameAr: disciplines.nameAr,
  categoryNameAr: categories.nameAr,
  fileType: products.fileType,
  level: products.level,
  isFree: products.isFree,
  priceMinor: productPrices.amountMinor,
  currency: products.currency,
  publishedAt: products.publishedAt,
};

/** Joins the ONE open price row. Closed (historical) rows never join. */
const withCurrentPrice = () =>
  sql`${productPrices.productId} = ${products.id} AND ${productPrices.effectiveTo} IS NULL`;

function toCard(row: Record<string, unknown>): PublicProductCard {
  return {
    slug: row.slug as string,
    titleAr: row.titleAr as string,
    subtitleAr: (row.subtitleAr as string | null) ?? null,
    disciplineSlug: row.disciplineSlug as string,
    disciplineNameAr: row.disciplineNameAr as string,
    categoryNameAr: (row.categoryNameAr as string | null) ?? null,
    fileType: row.fileType as string,
    level: (row.level as string | null) ?? null,
    isFree: row.isFree as boolean,
    priceMinor: row.priceMinor == null ? null : String(row.priceMinor),
    currency: row.currency as string,
    publishedAt: (row.publishedAt as Date | null) ?? null,
  };
}

/**
 * ===========================================================================
 * HOW MANY PUBLISHED PRODUCTS EACH GROUPING HAS
 * ===========================================================================
 * Counted with a GROUPED JOIN, and never again with a correlated subquery
 * written inside a `sql` fragment. What was here before:
 *
 *     SELECT count(*) FROM products p WHERE p.discipline_id = ${disciplines.id}
 *
 * Drizzle emits a bare `"id"` for that reference when the outer query has no
 * join — and PostgreSQL resolves an unqualified name against the INNERMOST
 * scope first, where `products p` also has an `id`. So the condition compiled
 * to `p.discipline_id = p.id`: never true, no error, **every discipline on the
 * home page reported 0 published resources** while the catalogue held 5,009.
 *
 * It was invisible to every check the project had. The types were right, the
 * SQL was valid, no test asserted a non-zero count, and the number rendered
 * happily as "0 مورد منشور". It was found by LOOKING AT THE PAGE.
 *
 * A join is the fix rather than a qualified name, for two reasons: Drizzle
 * qualifies every column once a join is present, so the ambiguity cannot come
 * back; and one grouped scan replaces one subquery per row.
 * ===========================================================================
 */
export async function listDisciplines(): Promise<readonly PublicDiscipline[]> {
  return withActor(GUEST, async (tx) => {
    const publishedPerDiscipline = tx
      .select({
        disciplineId: products.disciplineId,
        total: sql<number>`count(*)::int`.as('total'),
      })
      .from(products)
      .where(eq(products.status, 'PUBLISHED'))
      .groupBy(products.disciplineId)
      .as('published_per_discipline');

    const rows = await tx
      .select({
        slug: disciplines.slug,
        nameAr: disciplines.nameAr,
        nameEn: disciplines.nameEn,
        descriptionAr: disciplines.descriptionAr,
        iconKey: disciplines.iconKey,
        // A discipline with nothing published has no row to join to.
        productCount: sql<number>`COALESCE(${publishedPerDiscipline.total}, 0)`,
      })
      .from(disciplines)
      .leftJoin(
        publishedPerDiscipline,
        eq(publishedPerDiscipline.disciplineId, disciplines.id),
      )
      .where(eq(disciplines.isActive, true))
      .orderBy(disciplines.sortOrder);

    return rows.map((row) => ({ ...row, productCount: Number(row.productCount) }));
  });
}

export interface NavDiscipline {
  readonly slug: string;
  readonly nameAr: string;
}

/**
 * The disciplines the site header links to (D3).
 *
 * The header wrote the four disciplines into its own source, so the owner's
 * right to add, rename, disable and reorder them (owner decisions §12; D-12:
 * "disciplines are data, not code") stopped at the one element on every
 * page: a disabled discipline stayed in the header and led to a 404, a new
 * one never appeared, a rename or a reorder did not show.
 *
 * Deliberately not `listDisciplines`: the header needs no product counts, and
 * those cost a grouped scan of the products table on every page. This reads
 * two columns through `disciplines_active_order_idx`.
 *
 * `is_active` is filtered here AND by the GUEST policy (`disciplines_select`),
 * so a disabled discipline is absent twice over. `name_ar` is shown exactly as
 * the owner wrote it. `slug` breaks ties in `sort_order`, so two disciplines
 * sharing a position cannot swap places between requests.
 *
 * `cache()` deduplicates within one render pass, as `getPublicSettings` does.
 */
export const navDisciplines = cache(async (): Promise<readonly NavDiscipline[]> =>
  withActor(GUEST, (tx) =>
    tx
      .select({ slug: disciplines.slug, nameAr: disciplines.nameAr })
      .from(disciplines)
      .where(eq(disciplines.isActive, true))
      .orderBy(asc(disciplines.sortOrder), asc(disciplines.slug)),
  ),
);

/**
 * "Newest first", written the one way the whole catalogue writes it.
 *
 * TWO THINGS ARE LOAD-BEARING HERE, and both were missing from the home page's
 * lists until P8.
 *
 * `NULLS LAST` — a product with no publication date has no place at the top of
 * a list of the most recent. No published row has a null date today, so this
 * changes no result; it is here because it must MATCH the index
 * `products_recent_idx` exactly, and a mismatched null placement silently
 * costs a sequential scan of the whole table.
 *
 * `id DESC` — published_at is not unique. Without a total order PostgreSQL may
 * return ties in any order and need not repeat itself, so page 1 and page 2 of
 * a listing can overlap: one product shown twice, another never shown at all.
 * The search page has carried this tiebreaker since P4; these lists did not.
 */
const newestFirst = [sql`${products.publishedAt} DESC NULLS LAST`, desc(products.id)] as const;

export async function latestProducts(limit = 8): Promise<readonly PublicProductCard[]> {
  return withActor(GUEST, async (tx) => {
    const rows = await tx
      .select(cardColumns)
      .from(products)
      .innerJoin(disciplines, eq(disciplines.id, products.disciplineId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(productPrices, withCurrentPrice())
      .where(eq(products.status, 'PUBLISHED'))
      .orderBy(...newestFirst)
      .limit(limit);
    return rows.map(toCard);
  });
}

/** Best sellers (specification §29, §45). Ordered by the denormalised counter
 *  the sales path maintains, over published rows only. */
export async function bestSellers(limit = 4): Promise<readonly PublicProductCard[]> {
  return withActor(GUEST, async (tx) => {
    const rows = await tx
      .select(cardColumns)
      .from(products)
      .innerJoin(disciplines, eq(disciplines.id, products.disciplineId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(productPrices, withCurrentPrice())
      .where(and(eq(products.status, 'PUBLISHED'), sql`${products.salesCount} > 0`))
      .orderBy(desc(products.salesCount), desc(products.publishedAt))
      .limit(limit);
    return rows.map(toCard);
  });
}

export async function freeProducts(limit = 4): Promise<readonly PublicProductCard[]> {
  return withActor(GUEST, async (tx) => {
    const rows = await tx
      .select(cardColumns)
      .from(products)
      .innerJoin(disciplines, eq(disciplines.id, products.disciplineId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(productPrices, withCurrentPrice())
      .where(and(eq(products.status, 'PUBLISHED'), eq(products.isFree, true)))
      .orderBy(...newestFirst)
      .limit(limit);
    return rows.map(toCard);
  });
}

/**
 * How many products a portal or profile page renders before deferring to
 * search.
 *
 * These pages used to render EVERY published product. At 1,253 products a
 * discipline page was 3.2 MB of HTML and a contributor profile 12.8 MB —
 * unusable on a phone, and invisible until the catalogue was seeded to scale.
 * The rest is one click away in search, which is paginated and indexed.
 */
export const PORTAL_PREVIEW_LIMIT = 12;
export const PROFILE_PREVIEW_LIMIT = 24;

export async function disciplineBySlug(slug: string) {
  return withActor(GUEST, async (tx) => {
    const [discipline] = await tx
      .select({
        id: disciplines.id,
        slug: disciplines.slug,
        nameAr: disciplines.nameAr,
        nameEn: disciplines.nameEn,
        descriptionAr: disciplines.descriptionAr,
      })
      .from(disciplines)
      .where(and(eq(disciplines.slug, slug), eq(disciplines.isActive, true)))
      .limit(1);

    if (!discipline) return null;

    // The same defect lived here, counting every category as 0 on every
    // discipline portal. Same fix — see the note on listDisciplines.
    const publishedPerCategory = tx
      .select({
        categoryId: products.categoryId,
        total: sql<number>`count(*)::int`.as('total'),
      })
      .from(products)
      .where(eq(products.status, 'PUBLISHED'))
      .groupBy(products.categoryId)
      .as('published_per_category');

    const categoryRows = await tx
      .select({
        slug: categories.slug,
        nameAr: categories.nameAr,
        productCount: sql<number>`COALESCE(${publishedPerCategory.total}, 0)`,
      })
      .from(categories)
      .leftJoin(publishedPerCategory, eq(publishedPerCategory.categoryId, categories.id))
      .where(and(eq(categories.disciplineId, discipline.id), eq(categories.isActive, true)))
      .orderBy(categories.sortOrder);

    const productRows = await tx
      .select(cardColumns)
      .from(products)
      .innerJoin(disciplines, eq(disciplines.id, products.disciplineId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(productPrices, withCurrentPrice())
      .where(and(eq(products.disciplineId, discipline.id), eq(products.status, 'PUBLISHED')))
      // Same tiebreaker rule as search: published_at alone is not unique.
      .orderBy(...newestFirst)
      .limit(PORTAL_PREVIEW_LIMIT);

    const [counted] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.disciplineId, discipline.id), eq(products.status, 'PUBLISHED')));

    const totalProducts = Number(counted?.total ?? 0);

    return {
      ...discipline,
      categories: categoryRows.map((c) => ({ ...c, productCount: Number(c.productCount) })),
      products: productRows.map(toCard),
      totalProducts,
      hasMore: totalProducts > productRows.length,
    };
  });
}

export async function productBySlug(slug: string): Promise<PublicProductDetail | null> {
  return withActor(GUEST, async (tx) => {
    const [row] = await tx
      .select({
        ...cardColumns,
        id: products.id,
        descriptionAr: products.descriptionAr,
        language: products.language,
        softwareTags: products.softwareTags,
      })
      .from(products)
      .innerJoin(disciplines, eq(disciplines.id, products.disciplineId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(productPrices, withCurrentPrice())
      .where(and(eq(products.slug, slug), eq(products.status, 'PUBLISHED')))
      .limit(1);

    if (!row) return null;

    // Author NAMES come through a narrow definer function; the revenue split
    // that lives on the same table is unreachable from here. See migration 0007.
    const authorResult = await tx.execute(
      sql`SELECT contributor_slug, display_name, specialization
            FROM app_public_product_authors(${row.id}::uuid)`,
    );
    const authorRows = authorResult as unknown as Array<{
      contributor_slug: string;
      display_name: string;
      specialization: string | null;
    }>;

    // RLS decides what resolves here: a PREVIEW row of a published product is
    // public, an ORIGINAL row is not, so this query cannot see one.
    const files = await tx
      .select({ role: productFiles.role, pageCount: productFiles.pageCount })
      .from(productFiles)
      .where(eq(productFiles.productId, row.id));

    const preview = files.find((f) => f.role === 'PREVIEW');
    const original = files.find((f) => f.role === 'ORIGINAL');

    return {
      ...toCard(row),
      id: row.id,
      descriptionAr: row.descriptionAr,
      language: row.language,
      softwareTags: row.softwareTags ?? [],
      authors: authorRows.map((a) => ({
        contributorSlug: a.contributor_slug,
        displayName: a.display_name,
        specialization: a.specialization,
      })),
      hasPreview: preview !== undefined,
      previewPageCount: preview?.pageCount ?? null,
      totalPageCount: original?.pageCount ?? null,
    };
  });
}

/**
 * Minimal title/description search.
 *
 * Deliberately basic: faceted search over discipline, file type, level,
 * software and price band is phase P4 and needs a generated tsvector to
 * perform at the scale §30 describes. This exists so the search box on the
 * homepage does something real rather than being decoration.
 */
export async function searchProducts(query: string, limit = 24) {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const pattern = `%${trimmed}%`;

  return withActor(GUEST, async (tx) => {
    const rows = await tx
      .select(cardColumns)
      .from(products)
      .innerJoin(disciplines, eq(disciplines.id, products.disciplineId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(productPrices, withCurrentPrice())
      .where(
        and(
          eq(products.status, 'PUBLISHED'),
          or(
            ilike(products.titleAr, pattern),
            ilike(products.subtitleAr, pattern),
            ilike(products.descriptionAr, pattern),
          ),
        ),
      )
      .orderBy(desc(products.publishedAt))
      .limit(limit);
    return rows.map(toCard);
  });
}

export { isNull };

/**
 * A contributor's public profile (specification §31).
 *
 * Returns the intentionally public facts and their published work. The
 * revenue share on the same join table is unreachable from here — the
 * products come through a narrow definer function that does not select it.
 */
export interface PublicContributorProfile {
  readonly slug: string;
  readonly displayName: string;
  readonly specialization: string | null;
  readonly bio: string | null;
  /** Capped at PROFILE_PREVIEW_LIMIT; see the note on that constant. */
  readonly products: readonly PublicProductCard[];
  readonly totalProducts: number;
  readonly hasMore: boolean;
}

export async function contributorBySlug(
  slug: string,
): Promise<PublicContributorProfile | null> {
  return withActor(GUEST, async (tx) => {
    const [profile] = await tx
      .select({
        slug: contributors.publicSlug,
        displayName: contributors.displayName,
        specialization: contributors.specialization,
        bio: contributors.bio,
      })
      .from(contributors)
      .where(and(eq(contributors.publicSlug, slug), eq(contributors.isActive, true)))
      .limit(1);

    if (!profile) return null;

    const result = await tx.execute(
      sql`SELECT * FROM app_public_contributor_products(${slug})`,
    );
    const rows = result as unknown as Array<Record<string, unknown>>;

    const total = rows.length;
    return {
      ...profile,
      totalProducts: total,
      hasMore: total > PROFILE_PREVIEW_LIMIT,
      products: rows.slice(0, PROFILE_PREVIEW_LIMIT).map((row) =>
        toCard({
          slug: row.slug,
          titleAr: row.title_ar,
          subtitleAr: row.subtitle_ar,
          disciplineSlug: row.discipline_slug,
          disciplineNameAr: row.discipline_name_ar,
          categoryNameAr: row.category_name_ar,
          fileType: row.file_type,
          level: row.level,
          isFree: row.is_free,
          priceMinor: row.price_minor,
          currency: row.currency,
          publishedAt: row.published_at,
        }),
      ),
    };
  });
}

/** Active contributors with published work, for the homepage rail. */
export async function featuredContributors(limit = 6) {
  return withActor(GUEST, async (tx) => {
    const rows = await tx
      .select({
        slug: contributors.publicSlug,
        displayName: contributors.displayName,
        specialization: contributors.specialization,
        productCount: sql<number>`app_public_contributor_product_count(${contributors.publicSlug})`,
      })
      .from(contributors)
      .where(eq(contributors.isActive, true))
      .limit(limit);

    return rows
      .map((row) => ({ ...row, productCount: Number(row.productCount) }))
      .filter((row) => row.productCount > 0)
      .sort((a, b) => b.productCount - a.productCount);
  });
}
