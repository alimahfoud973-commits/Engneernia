import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { paymentMethods } from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { isOwner, type Actor } from '@/authz/actor';
import { ConflictError, NotFoundError, RuleViolationError, ValidationError } from '@/lib/errors';
import { getPublicSettings } from '@/platform/settings';
import { methodGaps, toConfig } from './registry';

/**
 * ===========================================================================
 * THE OWNER'S PAYMENT METHODS (specification §21 — Stage 2 audit, F3)
 * ===========================================================================
 * Before this, every method was a row only a database console could change:
 * the bank account customers pay into, whether a method is offered at all,
 * its order on the checkout. Now the owner sets them here, and each change is
 * written to the audit log in the transaction that makes it (rule 12) — the
 * account money is sent to is exactly what an audit trail must be able to
 * answer for.
 *
 * OWNER-ONLY at every layer: the page calls `requireOwner`, each function
 * here refuses anyone else, and `payment_methods_write` (0020) admits only
 * `app_is_owner()` — so a non-owner reaching a function directly still writes
 * nothing.
 *
 * NOT HERE, deliberately:
 *   - provider credentials — they live in `payment_method_secrets` (0020),
 *     which this module never reads or writes, so none can reach the page,
 *     the audit log or an error message;
 *   - deleting a method. Payments reference it (ON DELETE RESTRICT) and an
 *     order's history must keep its method. Retiring one is disabling it:
 *     new orders stop seeing it at once, orders already placed keep what
 *     they were told (migration 0055);
 *   - the method's code and type once created — the code is the stable
 *     reference in history, and the type chooses the code that runs it.
 * ===========================================================================
 */

/** The fields the owner edits. Everything else on the row is fixed or derived. */
export interface PaymentMethodFields {
  readonly displayNameAr: string;
  readonly displayNameEn: string | null;
  readonly descriptionAr: string | null;
  readonly instructionsAr: string | null;
  readonly accountDetailsAr: string | null;
  readonly supportMessageAr: string | null;
  readonly requiresProof: boolean;
  readonly countries: readonly string[];
  readonly currencies: readonly string[];
  readonly sortOrder: number;
}

export interface AdminPaymentMethodRow extends PaymentMethodFields {
  readonly id: string;
  readonly code: string;
  readonly type: 'MANUAL' | 'ASSISTED' | 'GATEWAY';
  readonly isActive: boolean;
  /** Why an active method is still not offered to anyone; empty when it is. */
  readonly gaps: readonly string[];
  /** Active and complete: customers see it (country, currency and amount aside). */
  readonly offeredToBuyers: boolean;
}

/** Methods the owner may create. A gateway needs an integration that does not exist (decisions §2). */
export type CreatableType = 'MANUAL' | 'ASSISTED';

const CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertOwner(actor: Actor): void {
  if (!isOwner(actor)) {
    throw new RuleViolationError('إدارة طرق الدفع من صلاحية مالك المنصة وحده');
  }
}

function text(value: string | null | undefined, label: string, max: number): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed.length > max) {
    throw new ValidationError(`${label} أطول من المسموح (${max} حرفاً)`);
  }
  return trimmed === '' ? null : trimmed;
}

function codes(values: readonly string[], pattern: RegExp, label: string): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim().toUpperCase();
    if (value === '') continue;
    if (!pattern.test(value)) throw new ValidationError(`${label} غير صالح: ${raw}`);
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** Trim, bound and normalise what the owner typed. Throws on anything unusable. */
export function normalizeFields(input: PaymentMethodFields): PaymentMethodFields {
  const displayNameAr = text(input.displayNameAr, 'اسم طريقة الدفع', 100);
  if (!displayNameAr) throw new ValidationError('اسم طريقة الدفع مطلوب');
  if (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 9999) {
    throw new ValidationError('الترتيب رقم صحيح بين 0 و 9999');
  }
  return {
    displayNameAr,
    displayNameEn: text(input.displayNameEn, 'الاسم الإنجليزي', 100),
    descriptionAr: text(input.descriptionAr, 'الوصف', 500),
    instructionsAr: text(input.instructionsAr, 'تعليمات الدفع', 2000),
    accountDetailsAr: text(input.accountDetailsAr, 'بيانات الحساب', 1000),
    supportMessageAr: text(input.supportMessageAr, 'رسالة الدعم', 1000),
    requiresProof: input.requiresProof,
    countries: codes(input.countries, /^[A-Z]{2}$/, 'رمز الدولة'),
    currencies: codes(input.currencies, /^[A-Z]{3}$/, 'رمز العملة'),
    sortOrder: input.sortOrder,
  };
}

const FIELD_COLUMNS = {
  displayNameAr: paymentMethods.displayNameAr,
  displayNameEn: paymentMethods.displayNameEn,
  descriptionAr: paymentMethods.descriptionAr,
  instructionsAr: paymentMethods.instructionsAr,
  accountDetailsAr: paymentMethods.accountDetailsAr,
  supportMessageAr: paymentMethods.supportMessageAr,
  requiresProof: paymentMethods.requiresProof,
  countries: paymentMethods.countries,
  currencies: paymentMethods.currencies,
  sortOrder: paymentMethods.sortOrder,
};

async function readFields(
  tx: Transaction,
  methodId: string,
): Promise<(PaymentMethodFields & { isActive: boolean; code: string }) | null> {
  const [row] = await tx
    .select({ ...FIELD_COLUMNS, isActive: paymentMethods.isActive, code: paymentMethods.code })
    .from(paymentMethods)
    .where(eq(paymentMethods.id, methodId))
    .limit(1);
  return row ?? null;
}

/** Only what changed, compared by value — arrays included. */
function changes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code
    ?? (error as { code?: string })?.code;
  return code === '23505';
}

/** Every method, active or not, with what keeps an active one from customers. */
export async function paymentMethodsForOwner(actor: Actor): Promise<readonly AdminPaymentMethodRow[]> {
  assertOwner(actor);
  const { whatsapp } = await getPublicSettings();

  const rows = await withActor(actor, (tx) =>
    tx.select().from(paymentMethods).orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.code)),
  );

  return rows.map((row) => {
    const gaps = methodGaps(toConfig(row), whatsapp);
    return {
      id: row.id,
      code: row.code,
      type: row.type,
      isActive: row.isActive,
      displayNameAr: row.displayNameAr,
      displayNameEn: row.displayNameEn,
      descriptionAr: row.descriptionAr,
      instructionsAr: row.instructionsAr,
      accountDetailsAr: row.accountDetailsAr,
      supportMessageAr: row.supportMessageAr,
      requiresProof: row.requiresProof,
      countries: row.countries ?? [],
      currencies: row.currencies ?? [],
      sortOrder: row.sortOrder,
      gaps,
      offeredToBuyers: row.isActive && gaps.length === 0,
    };
  });
}

/** Add a method. Its code and type are fixed from here on. */
export async function createPaymentMethod(
  actor: Actor,
  input: PaymentMethodFields & { code: string; type: CreatableType; isActive: boolean },
): Promise<{ id: string }> {
  assertOwner(actor);

  const code = input.code.trim().toLowerCase();
  if (!CODE_PATTERN.test(code) || code.length > 50) {
    throw new ValidationError('الرمز يُكتب بحروف لاتينية صغيرة وأرقام وشرطات فقط (مثال: bank-transfer-2)');
  }
  if (input.type !== 'MANUAL' && input.type !== 'ASSISTED') {
    throw new ValidationError('نوع طريقة الدفع غير مدعوم');
  }
  const fields = normalizeFields(input);

  return withActor(actor, async (tx) => {
    let created: { id: string } | undefined;
    try {
      [created] = await tx
        .insert(paymentMethods)
        .values({
          code,
          type: input.type,
          ...fields,
          countries: [...fields.countries],
          currencies: [...fields.currencies],
          isActive: input.isActive,
        })
        .returning({ id: paymentMethods.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('يوجد طريقة دفع بهذا الرمز مسبقاً', { code });
      throw error;
    }
    // RLS refuses a write by returning no row rather than raising.
    if (!created) throw new RuleViolationError('رُفض إنشاء طريقة الدفع');

    await recordAudit(tx, actor, {
      action: 'PAYMENT_METHOD_CHANGED',
      entityType: 'payment_method',
      entityId: created.id,
      after: { event: 'created', code, type: input.type, isActive: input.isActive, ...fields },
    });
    return created;
  });
}

/** Edit a method's fields. A save that changes nothing writes nothing. */
export async function updatePaymentMethod(
  actor: Actor,
  methodId: string,
  input: PaymentMethodFields,
): Promise<{ changed: boolean }> {
  assertOwner(actor);
  const fields = normalizeFields(input);

  return withActor(actor, async (tx) => {
    const current = await readFields(tx, methodId);
    if (!current) throw new NotFoundError('طريقة الدفع غير موجودة');

    const { isActive: _active, code, ...before } = current;
    void _active;
    const diff = changes(before, { ...fields });
    if (Object.keys(diff.after).length === 0) return { changed: false };

    const updated = await tx
      .update(paymentMethods)
      .set({
        ...fields,
        countries: [...fields.countries],
        currencies: [...fields.currencies],
        updatedAt: new Date(),
      })
      .where(eq(paymentMethods.id, methodId))
      .returning({ id: paymentMethods.id });
    if (updated.length === 0) throw new RuleViolationError('لم يُطبَّق تعديل طريقة الدفع');

    await recordAudit(tx, actor, {
      action: 'PAYMENT_METHOD_CHANGED',
      entityType: 'payment_method',
      entityId: methodId,
      before: { code, ...diff.before },
      after: { event: 'updated', code, ...diff.after },
    });
    return { changed: true };
  });
}

/**
 * Turn a method on or off. The DESIRED state is sent, not a toggle: two clicks
 * on a stale page must not switch it back on.
 *
 * Disabling is also how a method is retired: new orders stop seeing it at
 * once, and orders already placed keep the instructions and account they were
 * given (migration 0055).
 */
export async function setPaymentMethodActive(
  actor: Actor,
  input: { methodId: string; isActive: boolean },
): Promise<{ changed: boolean }> {
  assertOwner(actor);

  return withActor(actor, async (tx) => {
    const current = await readFields(tx, input.methodId);
    if (!current) throw new NotFoundError('طريقة الدفع غير موجودة');
    if (current.isActive === input.isActive) return { changed: false };

    const updated = await tx
      .update(paymentMethods)
      .set({ isActive: input.isActive, updatedAt: new Date() })
      .where(eq(paymentMethods.id, input.methodId))
      .returning({ id: paymentMethods.id });
    if (updated.length === 0) throw new RuleViolationError('لم يُطبَّق تغيير حالة طريقة الدفع');

    await recordAudit(tx, actor, {
      action: 'PAYMENT_METHOD_CHANGED',
      entityType: 'payment_method',
      entityId: input.methodId,
      before: { code: current.code, isActive: current.isActive },
      after: { event: input.isActive ? 'enabled' : 'disabled', code: current.code, isActive: input.isActive },
    });
    return { changed: true };
  });
}
