'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  approvePaymentAction, cancelOrderAction, choosePaymentMethodAction, completeFreeOrderAction,
  ownerCancelOrderAction, rejectPaymentAction, startPurchaseAction, type ActionState,
} from '@/commerce/actions';
import { formKey } from './form-key';
import { uploadFile } from './upload-file';

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
        className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'جارٍ التجهيز…' : label}
      </button>
      <ErrorNote message={state.error} />
    </form>
  );
}

/** Finishes a free order still in DRAFT — no payment method, no receipt. */
export function FreeOrderForm({ orderId }: { orderId: string }) {
  const [state, formAction, pending] = useActionState(completeFreeOrderAction, INITIAL);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      <p className="text-sm text-[var(--color-ink-soft)]">هذا الطلب مجاني ولا يحتاج إلى دفع.</p>
      <button
        type="submit"
        disabled={pending}
        className="w-fit rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'جارٍ الإتمام…' : 'الحصول عليه مجاناً'}
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
        لا تتوفر طريقة دفع لهذا الطلب حالياً.
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
                  ? 'تُفتح محادثة واتساب معنا لإتمام الدفع'
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
        className="self-start rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'جارٍ المتابعة…' : 'متابعة'}
      </button>
    </form>
  );
}

export function ProofUploadForm({ paymentId }: { paymentId: string }) {
  /*
   * Not a Server Action (S4-01): an action's body is capped at 1 MB before
   * any of our code runs, and a phone photo of a receipt is routinely more.
   * The file goes to a Route Handler that streams it against 10 MB.
   */
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<ActionState>(INITIAL);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = (form.elements.namedItem('proof') as HTMLInputElement | null)?.files?.[0];
    if (!file || file.size === 0) {
      setState({ error: 'يرجى اختيار صورة الإيصال' });
      return;
    }
    const note = (form.elements.namedItem('referenceNote') as HTMLInputElement | null)?.value.trim() ?? '';
    setPending(true);
    const answer = await uploadFile(
      `/api/payments/${paymentId}/proof`,
      file,
      note ? { 'x-reference-note': encodeURIComponent(note) } : {},
    );
    setPending(false);
    if (answer.error) {
      setState({ error: answer.error });
      return;
    }
    setState({ error: null, ok: true });
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">

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
        className="self-start rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-60"
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
      <form key={formKey(approveState)} action={approveAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="paymentId" value={paymentId} />
        <div className="flex min-w-[180px] flex-1 flex-col gap-1">
          <label htmlFor={`ref-${paymentId}`} className="text-xs text-[var(--color-ink-soft)]">
            رقم العملية البنكية
          </label>
          <input
            id={`ref-${paymentId}`}
            name="providerRef"
            type="text"
            defaultValue={approveState.values?.providerRef}
            className="rounded-sm border border-[var(--color-line)] bg-[var(--color-ground)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        <button
          type="submit"
          disabled={approving}
          className="rounded-[var(--radius-card)] bg-[var(--color-ok)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {approving ? 'جارٍ الاعتماد…' : 'اعتماد الدفع ومنح الوصول'}
        </button>
      </form>
      <ErrorNote message={approveState.error} />

      <form key={formKey(rejectState)} action={rejectAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="paymentId" value={paymentId} />
        <div className="flex min-w-[180px] flex-1 flex-col gap-1">
          <label htmlFor={`reason-${paymentId}`} className="text-xs text-[var(--color-ink-soft)]">
            سبب الرفض
          </label>
          <input
            id={`reason-${paymentId}`}
            name="reason"
            type="text"
            defaultValue={rejectState.values?.reason}
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

/**
 * The buyer cancels their own order while it still waits for payment
 * (Stage 7, D4). Behind a disclosure, so it takes two deliberate clicks.
 */
export function CancelOrderForm({ orderId }: { orderId: string }) {
  const [state, formAction, pending] = useActionState(cancelOrderAction, INITIAL);
  return (
    <details className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
      <summary className="cursor-pointer text-sm font-semibold text-[var(--color-ink-soft)]">
        إلغاء الطلب
      </summary>
      <form action={formAction} className="mt-3 flex flex-col gap-3">
        <input type="hidden" name="orderId" value={orderId} />
        <p className="text-sm text-[var(--color-ink-soft)]">
          يُلغى الطلب وتُغلق محاولة الدفع المفتوحة، ويمكنك شراء المنتج من جديد لاحقاً.
        </p>
        <ErrorNote message={state.error} />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-[var(--radius-card)] border border-[var(--color-danger)] px-4 py-2 text-sm font-semibold text-[var(--color-danger)] disabled:opacity-60"
        >
          {pending ? 'جارٍ الإلغاء…' : 'تأكيد إلغاء الطلب'}
        </button>
      </form>
    </details>
  );
}

/**
 * The owner cancels an order, with a reason the buyer is told (Stage 7,
 * D4–D6). Says plainly that nothing is refunded by the platform (D5).
 */
export function OwnerCancelOrderForm({ orderId }: { orderId: string }) {
  const [state, formAction, pending] = useActionState(ownerCancelOrderAction, INITIAL);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-[var(--color-danger)]">إلغاء الطلب</summary>
      <form key={formKey(state)} action={formAction} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="orderId" value={orderId} />
        <label htmlFor={`cancel-${orderId}`} className="text-xs text-[var(--color-ink-soft)]">
          سبب الإلغاء (يصل إلى المشتري)
        </label>
        <input
          id={`cancel-${orderId}`}
          name="reason"
          type="text"
          maxLength={400}
          required
          defaultValue={state.values?.reason}
          className="rounded-sm border border-[var(--color-line)] bg-[var(--color-ground)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-danger)]"
        />
        <p className="text-xs text-[var(--color-ink-faint)]">
          لا تُعيد المنصة أي مبلغ ولا تُسجّل قيداً مالياً؛ أي تسوية مع المشتري تتم خارجها.
        </p>
        <ErrorNote message={state.error} />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-[var(--radius-card)] border border-[var(--color-danger)] px-3 py-1.5 text-sm font-semibold text-[var(--color-danger)] disabled:opacity-60"
        >
          {pending ? 'جارٍ الإلغاء…' : 'تأكيد الإلغاء'}
        </button>
      </form>
    </details>
  );
}
