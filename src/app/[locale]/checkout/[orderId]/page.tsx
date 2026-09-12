import Link from 'next/link';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { PaymentMethodPicker, ProofUploadForm } from '@/components/commerce-forms';
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

  // Before anything else, and before the sign-in redirect: a path segment that
  // is not a uuid names no order, and must not be carried into a query (where
  // PostgreSQL would raise) nor into the `next` parameter of a login link.
  if (!isUuid(orderId)) notFound();

  const actor = await requireActor(`/checkout/${orderId}`);
  const view = await checkoutView(actor, orderId);
  // RLS already removed an order that is not this actor's, so "not found"
  // covers both absent and not-yours, indistinguishably.
  if (!view) notFound();

  const { order, items, payment, methods } = view;
  const isSettled = order.status === 'PAID' || order.status === 'COMPLETED';

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
            {STATUS_LABELS[order.status] ?? order.status}
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
            <h2 className="text-sm font-semibold text-[var(--color-ok)]">تم تأكيد الدفع</h2>
            <p className="text-sm">الملفات متاحة الآن في حسابك.</p>
            <Link
              href="/account"
              className="w-fit rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)]"
            >
              الذهاب إلى مشترياتي
            </Link>
          </section>
        ) : payment ? (
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
              <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-2.5 text-sm">
                اكتب رقم الطلب{' '}
                <span className="technical-term font-bold">{order.orderNumber}</span>{' '}
                في خانة البيان عند التحويل.
              </p>
            </div>

            {payment.requiresProof && order.status !== 'PROOF_SUBMITTED' ? (
              <ProofUploadForm orderId={order.id} paymentId={payment.id} />
            ) : order.status === 'PROOF_SUBMITTED' ? (
              <p className="rounded-[var(--radius-card)] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]">
                استلمنا الإيصال. تُراجَع الطلبات يدوياً، وسيُفعَّل الوصول فور تأكيد وصول المبلغ.
              </p>
            ) : null}
          </section>
        ) : (
          <section className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
            <PaymentMethodPicker orderId={order.id} methods={methods} />
          </section>
        )}

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
