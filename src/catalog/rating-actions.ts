'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { currentActor } from '@/auth/current';
import { toUserMessage } from '@/lib/action-errors';
import { rateProduct } from './ratings';

/**
 * The rating action.
 *
 * It re-resolves the actor from the session and passes only a product id and a
 * score to the domain: nothing the form carries decides whether this person may
 * rate. That question is answered by the entitlement, in the row policy.
 */
export type RatingState = { error: string | null; saved: boolean };

const schema = z.object({
  productId: z.string().uuid(),
  score: z.coerce.number().int().min(1).max(5),
});

export async function rateProductAction(
  _previous: RatingState,
  formData: FormData,
): Promise<RatingState> {
  const parsed = schema.safeParse({
    productId: formData.get('productId'),
    score: formData.get('score'),
  });
  if (!parsed.success) return { error: 'تقييم غير صالح', saved: false };

  const actor = await currentActor();

  try {
    await rateProduct(actor, { productId: parsed.data.productId, score: parsed.data.score });
  } catch (error) {
    return { error: toUserMessage(error, 'Rating a product failed'), saved: false };
  }

  revalidatePath(`/products`);
  return { error: null, saved: true };
}
