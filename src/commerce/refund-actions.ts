'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor, requireOwner } from '@/auth/current';
import {
  approveRefund, markRefundPaid, rejectRefund, requestRefund, withdrawRefundRequest,
} from './refunds';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/**
 * Server actions for the refund flow.
 *
 * Every one re-resolves the actor from the session. A form field claiming to
 * be an owner is a string a browser sent, and the refund actions are the ones
 * where believing it would cost money.
 */

export type ActionState = { error: string | null; ok?: boolean };

function toMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  logger.error({ err: error }, 'Refund action failed');
  return 'تعذّر إتمام العملية';
}

const REASONS = [
  'DUPLICATE_PAYMENT',
  'CORRUPT_FILE',
  'NOT_AS_DESCRIBED',
  'PLATFORM_ERROR',
  'OWNER_DISCRETION',
] as const;

const requestSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.enum(REASONS),
  customerNote: z.string().min(10).max(2000),
});

export async function requestRefundAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = requestSchema.safeParse({
    orderId: formData.get('orderId'),
    reason: formData.get('reason'),
    customerNote: formData.get('customerNote'),
  });
  if (!parsed.success) {
    return { error: 'اختر سبباً واكتب شرحاً لا يقل عن عشرة أحرف' };
  }

  const actor = await requireActor('/account');

  try {
    await requestRefund(actor, {
      orderId: parsed.data.orderId,
      reason: parsed.data.reason,
      customerNote: parsed.data.customerNote,
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/account');
  return { error: null, ok: true };
}

const idSchema = z.object({ refundRequestId: z.string().uuid() });

export async function withdrawRefundAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = idSchema.safeParse({ refundRequestId: formData.get('refundRequestId') });
  if (!parsed.success) return { error: 'طلب غير صالح' };

  const actor = await requireActor('/account');
  try {
    await withdrawRefundRequest(actor, parsed.data.refundRequestId);
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/account');
  return { error: null, ok: true };
}

const decisionSchema = z.object({
  refundRequestId: z.string().uuid(),
  decisionNote: z.string().max(2000).optional(),
});

export async function approveRefundAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = decisionSchema.safeParse({
    refundRequestId: formData.get('refundRequestId'),
    decisionNote: formData.get('decisionNote') ?? undefined,
  });
  if (!parsed.success) return { error: 'طلب غير صالح' };

  const actor = await requireOwner('/admin/refunds');
  try {
    await approveRefund(actor, {
      refundRequestId: parsed.data.refundRequestId,
      decisionNote: parsed.data.decisionNote ?? null,
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/admin/refunds');
  revalidatePath('/admin/finance');
  return { error: null, ok: true };
}

const rejectSchema = z.object({
  refundRequestId: z.string().uuid(),
  decisionNote: z.string().min(3).max(2000),
});

export async function rejectRefundAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rejectSchema.safeParse({
    refundRequestId: formData.get('refundRequestId'),
    decisionNote: formData.get('decisionNote'),
  });
  if (!parsed.success) return { error: 'اذكر سبب الرفض' };

  const actor = await requireOwner('/admin/refunds');
  try {
    await rejectRefund(actor, {
      refundRequestId: parsed.data.refundRequestId,
      decisionNote: parsed.data.decisionNote,
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/admin/refunds');
  return { error: null, ok: true };
}

const payoutSchema = z.object({
  refundRequestId: z.string().uuid(),
  payoutReference: z.string().max(200).optional(),
});

export async function markRefundPaidAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = payoutSchema.safeParse({
    refundRequestId: formData.get('refundRequestId'),
    payoutReference: formData.get('payoutReference') ?? undefined,
  });
  if (!parsed.success) return { error: 'طلب غير صالح' };

  const actor = await requireOwner('/admin/refunds');
  try {
    await markRefundPaid(actor, {
      refundRequestId: parsed.data.refundRequestId,
      payoutReference: parsed.data.payoutReference ?? null,
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/admin/refunds');
  revalidatePath('/admin/finance');
  return { error: null, ok: true };
}
