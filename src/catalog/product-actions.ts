'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwner } from '@/auth/current';
import {
  changeProductPrice, changeProductStatus, createProduct,
  setProductContributors, updateProductDetails,
} from './products';
import { ingestProductFile } from '@/media/ingest';
import { parseMajorUnits } from '@/lib/money/money';
import { toUserMessage } from '@/lib/action-errors';
import type { ProductStatus } from './publication';

/**
 * The owner's catalogue actions (§26, §27, §30).
 *
 * Every one re-authorises from the session and re-parses its input. A form
 * field naming a product, a price or an engineer is a string a browser sent;
 * what it decides is what a customer pays and what an engineer earns.
 *
 * This file exports ONLY async functions — a `'use server'` module may export
 * nothing else, so the initial action state lives with the components.
 */

export type ProductActionState = { error: string | null; ok?: boolean };

const FILE_TYPES = ['PDF', 'EXCEL', 'CAD', 'REVIT_BIM', 'ARCHIVE', 'TEMPLATE', 'PROJECT', 'OTHER'] as const;
const LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'] as const;

function toMessage(error: unknown): string {
  return toUserMessage(error, 'Catalogue action failed');
}

const createSchema = z.object({
  slug: z.string().min(2).max(120),
  titleAr: z.string().min(2).max(300),
  subtitleAr: z.string().max(300).optional(),
  descriptionAr: z.string().max(4000).optional(),
  disciplineId: z.string().uuid(),
  categoryId: z.string().uuid().or(z.literal('')).optional(),
  fileType: z.enum(FILE_TYPES),
  level: z.enum(LEVELS).or(z.literal('')).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export async function createProductAction(
  _previous: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const parsed = createSchema.safeParse({
    slug: formData.get('slug'),
    titleAr: formData.get('titleAr'),
    subtitleAr: formData.get('subtitleAr') ?? undefined,
    descriptionAr: formData.get('descriptionAr') ?? undefined,
    disciplineId: formData.get('disciplineId'),
    categoryId: formData.get('categoryId') ?? '',
    fileType: formData.get('fileType'),
    level: formData.get('level') ?? '',
    currency: formData.get('currency'),
  });
  if (!parsed.success) return { error: 'بيانات المنتج غير صالحة' };

  const actor = await requireOwner('/admin/products');
  let productId: string;

  try {
    const created = await createProduct(actor, {
      slug: parsed.data.slug,
      titleAr: parsed.data.titleAr,
      subtitleAr: parsed.data.subtitleAr ?? null,
      descriptionAr: parsed.data.descriptionAr ?? null,
      disciplineId: parsed.data.disciplineId,
      categoryId: parsed.data.categoryId || null,
      fileType: parsed.data.fileType,
      level: parsed.data.level || null,
      currency: parsed.data.currency,
    });
    productId = created.productId;
  } catch (error) {
    return { error: toMessage(error) };
  }

  // Straight to the product's own screen: a draft with nothing on it is not a
  // place to stop, and the next three steps all live there.
  redirect(`/admin/products/${productId}`);
}

const detailsSchema = z.object({
  productId: z.string().uuid(),
  titleAr: z.string().min(2).max(300),
  subtitleAr: z.string().max(300).optional(),
  descriptionAr: z.string().max(4000).optional(),
  level: z.enum(LEVELS).or(z.literal('')).optional(),
  softwareTags: z.string().max(400).optional(),
});

export async function updateProductAction(
  _previous: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const parsed = detailsSchema.safeParse({
    productId: formData.get('productId'),
    titleAr: formData.get('titleAr'),
    subtitleAr: formData.get('subtitleAr') ?? undefined,
    descriptionAr: formData.get('descriptionAr') ?? undefined,
    level: formData.get('level') ?? '',
    softwareTags: formData.get('softwareTags') ?? undefined,
  });
  if (!parsed.success) return { error: 'بيانات غير صالحة' };

  const actor = await requireOwner('/admin/products');
  try {
    await updateProductDetails(actor, {
      productId: parsed.data.productId,
      titleAr: parsed.data.titleAr,
      subtitleAr: parsed.data.subtitleAr ?? null,
      descriptionAr: parsed.data.descriptionAr ?? null,
      level: parsed.data.level || null,
      softwareTags: (parsed.data.softwareTags ?? '')
        .split(',').map((t) => t.trim()).filter(Boolean),
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath(`/admin/products/${parsed.data.productId}`);
  return { error: null, ok: true };
}

const uploadSchema = z.object({
  productId: z.string().uuid(),
  // The product's own declared type: the pipeline checks the bytes against it
  // rather than trusting the extension a browser reported.
  declaredType: z.enum(FILE_TYPES),
});

/**
 * Upload the product's file.
 *
 * The bytes go through `ingestProductFile`, the same path everything else
 * uses: it fixes the storage key, scans, and renders the preview. Nothing here
 * writes to storage itself — a second way into the bucket is a second set of
 * rules to keep in step.
 */
export async function uploadProductFileAction(
  _previous: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const parsed = uploadSchema.safeParse({
    productId: formData.get('productId'),
    declaredType: formData.get('declaredType'),
  });
  if (!parsed.success) return { error: 'منتج غير صالح' };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'اختر ملفاً أولاً' };
  }

  const actor = await requireOwner('/admin/products');
  try {
    await ingestProductFile(actor, {
      productId: parsed.data.productId,
      filename: file.name,
      declaredType: parsed.data.declaredType,
      body: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type || 'application/octet-stream',
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath(`/admin/products/${parsed.data.productId}`);
  return { error: null, ok: true };
}

const creditsSchema = z.object({
  productId: z.string().uuid(),
  /** Repeated fields: one contributor id and one percentage per row. */
  contributorIds: z.array(z.string().uuid()).min(1),
  percents: z.array(z.string()).min(1),
});

/**
 * Credit the engineers and set their shares.
 *
 * The shares must total exactly 100%; `setProductContributors` refuses
 * anything else, and it is right to refuse — a product whose credits sum to
 * 95% would silently pay nobody the missing five.
 */
export async function setCreditsAction(
  _previous: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const parsed = creditsSchema.safeParse({
    productId: formData.get('productId'),
    contributorIds: formData.getAll('contributorId').filter((v) => v !== ''),
    percents: formData.getAll('percent').filter((v) => v !== ''),
  });
  if (!parsed.success) return { error: 'اختر مهندساً واحداً على الأقل بنسبة صحيحة' };
  if (parsed.data.contributorIds.length !== parsed.data.percents.length) {
    return { error: 'لكل مهندس نسبة واحدة' };
  }

  const actor = await requireOwner('/admin/products');

  try {
    // Percent → basis points from the digits themselves. `Math.round` is
    // banned repo-wide, and a binary fraction cannot hold 33.33 faithfully.
    const shares = parsed.data.contributorIds.map((contributorId, index) => {
      const raw = parsed.data.percents[index]!.trim();
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) {
        throw new Error(`نسبة غير صالحة: ${raw}`);
      }
      const [whole, fraction = ''] = raw.split('.');
      return { contributorId, shareBp: Number(whole) * 100 + Number(fraction.padEnd(2, '0')) };
    });

    await setProductContributors(actor, parsed.data.productId, shares);
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath(`/admin/products/${parsed.data.productId}`);
  return { error: null, ok: true };
}

const priceSchema = z.object({
  productId: z.string().uuid(),
  amount: z.string().min(1).max(20),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reason: z.string().max(300).optional(),
});

/**
 * Set or change the price.
 *
 * Never an in-place edit: `changeProductPrice` closes the open row and opens a
 * new one, so the price in force on any past date stays reconstructible — and
 * a sale already made keeps the price it was made at regardless.
 */
export async function changePriceAction(
  _previous: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const parsed = priceSchema.safeParse({
    productId: formData.get('productId'),
    amount: formData.get('amount'),
    currency: formData.get('currency'),
    reason: formData.get('reason') ?? undefined,
  });
  if (!parsed.success) return { error: 'بيانات السعر غير صالحة' };

  const actor = await requireOwner('/admin/products');
  try {
    await changeProductPrice(actor, {
      productId: parsed.data.productId,
      newAmountMinor: parseMajorUnits(parsed.data.amount, parsed.data.currency).amountMinor,
      currency: parsed.data.currency,
      ...(parsed.data.reason?.trim() ? { reason: parsed.data.reason.trim() } : {}),
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath(`/admin/products/${parsed.data.productId}`);
  return { error: null, ok: true };
}

const statusSchema = z.object({
  productId: z.string().uuid(),
  to: z.enum([
    'DRAFT', 'SUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED',
    'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED',
  ]),
  note: z.string().max(400).optional(),
});

export async function changeStatusAction(
  _previous: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const parsed = statusSchema.safeParse({
    productId: formData.get('productId'),
    to: formData.get('to'),
    note: formData.get('note') ?? undefined,
  });
  if (!parsed.success) return { error: 'حالة غير صالحة' };

  const actor = await requireOwner('/admin/products');
  try {
    await changeProductStatus(actor, {
      productId: parsed.data.productId,
      to: parsed.data.to as ProductStatus,
      ...(parsed.data.note?.trim() ? { note: parsed.data.note.trim() } : {}),
    });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath(`/admin/products/${parsed.data.productId}`);
  revalidatePath('/admin/products');
  return { error: null, ok: true };
}
