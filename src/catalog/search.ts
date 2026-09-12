import 'server-only';
import { sql } from 'drizzle-orm';
import { withActor } from '@/db/actor-context';
import { GUEST } from '@/authz/actor';
import type { PublicProductCard } from './public-queries';

/**
 * ===========================================================================
 * FACETED SEARCH (specification §30)
 * ===========================================================================
 * Built to the scale §30 asks for — "hundreds or thousands of products" —
 * which rules out scanning. Every filter maps to an index, and the whole
 * request (page of results, total count, and every facet count) is answered
 * by ONE round trip.
 *
 * The single most important property: this runs as GUEST, so PostgreSQL's
 * policies apply. An unpublished product is not filtered out by a WHERE
 * clause that someone could forget — it is invisible to the connection.
 * ===========================================================================
 */

export type SortOption = 'relevance' | 'newest' | 'bestselling' | 'price_asc' | 'price_desc';

/**
 * Every field admits an explicit `undefined`: under
 * `exactOptionalPropertyTypes` a caller building this object from URL
 * parameters would otherwise have to omit keys conditionally rather than
 * assign undefined, which makes the parsing code far worse for no benefit.
 */
export interface SearchFilters {
  readonly q?: string | undefined;
  readonly discipline?: string | undefined;
  readonly category?: string | undefined;
  readonly fileTypes?: readonly string[] | undefined;
  readonly levels?: readonly string[] | undefined;
  readonly software?: readonly string[] | undefined;
  /** 'free' | 'paid' | undefined (both) */
  readonly price?: 'free' | 'paid' | undefined;
  readonly minPriceMinor?: number | undefined;
  readonly maxPriceMinor?: number | undefined;
  readonly sort?: SortOption | undefined;
  readonly page?: number | undefined;
  readonly perPage?: number | undefined;
}

export interface FacetCount {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export interface SearchResults {
  readonly items: readonly PublicProductCard[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly totalPages: number;
  readonly facets: {
    readonly disciplines: readonly FacetCount[];
    readonly fileTypes: readonly FacetCount[];
    readonly levels: readonly FacetCount[];
    readonly software: readonly FacetCount[];
    readonly price: readonly FacetCount[];
  };
  readonly tookMs: number;
}

export const FILE_TYPE_LABELS: Readonly<Record<string, string>> = {
  PDF: 'PDF',
  EXCEL: 'Excel',
  CAD: 'أوتوكاد / CAD',
  REVIT_BIM: 'Revit / BIM',
  ARCHIVE: 'ملف مضغوط',
  TEMPLATE: 'قالب',
  PROJECT: 'مشروع',
  OTHER: 'أخرى',
};

export const LEVEL_LABELS: Readonly<Record<string, string>> = {
  BEGINNER: 'مبتدئ',
  INTERMEDIATE: 'متوسط',
  ADVANCED: 'متقدم',
};

const MAX_PER_PAGE = 48;

interface RawRow {
  slug: string;
  title_ar: string;
  subtitle_ar: string | null;
  discipline_slug: string;
  discipline_name_ar: string;
  category_name_ar: string | null;
  file_type: string;
  level: string | null;
  is_free: boolean;
  price_minor: string | null;
  currency: string;
  published_at: Date | string | null;
}

function toCard(row: RawRow): PublicProductCard {
  return {
    slug: row.slug,
    titleAr: row.title_ar,
    subtitleAr: row.subtitle_ar,
    disciplineSlug: row.discipline_slug,
    disciplineNameAr: row.discipline_name_ar,
    categoryNameAr: row.category_name_ar,
    fileType: row.file_type,
    level: row.level,
    isFree: row.is_free,
    priceMinor: row.price_minor === null ? null : String(row.price_minor),
    currency: row.currency,
    publishedAt: row.published_at ? new Date(row.published_at) : null,
  };
}

export async function searchCatalogue(filters: SearchFilters): Promise<SearchResults> {
  const startedAt = Date.now();

  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(filters.perPage ?? 24)));
  const offset = (page - 1) * perPage;

  const query = (filters.q ?? '').trim();
  const hasQuery = query.length >= 2;
  const sort: SortOption = filters.sort ?? (hasQuery ? 'relevance' : 'newest');

  return withActor(GUEST, async (tx) => {
    /**
     * `base` is the filtered set every part of the response derives from.
     *
     * Each facet count deliberately EXCLUDES its own dimension, so that
     * choosing "PDF" still shows how many Excel results are available. A
     * facet list that collapses to the current selection is useless for
     * navigating, which is the whole point of facets.
     */
    const conditions = sql`
      p.status = 'PUBLISHED'
      ${filters.discipline ? sql`AND d.slug = ${filters.discipline}` : sql``}
      ${filters.category ? sql`AND c.slug = ${filters.category}` : sql``}
      ${hasQuery ? sql`AND (
          p.search_vector @@ websearch_to_tsquery('arabic', ${query})
          OR p.title_ar ILIKE ${'%' + query + '%'}
        )` : sql``}
      ${filters.price === 'free' ? sql`AND p.is_free = true` : sql``}
      ${filters.price === 'paid' ? sql`AND p.is_free = false` : sql``}
      ${filters.minPriceMinor !== undefined ? sql`AND pr.amount_minor >= ${filters.minPriceMinor}` : sql``}
      ${filters.maxPriceMinor !== undefined ? sql`AND pr.amount_minor <= ${filters.maxPriceMinor}` : sql``}
    `;

    /**
     * Enum values cannot be bound as parameters inside an ANY(ARRAY[...]::enum[])
     * construct, so they are interpolated — after being checked against the
     * known enum members. An unrecognised value is DROPPED rather than passed
     * through, so a crafted query string cannot reach the SQL text.
     */
    const FILE_TYPE_VALUES = new Set(Object.keys(FILE_TYPE_LABELS));
    const LEVEL_VALUES = new Set(Object.keys(LEVEL_LABELS));

    const safeFileTypes = (filters.fileTypes ?? []).filter((t) => FILE_TYPE_VALUES.has(t));
    const safeLevels = (filters.levels ?? []).filter((l) => LEVEL_VALUES.has(l));

    const enumArray = (values: readonly string[], type: string) =>
      sql.raw(`ARRAY[${values.map((v) => `'${v}'`).join(',')}]::${type}[]`);

    const fileTypeFilter = safeFileTypes.length
      ? sql`AND p.file_type = ANY(${enumArray(safeFileTypes, 'file_type')})`
      : sql``;
    const levelFilter = safeLevels.length
      ? sql`AND p.level = ANY(${enumArray(safeLevels, 'product_level')})`
      : sql``;
    /**
     * Built as an explicit ARRAY[...] of bound parameters.
     *
     * Passing a JavaScript array straight into the template flattens it into
     * separate placeholders, and the `&&` overlap operator then receives a
     * single text value — PostgreSQL answers "malformed array literal". Each
     * element stays a bound parameter here, so the values are still never
     * interpolated into the SQL text.
     */
    const softwareArray = filters.software?.length
      ? sql`ARRAY[${sql.join(filters.software.map((tag) => sql`${tag}`), sql`, `)}]::text[]`
      : null;

    const softwareFilter = softwareArray ? sql`AND p.software_tags && ${softwareArray}` : sql``;

    // The same predicates, against the CTE's unqualified column names.
    const fileTypeFilter2 = safeFileTypes.length
      ? sql`AND file_type = ANY(${enumArray(safeFileTypes, 'file_type')})`
      : sql``;
    const levelFilter2 = safeLevels.length
      ? sql`AND level = ANY(${enumArray(safeLevels, 'product_level')})`
      : sql``;
    const softwareFilter2 = softwareArray ? sql`AND software_tags && ${softwareArray}` : sql``;

    /**
     * EVERY ordering ends with p.id.
     *
     * Without a unique tiebreaker the sort is not total: thousands of products
     * can share a published_at or a sales_count, PostgreSQL is free to return
     * ties in any order, and it need not pick the same order twice. Page 1 and
     * page 2 then overlap — the same product appears on both while another is
     * never shown at all. Caught by the paging test, which compared the two
     * pages instead of trusting that OFFSET implies disjointness.
     */
    const tiebreak = sql`, p.id DESC`;

    const orderBy = {
      relevance: hasQuery
        ? sql`ts_rank(p.search_vector, websearch_to_tsquery('arabic', ${query})) DESC, p.published_at DESC${tiebreak}`
        : sql`p.published_at DESC${tiebreak}`,
      newest: sql`p.published_at DESC NULLS LAST${tiebreak}`,
      bestselling: sql`p.sales_count DESC, p.published_at DESC${tiebreak}`,
      price_asc: sql`pr.amount_minor ASC NULLS LAST${tiebreak}`,
      price_desc: sql`pr.amount_minor DESC NULLS LAST${tiebreak}`,
    }[sort];

    const joins = sql`
      FROM products p
      JOIN disciplines d ON d.id = p.discipline_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN product_prices pr
             ON pr.product_id = p.id AND pr.effective_to IS NULL
    `;

    /**
     * No `count(*) OVER ()` here, deliberately.
     *
     * A window count forces the whole filtered set to be materialised before
     * the top-N sort can run — measured at 29ms of a 34ms query on a 5,000
     * product catalogue, against 4.6ms for the index scan itself. Without it
     * the planner takes the index and stops at LIMIT.
     *
     * The total comes from the price facet instead: `is_free` is NOT NULL, so
     * every matching product falls into exactly one of free/paid and their
     * counts sum to the total. One scan does two jobs.
     */
    const rows = (await tx.execute(sql`
      SELECT p.slug, p.title_ar, p.subtitle_ar,
             d.slug AS discipline_slug, d.name_ar AS discipline_name_ar,
             c.name_ar AS category_name_ar,
             p.file_type, p.level, p.is_free,
             pr.amount_minor AS price_minor, p.currency, p.published_at
      ${joins}
      WHERE ${conditions} ${fileTypeFilter} ${levelFilter} ${softwareFilter}
      ORDER BY ${orderBy}
      LIMIT ${perPage} OFFSET ${offset}
    `)) as unknown as RawRow[];

    /**
     * ALL facet counts in ONE round trip.
     *
     * They used to be five queries. Inside a transaction postgres.js sends
     * them down a single connection, so `Promise.all` did not parallelise
     * anything — they simply queued, and five scans of the filtered set cost
     * five times one scan.
     *
     * Now a MATERIALIZED CTE scans once and every dimension aggregates over
     * the result. Each dimension still omits its OWN filter, so choosing
     * "PDF" keeps showing how many Excel results are available — a facet list
     * that collapses to the current selection is useless for navigating.
     */
    const facetRows = (await tx.execute(sql`
      WITH base AS MATERIALIZED (
        SELECT p.id, p.file_type, p.level, p.is_free, p.software_tags,
               d.slug AS discipline_slug, d.name_ar AS discipline_name, d.sort_order
        ${joins}
        WHERE ${conditions}
      )
      SELECT 'discipline' AS dim, discipline_slug AS value,
             discipline_name AS label, count(*)::int AS count, min(sort_order) AS ord
        FROM base
       WHERE true ${fileTypeFilter2} ${levelFilter2} ${softwareFilter2}
       GROUP BY discipline_slug, discipline_name

      UNION ALL
      SELECT 'fileType', file_type::text, NULL, count(*)::int, 0
        FROM base
       WHERE true ${levelFilter2} ${softwareFilter2}
       GROUP BY file_type

      UNION ALL
      SELECT 'level', level::text, NULL, count(*)::int, 0
        FROM base
       WHERE level IS NOT NULL ${fileTypeFilter2} ${softwareFilter2}
       GROUP BY level

      UNION ALL
      SELECT 'price', CASE WHEN is_free THEN 'free' ELSE 'paid' END, NULL, count(*)::int, 0
        FROM base
       WHERE true ${fileTypeFilter2} ${levelFilter2} ${softwareFilter2}
       GROUP BY 1, 2

      UNION ALL
      SELECT 'software', tag, NULL, count(*)::int, 0
        FROM base CROSS JOIN LATERAL unnest(software_tags) AS tag
       WHERE true ${fileTypeFilter2} ${levelFilter2}
       GROUP BY tag
    `)) as unknown as Array<{
      dim: string;
      value: string | null;
      label: string | null;
      count: number;
      ord: number;
    }>;

    const byDimension = (dim: string, labels?: Readonly<Record<string, string>>, limit?: number) => {
      const list = facetRows
        .filter((row) => row.dim === dim && row.value !== null)
        .sort((a, b) => (dim === 'discipline' ? a.ord - b.ord : b.count - a.count))
        .map((row) => ({
          value: row.value as string,
          label: row.label ?? labels?.[row.value as string] ?? (row.value as string),
          count: Number(row.count),
        }));
      return limit ? list.slice(0, limit) : list;
    };

    const priceFacets = byDimension('price', { free: 'مجاني', paid: 'مدفوع' });
    const total = priceFacets.reduce((sum, facet) => sum + facet.count, 0);

    return {
      items: rows.map(toCard),
      total,
      page,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      facets: {
        disciplines: byDimension('discipline'),
        fileTypes: byDimension('fileType', FILE_TYPE_LABELS),
        levels: byDimension('level', LEVEL_LABELS),
        software: byDimension('software', undefined, 12),
        price: priceFacets,
      },
      tookMs: Date.now() - startedAt,
    };
  });
}
