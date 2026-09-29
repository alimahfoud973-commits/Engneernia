import { cache } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import {
  CancelOrderForm, FreeOrderForm, PaymentMethodPicker, ProofUploadForm,
} from '@/components/commerce-forms';
import { formatPrice } from '@/components/product-card';
import { requireActor } from '@/auth/current';
import { checkoutView } from '@/commerce/queries';
import { isUuid } from '@/lib/uuid';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'بانتظار اختيار طريقة الدفع',
  AWAITING_PAYMENT: 'بانتظار الدفع',
  PROOF_SUBMITTED: 'قيد التحقق من الدفع',
  PENDING_VERIFICATION: 'قيد التحقق من الدفع',
  PAID: 'تم الدفع',
  COMPLETED: 'مكتمل — الملفات متاحة',
  PAYMENT_ISSUE: 'مشكلة في الدفع',
  CANCELLED: 'ملغى',
  REFUNDED: 'مُسترجع',
};

/**
 * The order this request is for, or not-found — shared by the page and its
 * metadata (D4).
 *
 * The browser takes a 404's tab title from `generateMetadata`, so metadata has
 * to know when the order does not resolve; otherwise the tab of a missing
 * order read as the home page. The steps and their order are the page's own,
 * moved here unchanged. `cache()` runs them once per request, so the page and
 * its metadata share one sign-in check and one query.
 */
const resolveOrder = cache(async (orderId: string) => {
  // Before anything else, and before the sign-in redirect: a path segment that
  // is not a uuid names no order, and must not be carried into a query (where
  // PostgreSQL would raise) nor into the `next` parameter of a login link.
  if (!isUuid(orderId)) notFound();

  const actor = await requireActor(`/checkout/${orderId}`);
  const view = await checkoutView(actor, orderId);
  // RLS already removed an order that is not this actor's, so "not found"
  // covers both absent and not-yours, indistinguishably.
  if (!view) notFound();
  return view;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  await resolveOrder((await params).orderId);
  return {};
}

/**
 * The order screen (specification §24, §40).
 *
 * Written to carry a customer through a MANUAL payment without needing to
 * ask anyone anything — at launch most revenue arrives this way, which makes
 * this the highest-leverage screen on the platform.
 */
export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ locale: string; orderId: string }>;
}) {
  const { locale, orderId } = await params;
  setRequestLocale(locale);

  const view = await resolveOrder(orderId);

  const { order, items, payment, lastRejection, canChangeMethod, canCancel, methods, whatsappHelp } = view;
  const isSettled = order.status === 'PAID' || order.status === 'COMPLETED';
  const isCancelled = order.status === 'CANCELLED';
  // Where a method is still chosen (Stage 7): nothing open, the order waiting.
  const waitsForPayment = ['DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_ISSUE'].includes(order.status);
  // A free order is taken, not paid for: no method to choose, nothing to confirm.
  const isFree = order.totalMinor === 0n;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-5 py-10">
        <header className="flex flex-col gap-2">
          <p className="technical-term text-xs tracking-[0.14em] text-[var(--color-ink-faint)]">
            {order.orderNumber}
          </p>
          <h1 className="text-2xl font-bold">إتمام الطلب</h1>
          <p
            className={
              'w-fit rounded-[var(--radius-card)] px-3 py-1 text-sm font-semibold ' +
              (isSettled
                ? 'bg-[var(--color-ok-soft)] text-[var(--color-ok)]'
                : order.status === 'PAYMENT_ISSUE'
                  ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
                  : 'bg-[var(--color-warn-soft)] text-[var(--color-warn)]')
            }
          >
            {isFree && order.status === 'DRAFT'
              ? 'بانتظار الإتمام'
              : (STATUS_LABELS[order.status] ?? order.status)}
          </p>
        </header>

        <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">محتويات الطلب</h2>
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id} className="flex items-baseline justify-between gap-3">
                <span className="text-sm">{item.title}</span>
                <span className="technical-term text-sm font-semibold">
                  {formatPrice(String(item.priceMinor), order.currency, item.priceMinor === 0n)}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-baseline justify-between gap-3 border-t border-[var(--color-line)] pt-3">
            <span className="text-sm font-semibold">الإجمالي</span>
            <span className="technical-term text-lg font-bold text-[var(--color-accent-ink)]">
              {formatPrice(String(order.totalMinor), order.currency, order.totalMinor === 0n)}
            </span>
          </div>
        </section>

        {isSettled ? (
          <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-ok)] bg-[var(--color-ok-soft)] p-5">
            <h2 className="text-sm font-semibold text-[var(--color-ok)]">
              {isFree ? 'أُضيف إلى مشترياتك' : 'تم تأكيد الدفع'}
            </h2>
            <p className="text-sm">الملفات متاحة الآن في حسابك.</p>
            <Link
              href="/account"
              className="w-fit rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)]"
            >
              الذهاب إلى مشترياتي
            </Link>
          </section>
        ) : isCancelled ? (
          // Stage 7 (K3-A): a cancelled order offers nothing more to do here;
          // the product can be ordered again from its page.
          <section className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
            <p className="text-sm">أُلغي هذا الطلب. يمكنك شراء المنتج من جديد من صفحته.</p>
          </section>
        ) : payment ? (
          <>
            <section className="flex flex-col gap-5 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
                  تعليمات الدفع — {payment.methodName}
                </h2>
                {payment.instructionsAr ? (
                  <p className="whitespace-pre-line text-sm leading-loose">{payment.instructionsAr}</p>
                ) : null}
                {payment.accountDetailsAr ? (
                  <div className="rounded-[var(--radius-card)] bg-[var(--color-surface-muted)] px-4 py-3">
                    <p className="mb-1 text-xs text-[var(--color-ink-faint)]">بيانات الحساب</p>
                    <p className="technical-term text-sm font-semibold">{payment.accountDetailsAr}</p>
                  </div>
                ) : null}
                {/* A transfer to annotate exists only where there is an account to
                    pay into or a receipt to send — not for WhatsApp assistance (W2). */}
                {payment.accountDetailsAr || payment.requiresProof ? (
                  <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-2.5 text-sm">
                    اكتب رقم الطلب{' '}
                    <span className="technical-term font-bold">{order.orderNumber}</span>{' '}
                    في خانة البيان عند التحويل.
                  </p>
                ) : null}
              </div>

              {payment.status === 'AWAITING_PROOF' ? (
                <ProofUploadForm paymentId={payment.id} />
              ) : payment.status === 'PROOF_SUBMITTED' ? (
                <p className="rounded-[var(--radius-card)] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]">
                  استلمنا الإيصال. تُراجَع الطلبات يدوياً، وسيُفعَّل الوصول فور تأكيد وصول المبلغ.
                </p>
              ) : payment.status === 'INITIATED' ? (
                // WhatsApp assistance (K2): a conversation, not a payment — the
                // buyer may still pay by any method below.
                <p className="text-sm text-[var(--color-ink-soft)]">
                  يمكنك متابعة المحادثة معنا عبر واتساب، أو اختيار طريقة دفع أخرى أدناه.
                </p>
              ) : null}
            </section>

            {canChangeMethod ? (
              payment.status === 'INITIATED' ? (
                <section className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
                  <PaymentMethodPicker orderId={order.id} methods={methods} />
                </section>
              ) : (
                // Before a receipt only (D2): choosing another method closes
                // this attempt and opens a new one.
                <details className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
                  <summary className="cursor-pointer text-sm font-semibold text-[var(--color-ink-soft)]">
                    تغيير طريقة الدفع
                  </summary>
                  <div className="mt-4">
                    <PaymentMethodPicker orderId={order.id} methods={methods} />
                  </div>
                </details>
              )
            ) : null}
          </>
        ) : (
          <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
            {isFree && order.status === 'DRAFT' ? (
              <FreeOrderForm orderId={order.id} />
            ) : waitsForPayment ? (
              <>
                {/* K1: the rejected attempt is history; the buyer tries again
                    with any method, and is told why the last one failed. */}
                {lastRejection ? (
                  <div className="rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]">
                    <p className="font-semibold">لم يُعتمد الدفع السابق.</p>
                    {lastRejection.reason ? <p>السبب: {lastRejection.reason}</p> : null}
                    <p>يمكنك المحاولة مرة أخرى بالطريقة نفسها أو بطريقة أخرى.</p>
                  </div>
                ) : null}
                <PaymentMethodPicker orderId={order.id} methods={methods} />
              </>
            ) : (
              <p className="text-sm text-[var(--color-ink-soft)]">الطلب قيد المراجعة.</p>
            )}
          </section>
        )}

        {canCancel ? <CancelOrderForm orderId={order.id} /> : null}

        {/* §23: the permanent fallback, wherever the order still waits for
            payment and the owner has set a WhatsApp number (W2). */}
        {!isSettled && !isCancelled && !isFree && whatsappHelp ? (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
            <p className="text-sm font-semibold">تواجه صعوبة في الدفع؟</p>
            <a
              href={whatsappHelp}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)]"
            >
              تواصل معنا عبر واتساب
            </a>
          </section>
        ) : null}

        {order.adminNote ? (
          <p className="rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]">
            {order.adminNote}
          </p>
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}
