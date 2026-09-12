'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import {
  confirmAdjustmentAction, previewAdjustmentAction, type AdjustmentState,
} from '@/finance/adjustment-actions';
import { formatMinor } from './money-display';
import { minorDigitsOf, type CurrencyCode } from '@/lib/money/currency';
import {
  ADJUSTMENT_DIRECTION_LABELS as DIRECTION_LABELS,
  ADJUSTMENT_REASON_LABELS,
  ADJUSTMENT_TARGET_LABELS as TARGET_LABELS,
} from '@/lib/labels';

/**
 * The adjustment tool (owner decision on OPEN-21).
 *
 * "لا أريد واجهة معقدة أو حشوًا. أريد أداة مالية صغيرة، واضحة، آمنة، قابلة
 *  للتدقيق، سهلة الاستخدام."
 *
 * So: one form, one summary, one confirmation. No wizard, no modals, no
 * account picker — the two accounts a correction moves between are fixed by
 * the service, because letting an operator choose arbitrary accounts is how a
 * ledger stops being auditable.
 *
 * The summary step is not decoration. It is where the owner sees the balance
 * before and after, and any warning, BEFORE anything is written.
 */

export const INITIAL_ADJUSTMENT: AdjustmentState = { error: null };


function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]"
    >
      {message}
    </p>
  );
}

const FIELD =
  'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm';

export function AdjustmentTool({
  contributors,
  currency,
}: {
  contributors: ReadonlyArray<{ id: string; displayName: string; isActive: boolean }>;
  currency: string;
}) {
  const [state, formAction, pending] = useActionState<AdjustmentState, FormData>(
    previewAdjustmentAction,
    INITIAL_ADJUSTMENT,
  );

  if (state.preview && state.idempotencyKey) {
    return (
      <AdjustmentSummary preview={state.preview} idempotencyKey={state.idempotencyKey} />
    );
  }

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
    >
      {state.posted ? (
        <p className="rounded-[var(--radius-card)] border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-2 text-sm">
          سُجِّل التصحيح{' '}
          <span className="technical-term font-semibold">{state.posted.reference}</span> في الدفتر.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold">الحساب المتأثر</span>
          <select name="target" required defaultValue="ENGINEER" className={FIELD}>
            <option value="ENGINEER">رصيد مهندس</option>
            <option value="PLATFORM">حساب المنصة</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold">نوع التعديل</span>
          <select name="direction" required defaultValue="INCREASE" className={FIELD}>
            <option value="INCREASE">زيادة</option>
            <option value="DECREASE">خصم</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold">المهندس</span>
          <select name="contributorId" defaultValue="" className={FIELD}>
            <option value="">— لا ينطبق (تعديل على حساب المنصة) —</option>
            {contributors.map((contributor) => (
              <option key={contributor.id} value={contributor.id}>
                {contributor.displayName}
                {contributor.isActive ? '' : ' (غير مفعَّل)'}
              </option>
            ))}
          </select>
          <span className="text-xs text-[var(--color-ink-faint)]">
            مطلوب عند اختيار «رصيد مهندس»، ويُترك فارغاً لتعديل حساب المنصة.
          </span>
        </label>

        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1.5 text-sm">
            <span className="font-semibold">المبلغ</span>
            <input
              type="text"
              name="amount"
              required
              inputMode="decimal"
              placeholder="12.50"
              className={`technical-term tabular-nums ${FIELD}`}
            />
          </label>
          <label className="flex w-24 flex-col gap-1.5 text-sm">
            <span className="font-semibold">العملة</span>
            <input
              type="text"
              name="currency"
              required
              defaultValue={currency}
              pattern="[A-Z]{3}"
              className={`technical-term ${FIELD}`}
            />
          </label>
        </div>
      </div>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-semibold">السبب</span>
        <select name="reason" required defaultValue="DATA_ENTRY_ERROR" className={FIELD}>
          {Object.entries(ADJUSTMENT_REASON_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-semibold">الشرح</span>
        <textarea
          name="note"
          required
          minLength={10}
          maxLength={2000}
          rows={3}
          placeholder="مثال: خصم رسوم تحويل بنكي تحمّلتها المنصة عن تسوية آب."
          className={FIELD}
        />
        <span className="text-xs text-[var(--color-ink-faint)]">
          يظهر هذا الشرح للمهندس المتأثر على سطر الدفتر وفي إشعاره.
        </span>
      </label>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] pt-3">
        <p className="text-xs text-[var(--color-ink-soft)]">
          لا يُكتب شيء الآن. ستُعرض عليك خلاصة التعديل وأثره قبل أي تأكيد.
        </p>
        <button
          type="submit"
          disabled={pending}
          className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {pending ? 'جارٍ الحساب…' : 'عرض الخلاصة'}
        </button>
      </div>

      <ErrorNote message={state.error} />
    </form>
  );
}

/**
 * The confirmation step.
 *
 * Every field is re-submitted as a hidden input, so the server revalidates the
 * whole correction rather than trusting a cached preview. The idempotency key
 * came from the server with the preview, so refreshing this page and
 * confirming again posts once.
 */
function AdjustmentSummary({
  preview,
  idempotencyKey,
}: {
  preview: NonNullable<AdjustmentState['preview']>;
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState<AdjustmentState, FormData>(
    confirmAdjustmentAction,
    INITIAL_ADJUSTMENT,
  );

  if (state.posted) {
    return (
      <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-5">
        <p className="text-sm font-semibold">
          سُجِّل التصحيح{' '}
          <span className="technical-term">{state.posted.reference}</span>
        </p>
        <p className="text-xs text-[var(--color-ink-soft)]">
          كُتب قيد جديد في الدفتر، ولم تُمسّ أي عملية بيع سابقة.
        </p>
        <Link
          href="/admin/adjustments"
          className="self-start rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-4 py-2 text-sm font-semibold transition-colors hover:border-[var(--color-accent)]"
        >
          تصحيح آخر
        </Link>
      </div>
    );
  }

  const sign = preview.direction === 'INCREASE' ? '+' : '−';

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border-2 border-[var(--color-accent)] bg-[var(--color-surface)] p-5"
    >
      <h3 className="text-sm font-bold">راجع التصحيح قبل اعتماده</h3>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
        <div className="flex flex-col">
          <dt className="text-xs text-[var(--color-ink-faint)]">الحساب</dt>
          <dd className="font-semibold">
            {TARGET_LABELS[preview.target] ?? preview.target}
            {preview.contributorName ? ` — ${preview.contributorName}` : ''}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-[var(--color-ink-faint)]">النوع</dt>
          <dd className="font-semibold">
            {DIRECTION_LABELS[preview.direction] ?? preview.direction}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-[var(--color-ink-faint)]">المبلغ</dt>
          <dd className="technical-term text-lg font-bold tabular-nums text-[var(--color-accent-ink)]">
            {sign}
            {formatMinor(preview.amountMinor, preview.currency)}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-[var(--color-ink-faint)]">السبب</dt>
          <dd>{ADJUSTMENT_REASON_LABELS[preview.reason] ?? preview.reason}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-[var(--color-ink-faint)]">الشهر المحاسبي</dt>
          <dd className="technical-term tabular-nums">{preview.periodKey}</dd>
        </div>
        {preview.balanceBeforeMinor !== null ? (
          <div className="flex flex-col">
            <dt className="text-xs text-[var(--color-ink-faint)]">الرصيد قبل ← بعد</dt>
            <dd className="technical-term tabular-nums">
              {formatMinor(preview.balanceBeforeMinor, preview.currency)}
              {' ← '}
              <span
                className={
                  (preview.balanceAfterMinor ?? 0n) < 0n
                    ? 'font-bold text-[var(--color-danger)]'
                    : 'font-bold'
                }
              >
                {formatMinor(preview.balanceAfterMinor ?? 0n, preview.currency)}
              </span>
            </dd>
          </div>
        ) : null}
      </dl>

      <blockquote className="rounded-[var(--radius-card)] border-r-2 border-[var(--color-line-strong)] bg-[var(--color-surface-muted)] px-4 py-3 text-sm">
        {preview.note}
      </blockquote>

      {preview.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {/* Re-submitted so the server revalidates rather than trusting a cache. */}
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="target" value={preview.target} />
      <input type="hidden" name="direction" value={preview.direction} />
      <input type="hidden" name="amount" value={minorToMajor(preview.amountMinor, preview.currency)} />
      <input type="hidden" name="currency" value={preview.currency} />
      {preview.contributorId ? (
        <input type="hidden" name="contributorId" value={preview.contributorId} />
      ) : null}
      <input type="hidden" name="reason" value={preview.reason} />
      <input type="hidden" name="note" value={preview.note} />

      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-line)] pt-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-sm font-bold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {pending ? 'جارٍ التسجيل…' : 'أؤكد تسجيل هذا التصحيح'}
        </button>
        <Link
          href="/admin/adjustments"
          className="text-sm text-[var(--color-ink-soft)] underline underline-offset-4"
        >
          تراجع
        </Link>
        <span className="text-xs text-[var(--color-ink-faint)]">
          يُكتب قيد جديد في الدفتر. لا تُعدَّل ولا تُحذف أي عملية سابقة.
        </span>
      </div>

      <ErrorNote message={state.error} />
    </form>
  );
}

/**
 * Minor units back to the major-unit string the form submits.
 *
 * Built from the bigint, never through a float: the server re-parses this and
 * a rounding error here would become a rounding error in the books. The digit
 * count comes from the currency table rather than a local assumption of two.
 */
function minorToMajor(amountMinor: bigint, currency: string): string {
  const digits = minorDigitsOf(currency as CurrencyCode);
  if (digits === 0) return amountMinor.toString();
  const scale = 10n ** BigInt(digits);
  return `${amountMinor / scale}.${(amountMinor % scale).toString().padStart(digits, '0')}`;
}
