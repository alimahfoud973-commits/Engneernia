import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { updatedAt } from './columns';

/**
 * Platform settings (specification §21, §23, §38).
 *
 * Anything the owner should be able to change without a deploy lives here:
 * the platform name, the WhatsApp contact and message template, the preview
 * page count, the refund policy, the minimum payout threshold, and from
 * phase P5 the payment-method configuration.
 *
 * Values are JSON so a setting can grow from a string into a structure
 * without a migration. `isPublic` decides whether a value may be read without
 * authentication — a brand name is public, a payment credential never is.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  /** Owner-facing description, so the admin screen explains itself. */
  descriptionAr: text('description_ar'),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});
