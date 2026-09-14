import { relations, sql } from 'drizzle-orm';
import {
  bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, utcTimestamp } from './columns';
import { products } from './catalog';
import { contributors, users } from './identity';

/**
 * ===========================================================================
 * ORDER LIFECYCLE (specification §24)
 * ===========================================================================
 *   DRAFT → AWAITING_PAYMENT → PROOF_SUBMITTED → PENDING_VERIFICATION
 *         → PAID → COMPLETED
 *   with branches to PAYMENT_ISSUE, CANCELLED and REFUNDED.
 *
 * PAID is the single moment that matters: it is the only transition that
 * writes the financial snapshot and grants entitlements, and only the owner
 * can make it.
 * ===========================================================================
 */
export const orderStatusEnum = pgEnum('order_status', [
  'DRAFT',
  'AWAITING_PAYMENT',
  'PROOF_SUBMITTED',
  'PENDING_VERIFICATION',
  'PAID',
  'COMPLETED',
  'PAYMENT_ISSUE',
  'CANCELLED',
  'REFUNDED',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'INITIATED',
  'AWAITING_PROOF',
  'PROOF_SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
]);

/**
 * How a method takes money.
 *   MANUAL   — bank transfer, ShamCash: instructions, then a human verifies.
 *   GATEWAY  — a provider confirms by callback. None configured (decisions §2).
 *   ASSISTED — WhatsApp: the platform hands the customer to a person.
 */
export const paymentMethodTypeEnum = pgEnum('payment_method_type', [
  'MANUAL',
  'GATEWAY',
  'ASSISTED',
]);

export const proofDecisionEnum = pgEnum('proof_decision', ['PENDING', 'APPROVED', 'REJECTED']);

/** Percentage split, or a fixed amount to either side (specification §11). */
export const commissionModelEnum = pgEnum('commission_model', [
  'PERCENTAGE',
  'FIXED_ENGINEER',
  'FIXED_PLATFORM',
]);

/**
 * Payment methods (specification §21).
 *
 * Everything the owner needs to add, edit, reorder, enable or disable a way of
 * paying lives in this row — no code change, no deploy. Availability is data:
 * country, currency and amount bounds are columns, not conditionals.
 */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    type: paymentMethodTypeEnum('type').notNull(),

    displayNameAr: text('display_name_ar').notNull(),
    displayNameEn: text('display_name_en'),
    descriptionAr: text('description_ar'),
    /** Shown to the customer after they choose this method. */
    instructionsAr: text('instructions_ar'),
    /** Account number, wallet id, IBAN — owner-editable, never in code. */
    accountDetailsAr: text('account_details_ar'),
    /** Offered when a customer cannot complete payment (§23). */
    supportMessageAr: text('support_message_ar'),

    requiresProof: boolean('requires_proof').notNull().default(true),
    /** Empty array means "every country" (§22). */
    countries: text('countries').array().notNull().default([]),
    currencies: text('currencies').array().notNull().default([]),
    minAmountMinor: bigint('min_amount_minor', { mode: 'bigint' }),
    maxAmountMinor: bigint('max_amount_minor', { mode: 'bigint' }),

    isActive: boolean('is_active').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),

    /*
     * Provider credentials are NOT here. They live in payment_method_secrets,
     * an owner-only table (migration 0020). RLS protects rows, not columns —
     * a credential in this table would be exposed by the same policy that
     * makes active methods public to any SELECT that forgets to narrow itself.
     */

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('payment_methods_code_unique').on(table.code),
    index('payment_methods_active_idx').on(table.isActive, table.sortOrder),
  ],
);

/**
 * Commission agreements (specification §11).
 *
 * TEMPORAL, like prices: changing an agreement closes the current row and
 * opens a new one, so the terms in force on any past date stay reconstructible
 * and a past sale can be reconciled against them.
 *
 * A PRODUCT-scoped row overrides a CONTRIBUTOR-scoped one.
 */
export const commissionAgreements = pgTable(
  'commission_agreements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contributorId: uuid('contributor_id')
      .notNull()
      .references(() => contributors.id, { onDelete: 'restrict' }),
    /** Null for the contributor's default agreement. */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),

    model: commissionModelEnum('model').notNull(),
    /** Basis points: 80% is 8000. Integer, never a decimal percentage. */
    engineerBp: integer('engineer_bp'),
    engineerFixedMinor: bigint('engineer_fixed_minor', { mode: 'bigint' }),
    platformFixedMinor: bigint('platform_fixed_minor', { mode: 'bigint' }),
    currency: text('currency').notNull(),

    effectiveFrom: utcTimestamp('effective_from').notNull().defaultNow(),
    effectiveTo: utcTimestamp('effective_to'),

    createdBy: uuid('created_by'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (table) => [
    index('commission_agreements_contributor_idx').on(table.contributorId, table.effectiveFrom),
    index('commission_agreements_product_idx').on(table.productId, table.effectiveFrom),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Human-facing reference shown to the customer and used on transfers. */
    orderNumber: text('order_number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    status: orderStatusEnum('status').notNull().default('DRAFT'),
    currency: text('currency').notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    discountMinor: bigint('discount_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull().default(sql`0`),

    /** Drives which payment methods are offered (§22). */
    buyerCountry: text('buyer_country'),

    placedAt: utcTimestamp('placed_at'),
    paidAt: utcTimestamp('paid_at'),
    completedAt: utcTimestamp('completed_at'),
    /** Owner-visible note, e.g. why a payment was rejected. */
    adminNote: text('admin_note'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('orders_number_unique').on(table.orderNumber),
    index('orders_customer_idx').on(table.customerId, table.createdAt),
    index('orders_status_idx').on(table.status, table.createdAt),
  ],
);

/**
 * THE FINANCIAL SNAPSHOT (specification §13, §48).
 *
 * The commission columns here are written ONCE, at the moment the order
 * becomes PAID, and are then immutable — enforced by a database trigger, not
 * by convention. Changing a price or an agreement afterwards cannot reach
 * them. `agreementId` and `priceRowId` record which rows produced the numbers,
 * so any historical figure can also be independently reconciled.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),

    /** Copied at sale time: a product renamed later does not rewrite history. */
    titleSnapshot: text('title_snapshot').notNull(),

    unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),

    // --- the snapshot ---
    commissionModel: commissionModelEnum('commission_model'),
    engineerBp: integer('engineer_bp'),
    engineerAmountMinor: bigint('engineer_amount_minor', { mode: 'bigint' }),
    platformAmountMinor: bigint('platform_amount_minor', { mode: 'bigint' }),
    /**
     * The tax taken out of `unit_price_minor`, frozen with everything else
     * (owner decision on OPEN-9). The displayed price INCLUDES the tax, so:
     *   tax_minor + net_minor === unit_price_minor, always — a database CHECK
     * says so, and the commission was computed on `net_minor`, never on the
     * gross. `tax_bp` is the rate at the moment of sale: changing the setting
     * next year cannot rewrite what was charged this year.
     */
    taxBp: integer('tax_bp'),
    taxMinor: bigint('tax_minor', { mode: 'bigint' }),
    netMinor: bigint('net_minor', { mode: 'bigint' }),

    agreementId: uuid('agreement_id'),
    priceRowId: uuid('price_row_id'),
    /** True when a fixed agreement exceeded the price and had to be capped. */
    commissionClamped: boolean('commission_clamped').notNull().default(false),
    snapshotTakenAt: utcTimestamp('snapshot_taken_at'),

    /*
     * There are no refund marks here. The owner's decision is that a completed
     * sale is final — "الكتاب الذي يباع لا يسترد أمواله لأي سبب" — so the two
     * columns P6 added for it were dropped in migration 0035, along with the
     * feature itself.
     */

    createdAt: createdAt(),
  },
  (table) => [
    index('order_items_order_idx').on(table.orderId),
    index('order_items_product_idx').on(table.productId),
  ],
);

/**
 * How the engineer's side of one sale divides between credited contributors
 * (decisions §6). Snapshotted with the item: changing the split later cannot
 * alter a past sale.
 */
export const orderItemContributors = pgTable(
  'order_item_contributors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    contributorId: uuid('contributor_id')
      .notNull()
      .references(() => contributors.id, { onDelete: 'restrict' }),
    shareBp: integer('share_bp').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('order_item_contributors_unique').on(table.orderItemId, table.contributorId),
    index('order_item_contributors_contributor_idx').on(table.contributorId),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    paymentMethodId: uuid('payment_method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict' }),

    status: paymentStatusEnum('status').notNull().default('INITIATED'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),

    /**
     * The provider's or the bank's reference. Unique per method, so one
     * transfer receipt cannot be replayed across several orders.
     */
    providerRef: text('provider_ref'),
    /** Recorded, not deducted from the engineer's share — see OPEN-2. */
    feeMinor: bigint('fee_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    /** Guards against a double-click creating two payments. */
    idempotencyKey: text('idempotency_key'),

    approvedBy: uuid('approved_by'),
    approvedAt: utcTimestamp('approved_at'),
    rejectedReason: text('rejected_reason'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('payments_order_idx').on(table.orderId),
    index('payments_status_idx').on(table.status, table.createdAt),
    uniqueIndex('payments_provider_ref_unique').on(table.paymentMethodId, table.providerRef),
    uniqueIndex('payments_idempotency_unique').on(table.idempotencyKey),
  ],
);

/** Proof of a manual transfer (specification §24). Private storage, always. */
export const paymentProofs = pgTable(
  'payment_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),

    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
    /** The transfer number the customer typed in. */
    referenceNote: text('reference_note'),

    submittedBy: uuid('submitted_by'),
    submittedAt: utcTimestamp('submitted_at').notNull().defaultNow(),

    decision: proofDecisionEnum('decision').notNull().default('PENDING'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: utcTimestamp('reviewed_at'),
    rejectionReason: text('rejection_reason'),

    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('payment_proofs_storage_key_unique').on(table.storageKey),
    index('payment_proofs_payment_idx').on(table.paymentId),
    index('payment_proofs_decision_idx').on(table.decision, table.submittedAt),
  ],
);

/**
 * What a customer owns (specification §41).
 *
 * Created only when an order reaches PAID. This row — not a success message,
 * not a session flag — is what the download route checks.
 */
export const entitlements = pgTable(
  'entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    orderItemId: uuid('order_item_id').references(() => orderItems.id, { onDelete: 'set null' }),

    grantedAt: utcTimestamp('granted_at').notNull().defaultNow(),
    /** Set on refund; the row is never deleted (§37). */
    revokedAt: utcTimestamp('revoked_at'),
    revokedReason: text('revoked_reason'),

    downloadCount: integer('download_count').notNull().default(0),
    lastDownloadedAt: utcTimestamp('last_downloaded_at'),
    /** Null means unlimited; a value caps sharing of one purchase. */
    maxDownloads: integer('max_downloads'),

    createdAt: createdAt(),
  },
  (table) => [
    index('entitlements_customer_idx').on(table.customerId, table.grantedAt),
    index('entitlements_product_idx').on(table.productId),
    uniqueIndex('entitlements_live_unique').on(table.customerId, table.productId, table.orderItemId),
  ],
);

/** Owner-visible audit of what changed on an order and when. */
export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Deliberately NOT a foreign key: the history has to outlive the order it
     * describes. With a cascade, deleting an order tried to delete its own
     * trail, which the append-only trigger refused — deadlocking both rules.
     */
    orderId: uuid('order_id').notNull(),
    orderNumber: text('order_number'),
    fromStatus: orderStatusEnum('from_status'),
    toStatus: orderStatusEnum('to_status').notNull(),
    actorUserId: uuid('actor_user_id'),
    note: text('note'),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
  },
  (table) => [index('order_events_order_idx').on(table.orderId, table.createdAt)],
);

/** Owner-only. Separated from payment_methods so RLS can protect it whole. */
export const paymentMethodSecrets = pgTable('payment_method_secrets', {
  paymentMethodId: uuid('payment_method_id')
    .primaryKey()
    .references(() => paymentMethods.id, { onDelete: 'cascade' }),
  configEncrypted: text('config_encrypted').notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});

export const ordersRelations = relations(orders, ({ many, one }) => ({
  items: many(orderItems),
  payments: many(payments),
  customer: one(users, { fields: [orders.customerId], references: [users.id] }),
}));

export const orderItemsRelations = relations(orderItems, ({ one, many }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  product: one(products, { fields: [orderItems.productId], references: [products.id] }),
  contributors: many(orderItemContributors),
}));

/**
 * Invoices (owner decision on OPEN-9).
 *
 * APPEND-ONLY, enforced by triggers in migration 0042, for the same reason the
 * ledger is: a document that can be edited after it was handed to a customer
 * records nothing. A correction is a new invoice, never a rewrite of an old one.
 *
 * Every field that came from a setting is COPIED here at issue: the rate, the
 * tax's legal name, the seller's details, the buyer's, and the lines as they
 * read. Rendering this document in five years must not depend on a settings
 * row somebody edited, or on a product that has since been renamed.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Gapless per year — see the note on numbering in migration 0042. */
    invoiceNumber: text('invoice_number').notNull(),
    /**
     * Ids without foreign keys — the project's rule for append-only records.
     * A permanent document must not be the reason an account can never be
     * deleted; the reference is checked when the row is written instead.
     */
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id').notNull(),

    issuedAt: utcTimestamp('issued_at').notNull().defaultNow(),
    currency: text('currency').notNull(),

    grossMinor: bigint('gross_minor', { mode: 'bigint' }).notNull(),
    taxMinor: bigint('tax_minor', { mode: 'bigint' }).notNull(),
    netMinor: bigint('net_minor', { mode: 'bigint' }).notNull(),
    taxBp: integer('tax_bp').notNull(),

    taxNameAr: text('tax_name_ar').notNull(),
    taxRegistration: text('tax_registration'),
    sellerNameAr: text('seller_name_ar').notNull(),
    sellerAddressAr: text('seller_address_ar'),
    buyerName: text('buyer_name').notNull(),
    buyerEmail: text('buyer_email').notNull(),

    lines: jsonb('lines').notNull(),

    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('invoices_number_unique').on(table.invoiceNumber),
    uniqueIndex('invoices_order_unique').on(table.orderId),
    index('invoices_customer_idx').on(table.customerId, table.issuedAt),
    index('invoices_issued_idx').on(table.issuedAt),
  ],
);

/**
 * The per-year invoice counter. Never read or written through Drizzle — RLS
 * denies it to the application outright and `app_next_invoice_number()` is the
 * only way in. Declared so the schema stays the single description of the
 * database.
 */
export const invoiceCounters = pgTable('invoice_counters', {
  year: integer('year').primaryKey(),
  nextNumber: integer('next_number').notNull().default(1),
});
