import { bigint, index, integer, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, utcTimestamp } from './columns';
import { products } from './catalog';
import { users } from './identity';

/**
 * What a stored file IS, which decides who may reach it.
 *
 *   ORIGINAL  — the product itself. Owner and credited contributors only,
 *               plus entitled customers once purchasing exists (phase P5).
 *               There is no configuration under which this becomes public.
 *   PREVIEW   — the generated 5-page PDF. Public, for published products.
 *   THUMBNAIL — a cover image. Public, for published products.
 */
export const fileRoleEnum = pgEnum('file_role', ['ORIGINAL', 'PREVIEW', 'THUMBNAIL']);

/**
 * Malware scan outcome.
 *
 * SKIPPED is recorded, never inferred: a deployment with no scanner
 * configured must leave a visible trail rather than silently behaving as if
 * every file were clean.
 */
export const scanStatusEnum = pgEnum('scan_status', [
  'PENDING',
  'CLEAN',
  'INFECTED',
  'SKIPPED',
  'FAILED',
]);

export const productFiles = pgTable(
  'product_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    role: fileRoleEnum('role').notNull(),

    /** Random path, never derived from the title (see media/storage/keys.ts). */
    storageKey: text('storage_key').notNull(),
    bucket: text('bucket').notNull(),

    /** Kept for display and for the download filename; never used as a path. */
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    /** The container family proven by inspecting the first bytes. */
    container: text('container').notNull(),

    byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
    sha256: text('sha256').notNull(),
    /** Populated for PDFs; null for every other format. */
    pageCount: integer('page_count'),

    scanStatus: scanStatusEnum('scan_status').notNull().default('PENDING'),
    scanDetail: text('scan_detail'),
    scannedAt: utcTimestamp('scanned_at'),

    /** Replacing a file bumps this, so a stale signed URL cannot resurrect it. */
    version: integer('version').notNull().default(1),

    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('product_files_storage_key_unique').on(table.storageKey),
    // One live file per role per product; replacing means deleting first.
    uniqueIndex('product_files_role_unique').on(table.productId, table.role),
    index('product_files_product_idx').on(table.productId),
    index('product_files_scan_idx').on(table.scanStatus),
  ],
);

/**
 * Every delivery of an original, recorded.
 *
 * Two uses: spotting an account sharing its downloads, and tracing a leaked
 * file back to the purchase it came from.
 */
export const downloadEvents = pgTable(
  'download_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Deliberately NOT a foreign key.
     *
     * The trail has to outlive the thing it describes: with a cascade,anyone
     * able to delete a product could erase the record of who downloaded it.
     * The denormalised columns below keep the row meaningful on its own.
     */
    productFileId: uuid('product_file_id').notNull(),
    productId: uuid('product_id'),
    productSlug: text('product_slug'),
    filename: text('filename'),
    storageKey: text('storage_key'),

    /**
     * Also a plain value, for the same reason: ON DELETE SET NULL is an
     * UPDATE, which an append-only table refuses. Deleting an account removes
     * the identity while this pseudonymous id stays in the trail.
     */
    userId: uuid('user_id'),
    /** Why this delivery was permitted: OWNER, CONTRIBUTOR, ENTITLEMENT. */
    grantReason: text('grant_reason').notNull(),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    byteSize: bigint('byte_size', { mode: 'bigint' }),
    createdAt: createdAt(),
  },
  (table) => [
    index('download_events_file_idx').on(table.productFileId, table.createdAt),
    index('download_events_user_idx').on(table.userId, table.createdAt),
    index('download_events_product_idx').on(table.productId, table.createdAt),
  ],
);
