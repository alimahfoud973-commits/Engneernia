'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwner } from '@/auth/current';
import { toUserMessage } from '@/lib/action-errors';
import { updateWhatsappNumber } from './settings-admin';

/**
 * The owner's settings screen, server side (W2). Re-authorises from the
 * session and re-reads the field; validation of the number is the service's.
 */

export type SettingsState = { error: string | null; ok?: boolean };

const ADMIN_PATH = '/admin/settings';

export async function updateWhatsappAction(
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const parsed = z.string().max(40).safeParse(formData.get('whatsapp') ?? '');
  if (!parsed.success) return { error: 'رقم واتساب غير صالح' };

  const actor = await requireOwner(ADMIN_PATH);
  try {
    await updateWhatsappNumber(actor, parsed.data);
  } catch (error) {
    return { error: toUserMessage(error, 'Update WhatsApp number failed') };
  }

  revalidatePath(ADMIN_PATH);
  return { error: null, ok: true };
}
