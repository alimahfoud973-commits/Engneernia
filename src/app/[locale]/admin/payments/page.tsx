import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { PaymentDecisionForms } from '@/components/commerce-forms';
import { formatPrice } from '@/components/product-card';
import { requireOwner } from '@/auth/current';
import { verificationQueue } from '@/commerce/queries';

export const dynamic = 'force-dynamic';

/**
 * The owner's verification queue (specification §24, §38).
 *
 * The daily operating loop: see what is waiting, look at the receipt, approve
 * or reject. Approving is the transition that freezes the financial snapshot
 * and opens the file — so the amount and the order reference sit next to the
 * receipt, where they can be compared before the button is pressed.
 */
export default async function AdminPaymentsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireOwner('/admin/payments');
  const queue = await verificationQueue(actor);

  const awaitingReview = queue.filter((row) => row.proof !== null);
  const awaitingPayment = queue.filter((row) => row.proof === null);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 py-10">
        <header className="flex flex-col gap-2">
          <p className="technical-term text-xs tracking-[0.14em] text-[var(--color-ink-faint)]">
            ADMIN
          </p>
          <h1 className="text-2xl font-bold">التحقق من المدفوعات</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            <span className="tabular-nums">{awaitingReview.length}</span> بانتظار المراجعة ·{' '}
            <span className="tabular-nums">{awaitingPayment.length}</span> بانتظار الدفع
          </p>
        </header>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            إيصالات بانتظار المراجعة
          </h2>

          {awaitingReview.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">
              لا توجد إيصالات بانتظار المراجعة.
            </p>
          ) : (
            <ul className="flex flex-col gap-4">
              {awaitingReview.map((row) => (
                <li
                  key={row.paymentId}
                  className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="technical-term text-sm font-bold">{row.orderNumber}</span>
                    <span className="technical-term text-lg font-bold text-[var(--color-accent-ink)]">
                      {formatPrice(String(row.amountMinor), row.currency, false)}
                    </span>
                  </div>

                  <ul className="flex flex-col gap-1 text-sm text-[var(--color-ink-soft)]">
                    {row.items.map((item, index) => (
                      <li key={index}>{item.title}</li>
                    ))}
                  </ul>

                  <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                    <div className="flex gap-1.5">
                      <dt className="text-[var(--color-ink-faint)]">الطريقة:</dt>
                      <dd>{row.methodName}</dd>
                    </div>
                    {row.proof?.referenceNote ? (
                      <div className="flex gap-1.5">
                        <dt className="text-[var(--color-ink-faint)]">رقم العملية:</dt>
                        <dd className="technical-term">{row.proof.referenceNote}</dd>
                      </div>
                    ) : null}
                  </dl>

                  {row.proof ? (
                    <a
                      href={`/api/proofs/${row.proof.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="w-fit rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-4 py-2 text-sm transition-colors hover:border-[var(--color-accent)]"
                    >
                      عرض الإيصال
                    </a>
                  ) : null}

                  <PaymentDecisionForms paymentId={row.paymentId} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {awaitingPayment.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
              طلبات بانتظار الدفع
            </h2>
            <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-line)]">
              <table className="w-full text-sm">
                <thead className="bg-[var(--color-surface-muted)] text-xs text-[var(--color-ink-faint)]">
                  <tr>
                    <th className="p-3 text-start font-medium">رقم الطلب</th>
                    <th className="p-3 text-start font-medium">الطريقة</th>
                    <th className="p-3 text-start font-medium">المبلغ</th>
                  </tr>
                </thead>
                <tbody>
                  {awaitingPayment.map((row) => (
                    <tr key={row.paymentId} className="border-t border-[var(--color-line)]">
                      <td className="technical-term p-3">{row.orderNumber}</td>
                      <td className="p-3">{row.methodName ?? '—'}</td>
                      <td className="technical-term p-3">
                        {formatPrice(String(row.amountMinor), row.currency, false)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}
