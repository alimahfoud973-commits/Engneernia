'use client';

import { useActionState } from 'react';
import {
  approveRefundAction, markRefundPaidAction, rejectRefundAction,
  requestRefundAction, withdrawRefundAction, type ActionState,
} from '@/commerce/refund-actions';

const INITIAL: ActionState = { error: null };

/**
 * Refund forms.
 *
 * Client components, but they decide nothing. Every one posts to a server
 * action that re-authorises from the session and re-reads the policy — the
 * markup below can be edited in the browser and still cannot approve a refund.
 */

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

/** The owner's own words, shown to the customer so the list is readable. */
export const REFUND_REASON_LABELS: Readonly<Record<string, string>> = {
  DUPLICATE_PAYMENT: 'دفعة مكررة',
  CORRUPT_FILE: 'ملف تالف',
  NOT_AS_DESCRIBED: 'لا يطابق الوصف',
  PLATFORM_ERROR: 'خطأ تقني من المنصة',
  OWNER_DISCRETION: 'حالة أخرى',
};

export const REFUND_STATUS_LABELS: Readonly<Record<string, string>> = {
  REQUESTED: 'قيد المراجعة',
  APPROVED: 'معتمد — بانتظار التحويل',
  REJECTED: 'مرفوض',
  PAID: 'حُوِّل',
  WITHDRAWN: 'سُحب',
};

export function RequestRefundForm({
  orderId,
  orderNumber,
}: {
  orderId: string;
  orderNumber: string;
}) {
  const [state, formAction, pending] = useActionState(requestRefundAction, INITIAL);

  if (state.ok) {
    return (
      <p className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-sm">
        وصل طلبك وسيراجعه المالك. ستصلك النتيجة في إشعاراتك.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-semibold">سبب طلب الاسترجاع — الطلب {orderNumber}</span>
        <select
          name="reason"
          required
          defaultValue=""
          className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        >
          <option value="" disabled>
            اختر سبباً
          </option>
          {Object.entries(REFUND_REASON_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-semibold">اشرح ما حدث</span>
        <textarea
          name="customerNote"
          required
          minLength={10}
          maxLength={2000}
          rows={4}
          placeholder="مثال: الملف لا يفتح، أو المحتوى يختلف جوهرياً عن الوصف المنشور."
          className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
        <span className="text-xs text-[var(--color-ink-faint)]">
          الاسترجاع ليس تلقائياً؛ يراجع المالك كل طلب ويقرر فيه.
        </span>
      </label>

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-4 py-2 text-sm font-semibold transition-colors hover:border-[var(--color-accent)] disabled:opacity-60"
      >
        {pending ? 'جارٍ الإرسال…' : 'إرسال طلب الاسترجاع'}
      </button>

      <ErrorNote message={state.error} />
    </form>
  );
}

export function WithdrawRefundButton({ refundRequestId }: { refundRequestId: string }) {
  const [state, formAction, pending] = useActionState(withdrawRefundAction, INITIAL);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="refundRequestId" value={refundRequestId} />
      <button
        type="submit"
        disabled={pending}
        className="self-start text-xs font-semibold text-[var(--color-ink-soft)] underline underline-offset-4 disabled:opacity-60"
      >
        {pending ? 'جارٍ السحب…' : 'سحب الطلب'}
      </button>
      <ErrorNote message={state.error} />
    </form>
  );
}

/**
 * The owner's decision pair.
 *
 * Approving is irreversible in the books — it posts a reversing entry that
 * cannot be deleted — so the button says what it does rather than "OK".
 */
export function RefundDecisionForms({
  refundRequestId,
  amountLabel,
}: {
  refundRequestId: string;
  amountLabel: string;
}) {
  const [approveState, approveAction, approving] = useActionState(approveRefundAction, INITIAL);
  const [rejectState, rejectAction, rejecting] = useActionState(rejectRefundAction, INITIAL);

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-line)] pt-3">
      <form action={approveAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="refundRequestId" value={refundRequestId} />
        <input
          type="text"
          name="decisionNote"
          maxLength={2000}
          placeholder="ملاحظة (اختيارية)"
          className="min-w-[12rem] flex-1 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={approving || rejecting}
          className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {approving ? 'جارٍ الاعتماد…' : `اعتماد الاسترجاع ${amountLabel}`}
        </button>
      </form>
      <ErrorNote message={approveState.error} />

      <form action={rejectAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="refundRequestId" value={refundRequestId} />
        <input
          type="text"
          name="decisionNote"
          required
          minLength={3}
          maxLength={2000}
          placeholder="سبب الرفض — يُعرض للعميل"
          className="min-w-[12rem] flex-1 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={approving || rejecting}
          className="rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-4 py-2 text-sm font-semibold transition-colors hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-60"
        >
          {rejecting ? 'جارٍ الرفض…' : 'رفض'}
        </button>
      </form>
      <ErrorNote message={rejectState.error} />
    </div>
  );
}

/** Recorded after the transfer actually leaves, which is a separate act. */
export function MarkRefundPaidForm({ refundRequestId }: { refundRequestId: string }) {
  const [state, formAction, pending] = useActionState(markRefundPaidAction, INITIAL);
  return (
    <form
      action={formAction}
      className="flex flex-wrap items-center gap-2 border-t border-[var(--color-line)] pt-3"
    >
      <input type="hidden" name="refundRequestId" value={refundRequestId} />
      <input
        type="text"
        name="payoutReference"
        maxLength={200}
        placeholder="مرجع التحويل"
        className="min-w-[10rem] flex-1 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-4 py-2 text-sm font-semibold transition-colors hover:border-[var(--color-accent)] disabled:opacity-60"
      >
        {pending ? 'جارٍ التسجيل…' : 'تسجيل التحويل'}
      </button>
      <ErrorNote message={state.error} />
    </form>
  );
}
