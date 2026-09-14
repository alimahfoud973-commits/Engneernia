'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwner } from '@/auth/current';
import { generateSettlements } from './generate';
import { approveSettlement, cancelSettlement, markSettlementPaid } from './lifecycle';
import { toUserMessage } from '@/lib/action-errors';

/**
 * Server actions for the settlement run.
 *
 * Every one is owner-only and re-resolves the actor from the session. These
 * are the actions that move money out of the platform; a hidden form field is
 * not evidence of anything.
 */

export type ActionState = { error: string | null; ok?: boolean; message?: string };

function toMessage(error: unknown): string {
  return toUserMessage(error, 'Settlement action failed');
}

const periodSchema = z.object({
  periodKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'الفترة تُكتب YYYY-MM'),
});

export async function generateSettlementsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = periodSchema.safeParse({ periodKey: formData.get('periodKey') });
  if (!parsed.success) return { error: 'الفترة تُكتب بالصيغة YYYY-MM' };

  const actor = await requireOwner('/admin/settlements');

  try {
    const run = await generateSettlements(actor, { periodKey: parsed.data.periodKey });
    revalidatePath('/admin/settlements');

    const payable = run.generated.filter((row) => row.netDueMinor > 0n).length;
    const carried = run.generated.filter((row) => row.status === 'CARRIED_FORWARD').length;

    return {
      error: null,
      ok: true,
      message:
        `صدر ${run.generated.length} كشفاً: ${payable} مستحق للصرف، `
        + `${carried} مُرحَّل. ${run.skipped.length} تُخطّي.`
        + (run.unexplained.length > 0
          ? ` تنبيه: ${run.unexplained.length} كشفاً يحمل سطر تسوية لفرق غير مفصّل.`
          : ''),
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

const idSchema = z.object({ settlementId: z.string().uuid() });

export async function approveSettlementAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = idSchema.safeParse({ settlementId: formData.get('settlementId') });
  if (!parsed.success) return { error: 'كشف غير صالح' };

  const actor = await requireOwner('/admin/settlements');
  try {
    await approveSettlement(actor, {
      settlementId: parsed.data.settlementId,
      note: (formData.get('note') as string | null) ?? null,
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/admin/settlements');
  return { error: null, ok: true };
}

const payoutSchema = z.object({
  settlementId: z.string().uuid(),
  payoutMethod: z.string().max(120).optional(),
  payoutReference: z.string().max(200).optional(),
});

export async function markSettlementPaidAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = payoutSchema.safeParse({
    settlementId: formData.get('settlementId'),
    payoutMethod: formData.get('payoutMethod') ?? undefined,
    payoutReference: formData.get('payoutReference') ?? undefined,
  });
  if (!parsed.success) return { error: 'بيانات الصرف غير صالحة' };

  const actor = await requireOwner('/admin/settlements');
  try {
    await markSettlementPaid(actor, {
      settlementId: parsed.data.settlementId,
      payoutMethod: parsed.data.payoutMethod ?? null,
      payoutReference: parsed.data.payoutReference ?? null,
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/admin/settlements');
  revalidatePath('/admin/finance');
  return { error: null, ok: true };
}

const cancelSchema = z.object({
  settlementId: z.string().uuid(),
  reason: z.string().min(3).max(2000),
});

export async function cancelSettlementAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = cancelSchema.safeParse({
    settlementId: formData.get('settlementId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { error: 'اذكر سبب الإلغاء' };

  const actor = await requireOwner('/admin/settlements');
  try {
    await cancelSettlement(actor, {
      settlementId: parsed.data.settlementId,
      reason: parsed.data.reason,
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/admin/settlements');
  return { error: null, ok: true };
}
