import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { formatPrice } from '@/components/product-card';
import { requireActor } from '@/auth/current';
import { myPurchases } from '@/commerce/queries';
import { myInvoices } from '@/finance/invoice-queries';
import { activeContributorId } from '@/authz/actor';
import { ORDER_STATUS_LABELS } from '@/lib/labels';
import { logoutAction } from '@/auth/actions';

export const dynamic = 'force-dynamic';

/** Customer account (specification §40). */
export default async function AccountPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireActor('/account');
  const { owned, orders } = await myPurchases(actor);
  const invoices = await myInvoices(actor);
  const isContributor = activeContributorId(actor) !== null;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 py-10">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-bold">حسابي</h1>
          <div className="flex items-center gap-3">
            {isContributor ? (
              <Link
                href="/account/earnings"
                className="rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-4 py-2 text-sm transition-colors hover:border-[var(--color-accent)]"
              >
                مستحقاتي
              </Link>
            ) : null}
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-4 py-2 text-sm transition-colors hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
            >
              تسجيل الخروج
            </button>
          </form>
          </div>
        </header>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            مشترياتي ({owned.length})
          </h2>
          {owned.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">
              لا توجد مشتريات بعد.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {owned.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
                >
                  <div className="flex flex-col gap-1">
                    <Link
                      href={`/products/${item.productSlug}`}
                      className="text-sm font-semibold hover:text-[var(--color-accent-ink)]"
                    >
                      {item.productTitle}
                    </Link>
                    <span className="text-xs text-[var(--color-ink-faint)]">
                      <span className="technical-term">{item.fileType}</span>
                      {item.downloadCount > 0 ? ` · نُزّل ${item.downloadCount} مرة` : ''}
                    </span>
                  </div>

                  {item.revokedAt ? (
                    <span className="text-sm text-[var(--color-danger)]">الوصول ملغى</span>
                  ) : (
                    <a
                      href={`/api/files/${item.productSlug}/original`}
                      className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90"
                    >
                      تنزيل الملف
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">طلباتي</h2>
          {orders.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-faint)]">لا توجد طلبات.</p>
          ) : (
            <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-line)]">
              <table className="w-full text-sm">
                <thead className="bg-[var(--color-surface-muted)] text-xs text-[var(--color-ink-faint)]">
                  <tr>
                    <th className="p-3 text-start font-medium">رقم الطلب</th>
                    <th className="p-3 text-start font-medium">الحالة</th>
                    <th className="p-3 text-start font-medium">المبلغ</th>
                    <th className="p-3 text-start font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id} className="border-t border-[var(--color-line)]">
                      <td className="technical-term p-3">{order.orderNumber}</td>
                      <td className="p-3">{ORDER_STATUS_LABELS[order.status] ?? order.status}</td>
                      <td className="technical-term p-3">
                        {formatPrice(String(order.totalMinor), order.currency, order.totalMinor === 0n)}
                      </td>
                      <td className="p-3">
                        <Link
                          href={`/checkout/${order.id}`}
                          className="text-[var(--color-accent-ink)] hover:underline"
                        >
                          عرض
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">فواتيري</h2>
          {invoices.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-faint)]">لا توجد فواتير بعد.</p>
          ) : (
            <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-line)]">
              <table className="w-full text-sm">
                <thead className="bg-[var(--color-surface-muted)] text-xs text-[var(--color-ink-faint)]">
                  <tr>
                    <th className="p-3 text-start font-medium">رقم الفاتورة</th>
                    <th className="p-3 text-start font-medium">التاريخ</th>
                    <th className="p-3 text-start font-medium">الإجمالي</th>
                    <th className="p-3 text-start font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.id} className="border-t border-[var(--color-line)]">
                      <td className="technical-term p-3">{invoice.invoiceNumber}</td>
                      <td className="technical-term p-3">
                        {invoice.issuedAt.toISOString().slice(0, 10)}
                      </td>
                      <td className="technical-term p-3">
                        {formatPrice(String(invoice.grossMinor), invoice.currency, false)}
                      </td>
                      <td className="p-3">
                        {/*
                          A plain link, not a fetch: the PDF is generated on
                          demand behind the same row-level policy that guards
                          the record, so the browser can simply ask for it.
                        */}
                        <a
                          href={`/api/invoices/${invoice.id}`}
                          className="text-[var(--color-accent-ink)] hover:underline"
                        >
                          تنزيل PDF
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </main>
      <SiteFooter />
    </>
  );
}
