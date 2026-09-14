import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
  bigint,
} from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, utcTimestamp } from './columns';
import { contributors, users } from './identity';

/**
 * Publication workflow (specification §10).
 *
 *   DRAFT → SUBMITTED → IN_REVIEW → APPROVED → PUBLISHED ⇄ UNPUBLISHED
 *                           ↘ REVISION_REQUESTED ↗
 *
 * Only PUBLISHED is publicly visible. The transitions permitted to each role
 * live in src/catalog/publication.ts, not here — the database stores the
 * state, the domain owns the rules.
 */
export const productStatusEnum = pgEnum('product_status', [
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'REVISION_REQUESTED',
  'APPROVED',
  'PUBLISHED',
  'UNPUBLISHED',
  'ARCHIVED',
]);

/** Specification §9 / decisions §13 — not everything is a PDF. */
export const fileTypeEnum = pgEnum('file_type', [
  'PDF',
  'EXCEL',
  'CAD',
  'REVIT_BIM',
  'ARCHIVE',
  'TEMPLATE',
  'PROJECT',
  'OTHER',
]);

export const productLevelEnum = pgEnum('product_level', ['BEGINNER', 'INTERMEDIATE', 'ADVANCED']);

/**
 * Disciplines are ROWS, not enum members (specification §4, decisions §12).
 * Adding a fifth discipline is a row insert; it needs no deploy.
 */
export const disciplines = pgTable(
  'disciplines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    descriptionAr: text('description_ar'),
    /** Short identifier the UI maps to an icon; not a file path. */
    iconKey: text('icon_key'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('disciplines_slug_unique').on(table.slug),
    index('disciplines_active_order_idx').on(table.isActive, table.sortOrder),
  ],
);

/**
 * Category tree, one tree per discipline. Self-referencing so subcategories
 * need no second table (specification §9 "subcategory if needed").
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    disciplineId: uuid('discipline_id')
      .notNull()
      .references(() => disciplines.id, { onDelete: 'restrict' }),
    parentId: uuid('parent_id'),
    slug: text('slug').notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('categories_discipline_slug_unique').on(table.disciplineId, table.slug),
    index('categories_discipline_order_idx').on(table.disciplineId, table.sortOrder),
    index('categories_parent_idx').on(table.parentId),
  ],
);

/**
 * Products.
 *
 * NOTE the absence of a price column. Price is temporal and lives in
 * product_prices, so that changing a price preserves history automatically
 * (specification §34) rather than depending on someone remembering to log it.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),

    titleAr: text('title_ar').notNull(),
    titleEn: text('title_en'),
    subtitleAr: text('subtitle_ar'),
    descriptionAr: text('description_ar'),

    disciplineId: uuid('discipline_id')
      .notNull()
      .references(() => disciplines.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),

    fileType: fileTypeEnum('file_type').notNull().default('PDF'),
    language: text('language').notNull().default('ar'),
    level: productLevelEnum('level'),
    /** Free-form technology tags: AutoCAD, Revit 2024, ETAP... */
    softwareTags: text('software_tags').array().notNull().default([]),

    status: productStatusEnum('status').notNull().default('DRAFT'),
    /** Currency of this product's prices. Amounts live in product_prices. */
    currency: text('currency').notNull().default('USD'),
    isFree: boolean('is_free').notNull().default(false),

    publishedAt: utcTimestamp('published_at'),
    /** Denormalised counter, maintained by the sales path in phase P6. */
    salesCount: integer('sales_count').notNull().default(0),

    /*
     * NOTE: the table also carries `search_vector`, a GENERATED ALWAYS
     * tsvector built by the database from the title, subtitle and description
     * (migration 0015). It is deliberately absent from this schema: the ORM
     * must never select or write it, and declaring it here would invite both.
     * Search reads it through raw SQL in src/catalog/search.ts.
     */

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('products_slug_unique').on(table.slug),
    index('products_discipline_status_idx').on(table.disciplineId, table.status),
    index('products_category_idx').on(table.categoryId),
    index('products_status_published_idx').on(table.status, table.publishedAt),
  ],
);

/**
 * Which engineers are credited, and with what share (decisions §6).
 *
 * Only the owner creates these rows. Shares are validated to total exactly
 * 10000 basis points by src/lib/money/distribution.ts before any write, and
 * the distribution in force is snapshotted onto the order at sale time, so
 * editing shares later cannot touch a past sale.
 */
export const productContributors = pgTable(
  'product_contributors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    contributorId: uuid('contributor_id')
      .notNull()
      .references(() => contributors.id, { onDelete: 'restrict' }),
    shareBp: integer('share_bp').notNull(),
    /** The name shown publicly for this credit, if different from the profile. */
    creditLabel: text('credit_label'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('product_contributors_unique').on(table.productId, table.contributorId),
    index('product_contributors_contributor_idx').on(table.contributorId),
  ],
);

/**
 * TEMPORAL price table (specification §34, §48).
 *
 * The current price is the row with effective_to IS NULL. A price change
 * closes that row and opens a new one — nothing is ever updated in place, so
 * the price in force on any past date is always reconstructible and a past
 * sale can be independently reconciled against it.
 */
export const productPrices = pgTable(
  'product_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    /** Minor units. Never a float, never a decimal column. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),

    effectiveFrom: utcTimestamp('effective_from').notNull().defaultNow(),
    effectiveTo: utcTimestamp('effective_to'),

    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (table) => [
    index('product_prices_product_idx').on(table.productId, table.effectiveFrom),
    // Partial unique index: at most ONE open price row per product, enforced
    // by the database rather than by careful application code.
    uniqueIndex('product_prices_one_current')
      .on(table.productId)
      .where(sql`${table.effectiveTo} IS NULL`),
  ],
);

export const disciplinesRelations = relations(disciplines, ({ many }) => ({
  categories: many(categories),
  products: many(products),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  discipline: one(disciplines, {
    fields: [categories.disciplineId],
    references: [disciplines.id],
  }),
  products: many(products),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  discipline: one(disciplines, { fields: [products.disciplineId], references: [disciplines.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  credits: many(productContributors),
  prices: many(productPrices),
}));

export const productContributorsRelations = relations(productContributors, ({ one }) => ({
  product: one(products, { fields: [productContributors.productId], references: [products.id] }),
  contributor: one(contributors, {
    fields: [productContributors.contributorId],
    references: [contributors.id],
  }),
}));

/**
 * Product ratings (OPEN-14 — behind `catalog.ratingsEnabled`).
 *
 * A score and nothing else, by the owner's decision: a single owner cannot
 * moderate written reviews daily, and an unmoderated one lands on an engineer's
 * page before anybody reads it. A text column can be added later without
 * touching a row that already exists.
 *
 * NOTHING PUBLIC READS THIS TABLE. Row-level security admits the owner and the
 * author of the row, and the catalogue reaches an average through
 * `app_product_rating` — because a visitor who can list a product's ratings can
 * list who bought it, which OPEN-4 settled must never happen.
 */
export const productRatings = pgTable(
  'product_ratings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 1–5. Constrained in the database as well; see migration 0045. */
    score: smallint('score').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One voice per buyer per product: re-rating updates rather than stacks.
    uniqueIndex('product_ratings_one_per_customer').on(table.productId, table.customerId),
    index('product_ratings_product_idx').on(table.productId),
  ],
);
