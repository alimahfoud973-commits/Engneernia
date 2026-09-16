'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwner } from '@/auth/current';
import { parsePercentToBp, saveCommissionAgreement } from './commissions';
import { parseMajorUnits } from '@/lib/money/money';
import { toUserMessage } from '@/lib/action-errors';
import type { CommissionAgreement } from '@/lib/money/commission';

/**
 * The owner's commission screen, server side (§11, OPEN-15).
 *
 * Re-authorises from the session and re-parses every field. A hidden input
 * saying "contributorId" is a string a browser sent; the rate it sets decides
 * what a person is paid for as long as the agreement stands.
 */

export type CommissionState = { error: string | null; ok?: boolean };

const schema = z.object({
  contributorId: z.string().uuid(),
  // Empty means this engineer's default rather than one product's override.
  productId: z.string().uuid().or(z.literal('')).optional(),
  model: z.enum(['PERCENTAGE', 'FIXED_ENGINEER', 'FIXED_PLATFORM']),
  percent: z.string().max(10).optional(),
  amount: z.string().max(20).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  note: z.string().max(400).optional(),
});

export async function saveCommissionAction(
  _previous: CommissionState,
  formData: FormData,
): Promise<CommissionState> {
  const parsed = schema.safeParse({
    contributorId: formData.get('contributorId'),
    productId: formData.get('productId') ?? '',
    model: formData.get('model'),
    percent: formData.get('percent') ?? undefined,
    amount: formData.get('amount') ?? undefined,
    currency: formData.get('currency'),
    note: formData.get('note') ?? undefined,
  });

  if (!parsed.success) return { error: 'بيانات غير صالحة' };

  const actor = await requireOwner('/admin/commissions');
  const { currency } = parsed.data;

  try {
    /*
     * The union is built here rather than passed through, so an impossible
     * combination — a percentage agreement carrying a fixed amount — cannot be
     * represented at all, which is what the type in `money/commission.ts` is
     * for.
     */
    let agreement: CommissionAgreement;
    switch (parsed.data.model) {
      case 'PERCENTAGE':
        agreement = {
          model: 'PERCENTAGE',
          engineerBp: parsePercentToBp(parsed.data.percent ?? ''),
          currency,
        };
        break;
      case 'FIXED_ENGINEER':
        agreement = {
          model: 'FIXED_ENGINEER',
          engineerFixedMinor: parseMajorUnits(parsed.data.amount ?? '', currency).amountMinor,
          currency,
        };
        break;
      case 'FIXED_PLATFORM':
        agreement = {
          model: 'FIXED_PLATFORM',
          platformFixedMinor: parseMajorUnits(parsed.data.amount ?? '', currency).amountMinor,
          currency,
        };
        break;
    }

    await saveCommissionAgreement(actor, {
      contributorId: parsed.data.contributorId,
      productId: parsed.data.productId ? parsed.data.productId : null,
      agreement,
      note: parsed.data.note?.trim() || null,
    });
  } catch (error) {
    return { error: toUserMessage(error, 'Commission action failed') };
  }

  revalidatePath('/admin/commissions');
  return { error: null, ok: true };
}
