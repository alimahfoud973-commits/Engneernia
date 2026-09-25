'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwner } from '@/auth/current';
import { toUserMessage } from '@/lib/action-errors';
import {
  createPaymentMethod, setPaymentMethodActive, updatePaymentMethod,
  type PaymentMethodFields,
} from './admin';

/**
 * The owner's payment-methods screen, server side (§21 — F3).
 *
 * Every action re-authorises from the session and re-parses every field. The
 * account number a customer is told to pay into is set here; a hidden input
 * is only a string a browser sent.
 */

export type PaymentMethodState = { error: string | null; ok?: boolean };

const ADMIN_PATH = '/admin/payment-methods';

const fieldsSchema = z.object({
  displayNameAr: z.string().max(200),
  displayNameEn: z.string().max(200).optional(),
  descriptionAr: z.string().max(1000).optional(),
  instructionsAr: z.string().max(4000).optional(),
  accountDetailsAr: z.string().max(2000).optional(),
  supportMessageAr: z.string().max(2000).optional(),
  countries: z.string().max(400).optional(),
  currencies: z.string().max(200).optional(),
  sortOrder: z.string().regex(/^\d{1,4}$/),
});

/** "SY, SA" → ['SY', 'SA']. Validation of each code is the service's. */
const list = (value: string | undefined) =>
  (value ?? '').split(/[,،\s]+/).filter((item) => item !== '');

function readFields(formData: FormData): PaymentMethodFields | null {
  const parsed = fieldsSchema.safeParse({
    displayNameAr: formData.get('displayNameAr') ?? '',
    displayNameEn: formData.get('displayNameEn') ?? undefined,
    descriptionAr: formData.get('descriptionAr') ?? undefined,
    instructionsAr: formData.get('instructionsAr') ?? undefined,
    accountDetailsAr: formData.get('accountDetailsAr') ?? undefined,
    supportMessageAr: formData.get('supportMessageAr') ?? undefined,
    countries: formData.get('countries') ?? undefined,
    currencies: formData.get('currencies') ?? undefined,
    sortOrder: formData.get('sortOrder') ?? '',
  });
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    displayNameAr: d.displayNameAr,
    displayNameEn: d.displayNameEn ?? null,
    descriptionAr: d.descriptionAr ?? null,
    instructionsAr: d.instructionsAr ?? null,
    accountDetailsAr: d.accountDetailsAr ?? null,
    supportMessageAr: d.supportMessageAr ?? null,
    // An unchecked checkbox is simply absent from the form.
    requiresProof: formData.get('requiresProof') === 'on',
    countries: list(d.countries),
    currencies: list(d.currencies),
    sortOrder: Number(d.sortOrder),
  };
}

const createSchema = z.object({
  code: z.string().min(2).max(50),
  type: z.enum(['MANUAL', 'ASSISTED']),
});

export async function createPaymentMethodAction(
  _previous: PaymentMethodState,
  formData: FormData,
): Promise<PaymentMethodState> {
  const head = createSchema.safeParse({ code: formData.get('code'), type: formData.get('type') });
  const fields = readFields(formData);
  if (!head.success || !fields) return { error: 'بيانات طريقة الدفع غير صالحة' };

  const actor = await requireOwner(ADMIN_PATH);
  try {
    await createPaymentMethod(actor, {
      ...fields,
      code: head.data.code,
      type: head.data.type,
      isActive: formData.get('isActive') === 'on',
    });
  } catch (error) {
    return { error: toUserMessage(error, 'Create payment method failed') };
  }

  revalidatePath(ADMIN_PATH);
  return { error: null, ok: true };
}

export async function updatePaymentMethodAction(
  _previous: PaymentMethodState,
  formData: FormData,
): Promise<PaymentMethodState> {
  const id = z.string().uuid().safeParse(formData.get('methodId'));
  const fields = readFields(formData);
  if (!id.success || !fields) return { error: 'بيانات طريقة الدفع غير صالحة' };

  const actor = await requireOwner(ADMIN_PATH);
  try {
    await updatePaymentMethod(actor, id.data, fields);
  } catch (error) {
    return { error: toUserMessage(error, 'Update payment method failed') };
  }

  revalidatePath(ADMIN_PATH);
  return { error: null, ok: true };
}

const activeSchema = z.object({
  methodId: z.string().uuid(),
  // The DESIRED state, never a toggle read from a possibly stale page.
  isActive: z.enum(['true', 'false']),
});

export async function setPaymentMethodActiveAction(
  _previous: PaymentMethodState,
  formData: FormData,
): Promise<PaymentMethodState> {
  const parsed = activeSchema.safeParse({
    methodId: formData.get('methodId'),
    isActive: formData.get('isActive'),
  });
  if (!parsed.success) return { error: 'بيانات غير صالحة' };

  const actor = await requireOwner(ADMIN_PATH);
  try {
    await setPaymentMethodActive(actor, {
      methodId: parsed.data.methodId,
      isActive: parsed.data.isActive === 'true',
    });
  } catch (error) {
    return { error: toUserMessage(error, 'Set payment method active failed') };
  }

  revalidatePath(ADMIN_PATH);
  return { error: null, ok: true };
}
