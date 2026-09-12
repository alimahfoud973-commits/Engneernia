'use client';

import { useActionState } from 'react';
import {
  approvePaymentAction, choosePaymentMethodAction, rejectPaymentAction,
  startPurchaseAction, submitProofAction, type ActionState,
} from '@/commerce/actions';

const INITIAL: ActionState = { error: null };

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

export function BuyButton({ slug, label }: { slug: string; label: string }) {
  const [state, formAction, pending] = useActionState(startPurchaseAction, INITIAL);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="slug" value={slug} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'جارٍ التجهيز…' : label}
      </button>
      <ErrorNote message={state.error} />
    </form>
  );
}

export function PaymentMethodPicker({
  orderId,
  methods,
}: {
  orderId: string;
  methods: ReadonlyArray<{ id: string; displayNameAr: string; type: string; requiresProof: boolean }>;
}) {
  const [state, formAction, pending] = useActionState(choosePaymentMethodAction, INITIAL);

  if (methods.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]">
        لا تتوفر طريقة دفع لهذا الطلب حالياً. تواصل معنا وسنساعدك.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">اختر طريقة الدفع</legend>
        {methods.map((method, index) => (
          <label
            key={method.id}
            className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 transition-colors hover:border-[var(--color-accent)] has-[:checked]:border-[var(--color-accent)] has-[:checked]:bg-[var(--color-accent-soft)]"
          >
            <input
              type="radio"
              name="paymentMethodId"
              value={method.id}
              defaultChecked={index === 0}
              required
              className="accent-[var(--color-accent)]"
            />
            <span className="flex flex-col">
              <span className="text-sm font-semibold">{method.displayNameAr}</span>
              <span className="text-xs text-[var(--color-ink-soft)]">
                {method.type === 'ASSISTED'
                  ? 'سنتواصل معك لإتمام الدفع'
                  : method.requiresProof
                    ? 'تحويل يدوي — يتطلب رفع إيصال'
                    : 'دفع مباشر'}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <ErrorNote message={state.error} />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'جارٍ المتابعة…' : 'متابعة'}
      </button>
    </form>
  );
}

export function ProofUploadForm({
  orderId,
  paymentId,
}: {
  orderId: string;
  paymentId: string;
}) {
  const [state, formAction, pending] = useActionState(submitProofAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="paymentId" value={paymentId} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="proof" className="text-sm font-medium">
          صورة الإيصال
        </label>
        <input
          id="proof"
          name="proof"
          type="file"
          accept="image/png,image/jpeg,image/webp,application/pdf"
          required
          className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm file:me-3 file:rounded-sm file:border-0 file:bg-[var(--color-surface-muted)] file:px-3 file:py-1.5 file:text-sm"
        />
        <p className="text-xs text-[var(--color-ink-faint)]">صورة أو ملف PDF، بحد أقصى 10 ميغابايت.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="referenceNote" className="text-sm font-medium">
          رقم عملية التحويل (اختياري)
        </label>
        <input
          id="referenceNote"
          name="referenceNote"
          type="text"
          maxLength={200}
          className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      <ErrorNote message={state.error} />
      {state.ok ? (
        <p className="rounded-[var(--radius-card)] border border-[var(--color-ok)] bg-[var(--color-ok-soft)] px-3 py-2 text-sm text-[var(--color-ok)]">
          تم استلام الإيصال. سيُراجَع الطلب وتصلك رسالة عند تفعيل الوصول.
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'جارٍ الرفع…' : 'إرسال الإيصال'}
      </button>
    </form>
  );
}

export function PaymentDecisionForms({ paymentId }: { paymentId: string }) {
  const [approveState, approveAction, approving] = useActionState(approvePaymentAction, INITIAL);
  const [rejectState, rejectAction, rejecting] = useActionState(rejectPaymentAction, INITIAL);

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-line)] pt-3">
      <form action={approveAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="paymentId" value={paymentId} />
        <div className="flex min-w-[180px] flex-1 flex-col gap-1">
          <label htmlFor={`ref-${paymentId}`} className="text-xs text-[var(--color-ink-soft)]">
            رقم العملية البنكية
          </label>
          <input
            id={`ref-${paymentId}`}
            name="providerRef"
            type="text"
            className="rounded-sm border border-[var(--color-line)] bg-[var(--color-ground)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        <button
          type="submit"
          disabled={approving}
          className="rounded-[var(--radius-card)] bg-[var(--color-ok)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {approving ? 'جارٍ الاعتماد…' : 'اعتماد الدفع ومنح الوصول'}
        </button>
      </form>
      <ErrorNote message={approveState.error} />

      <form action={rejectAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="paymentId" value={paymentId} />
        <div className="flex min-w-[180px] flex-1 flex-col gap-1">
          <label htmlFor={`reason-${paymentId}`} className="text-xs text-[var(--color-ink-soft)]">
            سبب الرفض
          </label>
          <input
            id={`reason-${paymentId}`}
            name="reason"
            type="text"
            className="rounded-sm border border-[var(--color-line)] bg-[var(--color-ground)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-danger)]"
          />
        </div>
        <button
          type="submit"
          disabled={rejecting}
          className="rounded-[var(--radius-card)] border border-[var(--color-danger)] px-4 py-2 text-sm font-semibold text-[var(--color-danger)] disabled:opacity-60"
        >
          {rejecting ? 'جارٍ الرفض…' : 'رفض'}
        </button>
      </form>
      <ErrorNote message={rejectState.error} />
    </div>
  );
}
