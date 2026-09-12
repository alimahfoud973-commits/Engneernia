import 'server-only';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { notifications } from '@/db/schema';
import { withActor } from '@/db/actor-context';
import type { Actor } from '@/authz/actor';
import { requireDate, toDate } from '@/db';

/**
 * Reading one's own notifications (specification §33).
 *
 * There is no parameter here naming a user. Every query runs under the
 * caller's own actor and the row-level policy scopes it — a notification
 * addressed to somebody else does not resolve, with or without a WHERE clause.
 */

export interface NotificationRow {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

export async function myNotifications(
  actor: Actor,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<readonly NotificationRow[]> {
  if (actor.kind !== 'USER') return [];
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  return withActor(actor, async (tx) => {
    const rows = await tx
      .select()
      .from(notifications)
      .where(
        options.unreadOnly
          ? and(eq(notifications.userId, actor.userId), isNull(notifications.readAt))
          : eq(notifications.userId, actor.userId),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      createdAt: requireDate(row.createdAt, 'createdAt'),
      readAt: toDate(row.readAt),
    }));
  });
}

/** For the header badge. Cheap enough to run on every page render. */
export async function unreadNotificationCount(actor: Actor): Promise<number> {
  if (actor.kind !== 'USER') return 0;

  try {
    return await withActor(actor, async (tx) => {
      const [row] = await tx
        .select({ value: count() })
        .from(notifications)
        .where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt)));
      return Number(row?.value ?? 0);
    });
  } catch {
    // A badge is not worth taking a page down for.
    return 0;
  }
}

/** Mark one, or all, as read. Returns how many rows actually changed. */
export async function markNotificationsRead(
  actor: Actor,
  input: { notificationId?: string } = {},
): Promise<number> {
  if (actor.kind !== 'USER') return 0;

  return withActor(actor, async (tx) => {
    const updated = await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        input.notificationId
          ? and(
              eq(notifications.id, input.notificationId),
              eq(notifications.userId, actor.userId),
              isNull(notifications.readAt),
            )
          : and(eq(notifications.userId, actor.userId), isNull(notifications.readAt)),
      )
      .returning({ id: notifications.id });

    // Zero rows is a legitimate outcome here — already read, or not theirs,
    // and the two are indistinguishable on purpose.
    return updated.length;
  });
}
