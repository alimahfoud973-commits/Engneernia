import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../admin-nav';
import { CreateProductForm } from '@/components/product-admin-forms';
import { formatMinor } from '@/components/money-display';
import { requireOwner } from '@/auth/current';
import { adminProductList, catalogueOptions } from '@/catalog/admin-queries';
import { PRODUCT_STATUS_LABELS } from '@/lib/labels';

export const dynamic = 'force-dynamic';

/**
 * The owner's catalogue (§26, §27).
 *
 * OWNER-ONLY at every layer: `requireOwner` redirects, `adminProductList` and
 * `catalogueOptions` each refuse a non-owner, and the row policy on `products`
 * would hand a contributor only their own drafts — which is exactly why the
 * services refuse rather than narrow. A page that silently shows one person's
 * products under the heading "the catalogue" is worse than one that will not
 * open.
 */
export default async function AdminProductsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireOwner('/admin/products');
  const [rows, options] = await Promise.all([
    adminProductList(actor),
    catalogueOptions(actor),
  ]);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-10">
        <AdminNav current="/admin/products" />

        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">الكتالوج</h1>
          <p className="max-w-prose text-sm leading-relaxed text-[var(--color-ink-soft)]">
            المنتج يُنشأ مسودّة، ثم يحتاج <strong>ملفاً ومهندساً وسعراً</strong> قبل أن
            يُنشر. كل خطوة على صفحة المنتج نفسه.
          </p>
        </header>

        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">منتج جديد</h2>
          <CreateProductForm
            disciplines={options.disciplines}
            categories={options.categories}
            currency="USD"
          />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            المنتجات ({rows.length})
          </h2>
          {rows.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-faint)]">لا منتجات بعد.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-line)] rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)]">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3">
                  <Link href={`/admin/products/${row.id}`} className="flex flex-col gap-0.5">
                    <span className="text-sm font-semibold hover:underline">{row.titleAr}</span>
                    <span className="text-xs text-[var(--color-ink-faint)]">
                      {row.disciplineNameAr} · {PRODUCT_STATUS_LABELS[row.status] ?? row.status}
                    </span>
                  </Link>
                  <span className="flex flex-wrap items-baseline gap-3 text-xs tabular-nums">
                    <span>
                      {row.priceMinor === null
                        ? <span className="text-[var(--color-danger)]">بلا سعر</span>
                        : formatMinor(row.priceMinor, row.currency)}
                    </span>
                    <span className={row.contributorCount === 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-faint)]'}>
                      {row.contributorCount === 0 ? 'بلا مهندس' : `${row.contributorCount} مهندس`}
                    </span>
                    <span className={row.hasOriginal ? 'text-[var(--color-ink-faint)]' : 'text-[var(--color-danger)]'}>
                      {row.hasOriginal ? 'الملف موجود' : 'بلا ملف'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
