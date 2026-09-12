import 'server-only';
import { eq } from 'drizzle-orm';
import { notifications, productContributors, contributors } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';

/**
 * ===========================================================================
 * TARGETED NOTIFICATIONS (specification §33)
 * ===========================================================================
 * There is no function here that accepts a list of recipients, and none that
 * notifies "all contributors". Every producer resolves WHO is affected and
 * writes one row per person.
 *
 * The rule this protects: if the owner changes the price of a Civil
 * engineer's product, only that engineer hears about it. Another contributor
 * learning that a product's price moved is a leak of a private commercial
 * arrangement, even though no number is attached to the message.
 * ===========================================================================
 */

export type NotificationType = (typeof notifications.type)['enumValues'][number];

export interface NotificationInput {
  readonly userId: string;
  readonly type: NotificationType;
  readonly payload?: Record<string, unknown>;
}

/** Send to exactly one person. */
export async function notifyUser(tx: Transaction, input: NotificationInput): Promise<void> {
  await tx.insert(notifications).values({
    userId: input.userId,
    type: input.type,
    payload: input.payload ?? {},
  });
}

/**
 * Notify the engineers credited on a product — and nobody else.
 *
 * Resolves credits to user ids inside the same transaction, so a contributor
 * removed from a product a moment ago does not receive the message, and one
 * just added does.
 */
export async function notifyProductContributors(
  tx: Transaction,
  productId: string,
  type: NotificationType,
  payload: Record<string, unknown> = {},
): Promise<number> {
  const credited = await tx
    .select({ userId: contributors.userId })
    .from(productContributors)
    .innerJoin(contributors, eq(contributors.id, productContributors.contributorId))
    .where(eq(productContributors.productId, productId));

  if (credited.length === 0) return 0;

  await tx.insert(notifications).values(
    credited.map((row) => ({
      userId: row.userId,
      type,
      payload: { ...payload, productId },
    })),
  );

  return credited.length;
}

/** Mark one notification read. RLS confines this to the recipient. */
export async function markNotificationRead(tx: Transaction, notificationId: string): Promise<void> {
  await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(eq(notifications.id, notificationId));
}

/**
 * Notify the user behind a contributor profile, if there is still one.
 *
 * A contributor whose account has been removed gets no message, and that is
 * not an error: the financial record naming them survives independently, and
 * the caller's work must not fail because there is nobody left to tell.
 */
export async function notifyContributor(
  tx: Transaction,
  contributorId: string,
  type: NotificationType,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  const [row] = await tx
    .select({ userId: contributors.userId })
    .from(contributors)
    .where(eq(contributors.id, contributorId))
    .limit(1);

  if (!row?.userId) return false;

  await notifyUser(tx, { userId: row.userId, type, payload });
  return true;
}
