'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwner } from '@/auth/current';
import { addEngineer, setEngineerActive, updateEngineer } from './admin';
import { toUserMessage } from '@/lib/action-errors';

/**
 * The owner's engineers screen, server side (§19, §32, §46).
 *
 * Every action re-authorises from the session and re-parses every field.
 * A form is a thing a browser sent; the buttons that produced it were rendered
 * by a page that had already checked, and neither fact travels with the POST.
 *
 * NOTHING HERE WRITES A RATE OR A PRODUCT. Rates go through
 * `/admin/commissions`, products through `/admin/products`. This file moves
 * only what belongs to the engineer's own profile.
 */

export type EngineerState = { error: string | null; ok?: boolean };

const ADMIN_PATH = '/admin/engineers';

const addSchema = z.object({
  email: z.string().email().max(255),
  displayName: z.string().min(2).max(120),
  publicSlug: z.string().min(2).max(64),
  settlementCode: z.string().min(2).max(24),
  disciplineId: z.string().uuid().or(z.literal('')).optional(),
  specialization: z.string().max(120).optional(),
  bio: z.string().max(1000).optional(),
});

export async function addEngineerAction(
  _previous: EngineerState,
  formData: FormData,
): Promise<EngineerState> {
  const parsed = addSchema.safeParse({
    email: formData.get('email'),
    displayName: formData.get('displayName'),
    publicSlug: formData.get('publicSlug'),
    settlementCode: formData.get('settlementCode'),
    disciplineId: formData.get('disciplineId') ?? '',
    specialization: formData.get('specialization') ?? undefined,
    bio: formData.get('bio') ?? undefined,
  });
  if (!parsed.success) return { error: 'بيانات غير صالحة' };

  const actor = await requireOwner(ADMIN_PATH);

  try {
    await addEngineer(actor, {
      email: parsed.data.email,
      displayName: parsed.data.displayName,
      publicSlug: parsed.data.publicSlug,
      settlementCode: parsed.data.settlementCode,
      disciplineId: parsed.data.disciplineId || null,
      specialization: parsed.data.specialization ?? null,
      bio: parsed.data.bio ?? null,
    });
  } catch (error) {
    return { error: toUserMessage(error, 'Add engineer failed') };
  }

  revalidatePath(ADMIN_PATH);
  return { error: null, ok: true };
}

const updateSchema = z.object({
  contributorId: z.string().uuid(),
  displayName: z.string().min(2).max(120),
  disciplineId: z.string().uuid().or(z.literal('')).optional(),
  specialization: z.string().max(120).optional(),
  bio: z.string().max(1000).optional(),
});

export async function updateEngineerAction(
  _previous: EngineerState,
  formData: FormData,
): Promise<EngineerState> {
  const parsed = updateSchema.safeParse({
    contributorId: formData.get('contributorId'),
    displayName: formData.get('displayName'),
    disciplineId: formData.get('disciplineId') ?? '',
    specialization: formData.get('specialization') ?? undefined,
    bio: formData.get('bio') ?? undefined,
  });
  if (!parsed.success) return { error: 'بيانات غير صالحة' };

  const actor = await requireOwner(ADMIN_PATH);

  try {
    await updateEngineer(actor, {
      contributorId: parsed.data.contributorId,
      displayName: parsed.data.displayName,
      disciplineId: parsed.data.disciplineId || null,
      specialization: parsed.data.specialization ?? null,
      bio: parsed.data.bio ?? null,
    });
  } catch (error) {
    return { error: toUserMessage(error, 'Update engineer failed') };
  }

  revalidatePath(ADMIN_PATH);
  revalidatePath(`${ADMIN_PATH}/${parsed.data.contributorId}`);
  return { error: null, ok: true };
}

const activeSchema = z.object({
  contributorId: z.string().uuid(),
  /*
   * The DESIRED state, sent explicitly. A "toggle" button decides from what
   * the page was showing, so two clicks on a stale page flip an engineer back
   * on after the owner turned them off.
   */
  isActive: z.enum(['true', 'false']),
});

export async function setEngineerActiveAction(
  _previous: EngineerState,
  formData: FormData,
): Promise<EngineerState> {
  const parsed = activeSchema.safeParse({
    contributorId: formData.get('contributorId'),
    isActive: formData.get('isActive'),
  });
  if (!parsed.success) return { error: 'بيانات غير صالحة' };

  const actor = await requireOwner(ADMIN_PATH);

  try {
    await setEngineerActive(actor, {
      contributorId: parsed.data.contributorId,
      isActive: parsed.data.isActive === 'true',
    });
  } catch (error) {
    return { error: toUserMessage(error, 'Set engineer active failed') };
  }

  revalidatePath(ADMIN_PATH);
  revalidatePath(`${ADMIN_PATH}/${parsed.data.contributorId}`);
  return { error: null, ok: true };
}
