'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { currentActor, requireActor, requireOwner } from '@/auth/current';
import {
  createOrder, completeFreeOrder, placeOrder, approvePayment, rejectPayment,
} from './orders';
import { submitPaymentProof } from './proofs';
import { toUserMessage } from '@/lib/action-errors';

/**
 * Server actions for the purchase flow.
 *
 * Each one re-authorises from the session rather than trusting anything the
 * form carried: a hidden field saying "I am the owner" is just a string a
 * browser sent.
 */

export type ActionState = { error: string | null; ok?: boolean };

function toMessage(error: unknown): string {
  return toUserMessage(error, 'Commerce action failed');
}

const buySchema = z.object({ slug: z.string().min(1).max(200) });

/** Product page → a draft order → the checkout screen. */
export async function startPurchaseAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = buySchema.safeParse({ slug: formData.get('slug') });
  if (!parsed.success) return { error: 'منتج غير صالح' };

  const actor = await currentActor();
  if (actor.kind !== 'USER') {
    redirect(`/login?next=${encodeURIComponent(`/products/${parsed.data.slug}`)}`);
  }

  let orderId: string;
  let free: boolean;
  try {
    const order = await createOrder(actor, { productSlugs: [parsed.data.slug] });
    orderId = order.orderId;
    free = order.totalMinor === 0n;
    // A free product is taken on the spot: no payment method, no receipt.
    if (free) await completeFreeOrder(actor, { orderId });
  } catch (error) {
    return { error: toMessage(error) };
  }

  redirect(free ? '/account' : `/checkout/${orderId}`);
}

const freeSchema = z.object({ orderId: z.string().uuid() });

/**
 * The checkout screen's way to finish a free order still in DRAFT — one left
 * behind before free orders completed on the spot, or one whose completion
 * failed. The same guarded function, so the same checks.
 */
export async function completeFreeOrderAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = freeSchema.safeParse({ orderId: formData.get('orderId') });
  if (!parsed.success) return { error: 'طلب غير صالح' };

  const actor = await requireActor(`/checkout/${parsed.data.orderId}`);

  try {
    await completeFreeOrder(actor, parsed.data);
  } catch (error) {
    return { error: toMessage(error) };
  }

  redirect('/account');
}

const methodSchema = z.object({
  orderId: z.string().uuid(),
  paymentMethodId: z.string().uuid(),
});

export async function choosePaymentMethodAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = methodSchema.safeParse({
    orderId: formData.get('orderId'),
    paymentMethodId: formData.get('paymentMethodId'),
  });
  if (!parsed.success) return { error: 'طريقة دفع غير صالحة' };

  const actor = await requireActor(`/checkout/${parsed.data.orderId}`);

  let initiation: Awaited<ReturnType<typeof placeOrder>>;
  try {
    initiation = await placeOrder(actor, parsed.data);
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath(`/checkout/${parsed.data.orderId}`);

  // WhatsApp assistance hands the customer to a person (§23). The link was
  // built for this order; returning without it left the customer on a page
  // promising a chat that never opened (W2). The order page keeps a link too.
  if (initiation.kind === 'ASSISTED') redirect(initiation.url);

  return { error: null, ok: true };
}

const proofSchema = z.object({
  orderId: z.string().uuid(),
  paymentId: z.string().uuid(),
  referenceNote: z.string().max(200).optional(),
});

export async function submitProofAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = proofSchema.safeParse({
    orderId: formData.get('orderId'),
    paymentId: formData.get('paymentId'),
    referenceNote: formData.get('referenceNote') ?? undefined,
  });
  if (!parsed.success) return { error: 'بيانات غير صالحة' };

  const file = formData.get('proof');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'يرجى اختيار صورة الإيصال' };
  }

  const actor = await requireActor(`/checkout/${parsed.data.orderId}`);

  try {
    await submitPaymentProof(actor, {
      paymentId: parsed.data.paymentId,
      filename: file.name,
      body: new Uint8Array(await file.arrayBuffer()),
      referenceNote: parsed.data.referenceNote ?? null,
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath(`/checkout/${parsed.data.orderId}`);
  return { error: null, ok: true };
}

const decisionSchema = z.object({
  paymentId: z.string().uuid(),
  providerRef: z.string().max(120).optional(),
  reason: z.string().max(400).optional(),
});

/** Owner approves. This is the transition that settles the sale. */
export async function approvePaymentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = decisionSchema.safeParse({
    paymentId: formData.get('paymentId'),
    providerRef: formData.get('providerRef') ?? undefined,
  });
  if (!parsed.success) return { error: 'بيانات غير صالحة' };

  const actor = await requireOwner('/admin/payments');

  try {
    await approvePayment(actor, {
      paymentId: parsed.data.paymentId,
      providerRef: parsed.data.providerRef ?? null,
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/admin/payments');
  return { error: null, ok: true };
}

export async function rejectPaymentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = decisionSchema.safeParse({
    paymentId: formData.get('paymentId'),
    reason: formData.get('reason') ?? undefined,
  });
  if (!parsed.success || !parsed.data.reason?.trim()) {
    return { error: 'يرجى كتابة سبب الرفض' };
  }

  const actor = await requireOwner('/admin/payments');

  try {
    await rejectPayment(actor, {
      paymentId: parsed.data.paymentId,
      reason: parsed.data.reason.trim(),
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath('/admin/payments');
  return { error: null, ok: true };
}
