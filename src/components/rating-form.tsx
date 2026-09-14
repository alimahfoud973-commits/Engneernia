'use client';

import { useActionState } from 'react';
import { rateProductAction, type RatingState } from '@/catalog/rating-actions';

const INITIAL: RatingState = { error: null, saved: false };
const SCORES = [1, 2, 3, 4, 5] as const;

/**
 * The buyer's own score, as five buttons.
 *
 * Only rendered for someone who already holds this product — and that is not
 * why they may rate: the entitlement is re-checked on the server and again in
 * the row policy, so hiding the form is a courtesy, not the control.
 */
export function RatingForm({ productId, current }: { productId: string; current: number | null }) {
  const [state, formAction, pending] = useActionState(rateProductAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="productId" value={productId} />
      <p className="text-sm font-medium">{current ? 'تقييمك' : 'قيّم هذا المورد'}</p>

      <div className="flex gap-1.5" role="group" aria-label="التقييم من واحد إلى خمسة">
        {SCORES.map((score) => (
          <button
            key={score}
            type="submit"
            name="score"
            value={score}
            disabled={pending}
            aria-pressed={current === score}
            className={`h-10 w-10 rounded-[var(--radius-card)] border text-sm font-semibold disabled:opacity-60 ${
              current !== null && score <= current
                ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-contrast)]'
                : 'border-[var(--color-line)] text-[var(--color-ink-soft)]'
            }`}
          >
            {score}
          </button>
        ))}
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">{state.error}</p>
      ) : null}
      {state.saved && !state.error ? (
        <p className="text-xs text-[var(--color-ok)]">حُفظ تقييمك.</p>
      ) : null}
      <p className="text-xs text-[var(--color-ink-faint)]">
        يظهر المتوسط وعدد التقييمات فقط — لا يُعرض اسمك ولا درجتك لأحد.
      </p>
    </form>
  );
}
