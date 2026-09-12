'use client';

import { useActionState } from 'react';
import {
  approveSettlementAction, cancelSettlementAction, generateSettlementsAction,
  markSettlementPaidAction, type ActionState,
} from '@/settlements/actions';

const INITIAL: ActionState = { error: null };

/**
 * Settlement forms.
 *
 * Nothing here decides anything. Each posts to an owner-only server action
 * that re-reads the ledger; the markup can be edited in the browser and still
 * cannot approve a payment or change an amount.
 */

function Note({ state }: { state: ActionState }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]"
      >
        {state.error}
      </p>
    );
  }
  if (state.ok && state.message) {
    return (
      <p className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm">
        {state.message}
      </p>
    );
  }
  return null;
}

export const SETTLEMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'بانتظار الاعتماد',
  APPROVED: 'معتمد — بانتظار التحويل',
  PAID: 'مصروف',
  CARRIED_FORWARD: 'مُرحَّل إلى الشهر التالي',
  CANCELLED: 'ملغى',
};

export function GenerateSettlementsForm({ defaultPeriod }: { defaultPeriod: string }) {
  const [state, formAction, pending] = useActionState(generateSettlementsAction, INITIAL);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold">الفترة المحاسبية</span>
          <input
            type="text"
            name="periodKey"
            defaultValue={defaultPeriod}
            pattern="\d{4}-(0[1-9]|1[0-2])"
            required
            className="technical-term w-36 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 tabular-nums"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {pending ? 'جارٍ التوليد…' : 'توليد كشوف الفترة'}
        </button>
      </div>
      <p className="text-xs text-[var(--color-ink-soft)]">
        لا تُسوّى فترة لم تُغلق بعد. الكشف يشمل رصيد الأشهر السابقة غير المصروف،
        ويخصم ما صُرف فعلاً — فتوليده مرتين لا يصرف مرتين.
      </p>
      <Note state={state} />
    </form>
  );
}

export function ApproveSettlementForm({ settlementId }: { settlementId: string }) {
  const [state, formAction, pending] = useActionState(approveSettlementAction, INITIAL);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="settlementId" value={settlementId} />
      <input
        type="text"
        name="note"
        maxLength={2000}
        placeholder="ملاحظة (اختيارية)"
        className="min-w-[10rem] flex-1 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'جارٍ الاعتماد…' : 'اعتماد'}
      </button>
      <Note state={state} />
    </form>
  );
}

export function PaySettlementForm({
  settlementId,
  amountLabel,
}: {
  settlementId: string;
  amountLabel: string;
}) {
  const [state, formAction, pending] = useActionState(markSettlementPaidAction, INITIAL);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="settlementId" value={settlementId} />
      <input
        type="text"
        name="payoutMethod"
        maxLength={120}
        placeholder="طريقة التحويل"
        className="min-w-[8rem] flex-1 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
      />
      <input
        type="text"
        name="payoutReference"
        maxLength={200}
        placeholder="مرجع التحويل"
        className="min-w-[8rem] flex-1 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'جارٍ التسجيل…' : `تسجيل صرف ${amountLabel}`}
      </button>
      <Note state={state} />
    </form>
  );
}

export function CancelSettlementForm({ settlementId }: { settlementId: string }) {
  const [state, formAction, pending] = useActionState(cancelSettlementAction, INITIAL);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="settlementId" value={settlementId} />
      <input
        type="text"
        name="reason"
        required
        minLength={3}
        maxLength={2000}
        placeholder="سبب الإلغاء"
        className="min-w-[10rem] flex-1 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-3 py-2 text-sm transition-colors hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-60"
      >
        {pending ? '…' : 'إلغاء الكشف'}
      </button>
      <Note state={state} />
    </form>
  );
}
