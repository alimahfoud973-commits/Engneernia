import { index, jsonb, pgEnum, pgTable, uuid } from 'drizzle-orm/pg-core';
import { createdAt, utcTimestamp } from './columns';
import { users } from './identity';

/**
 * Notification types (specification §33).
 * Later phases append values; the list is explicit so a notification cannot
 * be sent with a type nobody has designed a message for.
 */
export const notificationTypeEnum = pgEnum('notification_type', [
  'PRODUCT_SUBMITTED',
  'PRODUCT_APPROVED',
  'PRODUCT_REVISION_REQUESTED',
  'PRODUCT_PUBLISHED',
  'PRODUCT_UNPUBLISHED',
  'PRODUCT_PRICE_CHANGED',
  'COMMISSION_CHANGED',
  'MONTHLY_STATEMENT_AVAILABLE',
  'SETTLEMENT_APPROVED',
  'SETTLEMENT_PAID',
  'ORDER_PAID',
  'PAYMENT_REJECTED',
]);

/**
 * Targeted notifications.
 *
 * `userId` is NOT NULL and there is exactly one per row. Broadcasting a
 * private product or financial change to every contributor — the thing §33
 * forbids — is therefore not something the schema can express, rather than
 * something the code must remember not to do.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    /** Message parameters, rendered client-side against the locale catalogue. */
    payload: jsonb('payload').notNull().default({}),
    readAt: utcTimestamp('read_at'),
    createdAt: createdAt(),
  },
  (table) => [
    index('notifications_user_idx').on(table.userId, table.createdAt),
    index('notifications_unread_idx').on(table.userId, table.readAt),
  ],
);
