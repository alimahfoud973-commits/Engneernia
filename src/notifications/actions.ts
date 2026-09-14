'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor } from '@/auth/current';
import { markNotificationsRead } from './queries';
import { toUserMessage } from '@/lib/action-errors';

export type ActionState = { error: string | null; ok?: boolean };

/**
 * Marking one's own notifications as read.
 *
 * The only write a recipient makes to this table, and the policy scopes it to
 * their own rows — a crafted id belonging to someone else simply matches
 * nothing.
 */
const schema = z.object({ notificationId: z.string().uuid().optional() });

export async function markReadAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = formData.get('notificationId');
  const parsed = schema.safeParse({
    notificationId: typeof raw === 'string' && raw.length > 0 ? raw : undefined,
  });
  if (!parsed.success) return { error: 'إشعار غير صالح' };

  const actor = await requireActor('/account/notifications');

  try {
    await markNotificationsRead(
      actor,
      parsed.data.notificationId ? { notificationId: parsed.data.notificationId } : {},
    );
  } catch (error) {
    return {
      error: toUserMessage(error, 'Marking notifications read failed', 'تعذّر تحديث الإشعارات'),
    };
  }

  revalidatePath('/account/notifications');
  revalidatePath('/account');
  return { error: null, ok: true };
}
