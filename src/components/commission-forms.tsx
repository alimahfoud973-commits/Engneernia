'use client';

import { useActionState, useState } from 'react';
import { saveCommissionAction, type CommissionState } from '@/finance/commission-actions';

const INITIAL: CommissionState = { error: null };

const FIELD =
  'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm';

export interface EngineerOption {
  readonly contributorId: string;
  readonly displayName: string;
}

export interface ProductOption {
  readonly contributorId: string;
  readonly productId: string;
  readonly titleAr: string;
}

/**
 * Set ONE engineer's terms (§11, OPEN-15).
 *
 * The product select is optional, and its default — "every product" — is the
 * engineer's default agreement. That ordering is deliberate: the common case
 * is one rate for an engineer, and an override is the exception that has to be
 * chosen rather than the shape everything is filed under.
 */
export function CommissionForm({
  engineers,
  products,
  currency,
}: {
  engineers: readonly EngineerOption[];
  products: readonly ProductOption[];
  currency: string;
}) {
  const [state, formAction, pending] = useActionState(saveCommissionAction, INITIAL);
  const [model, setModel] = useState<string>('PERCENTAGE');
  const [engineer, setEngineer] = useState<string>('');

  /*
   * Only the chosen engineer's products. An override for a product they hold
   * no credit on is terms that can never apply, and listing the whole
   * catalogue makes the control unusable the moment the catalogue grows.
   */
  const scoped = products.filter((p) => p.contributorId === engineer);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">المهندس</span>
          <select
            name="contributorId"
            required
            className={FIELD}
            value={engineer}
            onChange={(event) => setEngineer(event.target.value)}
          >
            <option value="" disabled>
              اختر المهندس
            </option>
            {engineers.map((engineer) => (
              <option key={engineer.contributorId} value={engineer.contributorId}>
                {engineer.displayName}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">النطاق</span>
          <select name="productId" className={FIELD} defaultValue="" disabled={engineer === ''}>
            <option value="">كل منتجاته (الاتفاق الافتراضي)</option>
            {scoped.map((product) => (
              <option key={product.productId} value={product.productId}>
                {product.titleAr}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">نوع الاتفاق</span>
          <select
            name="model"
            className={FIELD}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="PERCENTAGE">نسبة مئوية للمهندس</option>
            <option value="FIXED_ENGINEER">مبلغ ثابت للمهندس</option>
            <option value="FIXED_PLATFORM">مبلغ ثابت للمنصة</option>
          </select>
        </label>

        {model === 'PERCENTAGE' ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--color-ink-faint)]">
              حصة المهندس ٪ (مثال ٨٠ أو ٧٫٢٥)
            </span>
            <input name="percent" inputMode="decimal" required className={FIELD} placeholder="80" />
          </label>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--color-ink-faint)]">
              المبلغ الثابت ({currency})
            </span>
            <input name="amount" inputMode="decimal" required className={FIELD} placeholder="11.00" />
          </label>
        )}
      </div>

      <input type="hidden" name="currency" value={currency} />

      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-faint)]">ملاحظة (اختيارية)</span>
        <input name="note" className={FIELD} placeholder="سبب التغيير" maxLength={400} />
      </label>

      <p className="text-xs leading-relaxed text-[var(--color-ink-faint)]">
        يُغلق الاتفاق الحالي ويُفتح اتفاق جديد اعتباراً من الآن. المبيعات السابقة لا تتغيّر:
        كل عملية بيع تحمل النسبة التي جرت بها، مجمَّدة في قاعدة البيانات.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {pending ? 'جارٍ الحفظ…' : 'حفظ الاتفاق'}
        </button>
        {state.ok ? (
          <span className="text-sm text-[var(--color-ok)]">حُفظ الاتفاق الجديد.</span>
        ) : null}
      </div>

      {state.error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
