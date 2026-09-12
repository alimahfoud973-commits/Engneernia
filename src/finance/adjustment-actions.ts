'use server';

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireOwner } from '@/auth/current';
import {
  postAdjustment, previewAdjustment,
  type AdjustmentInput, type AdjustmentPreview,
} from './adjustments';
import { parseMajorUnits } from '@/lib/money/money';
import { AppError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/**
 * Server actions for financial adjustments (OPEN-21).
 *
 * TWO STEPS, as the owner asked: a preview that writes nothing and shows the
 * whole effect, then an explicit confirmation. The second step revalidates
 * everything from scratch — the preview is a summary for a human, not a token
 * that authorises anything.
 *
 * Both are owner-only and re-resolve the actor from the session. These move
 * money; a hidden form field claiming anything is just a string a browser sent.
 */

export type AdjustmentState = {
  error: string | null;
  preview?: AdjustmentPreview | null;
  /** Carried through the confirmation so a refresh cannot post twice. */
  idempotencyKey?: string;
  posted?: { reference: string; ledgerTransactionId: string } | null;
};

export const INITIAL_ADJUSTMENT: AdjustmentState = { error: null };

function toMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  logger.error({ err: error }, 'Adjustment action failed');
  return 'تعذّر إتمام العملية';
}

const REASONS = [
  'DATA_ENTRY_ERROR',
  'DUPLICATE_PAYMENT_RECEIVED',
  'BANK_FEE_OR_SHORTFALL',
  'AGREED_COMPENSATION',
  'SETTLEMENT_CORRECTION',
  'OTHER',
] as const;

const schema = z.object({
  target: z.enum(['ENGINEER', 'PLATFORM']),
  direction: z.enum(['INCREASE', 'DECREASE']),
  // Typed by a human in major units ("12.50"), parsed server-side into minor
  // units by the money module. No float ever touches it.
  amount: z.string().min(1).max(24),
  currency: z.string().regex(/^[A-Z]{3}$/),
  contributorId: z.string().uuid().optional(),
  reason: z.enum(REASONS),
  note: z.string().min(10).max(2000),
  relatedType: z.string().max(40).optional(),
  relatedId: z.string().uuid().optional(),
});

function readForm(formData: FormData): AdjustmentInput {
  const raw = {
    target: formData.get('target'),
    direction: formData.get('direction'),
    amount: formData.get('amount'),
    currency: formData.get('currency'),
    contributorId: (formData.get('contributorId') as string) || undefined,
    reason: formData.get('reason'),
    note: formData.get('note'),
    relatedType: (formData.get('relatedType') as string) || undefined,
    relatedId: (formData.get('relatedId') as string) || undefined,
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues[0]?.path[0] === 'note'
        ? 'اكتب سبباً مفصّلاً لا يقل عن عشرة أحرف'
        : 'راجع الحقول: المبلغ والعملة والنوع والسبب مطلوبة',
    );
  }

  const money = parseMajorUnits(parsed.data.amount, parsed.data.currency);

  return {
    target: parsed.data.target,
    direction: parsed.data.direction,
    amountMinor: money.amountMinor,
    currency: parsed.data.currency,
    contributorId: parsed.data.contributorId ?? null,
    reason: parsed.data.reason,
    note: parsed.data.note,
    relatedType: parsed.data.relatedType ?? null,
    relatedId: parsed.data.relatedId ?? null,
  };
}

/** Step one: show the owner exactly what would happen. Writes nothing. */
export async function previewAdjustmentAction(
  _previous: AdjustmentState,
  formData: FormData,
): Promise<AdjustmentState> {
  const actor = await requireOwner('/admin/adjustments');

  try {
    const input = readForm(formData);
    const preview = await previewAdjustment(actor, input);
    return {
      error: null,
      preview,
      // Minted here, on the server, once per preview. The confirmation carries
      // it back, so confirming the same preview twice posts once.
      idempotencyKey: randomUUID(),
    };
  } catch (error) {
    return { error: toMessage(error), preview: null };
  }
}

const confirmSchema = schema.extend({ idempotencyKey: z.string().uuid() });

/** Step two: the owner has read the summary and said yes. */
export async function confirmAdjustmentAction(
  _previous: AdjustmentState,
  formData: FormData,
): Promise<AdjustmentState> {
  const actor = await requireOwner('/admin/adjustments');

  const key = formData.get('idempotencyKey');
  if (!confirmSchema.shape.idempotencyKey.safeParse(key).success) {
    return { error: 'انتهت صلاحية هذه المعاينة. أعد الملخص ثم أكّد.' };
  }

  try {
    const input = readForm(formData);
    const posted = await postAdjustment(actor, {
      ...input,
      idempotencyKey: key as string,
    });

    revalidatePath('/admin/adjustments');
    revalidatePath('/admin/finance');
    revalidatePath('/admin/settlements');

    return {
      error: null,
      preview: null,
      posted: {
        reference: posted.reference,
        ledgerTransactionId: posted.ledgerTransactionId,
      },
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
