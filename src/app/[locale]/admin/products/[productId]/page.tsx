import Link from 'next/link';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../../admin-nav';
import {
  CreditsForm, PriceForm, ProductDetailsForm, StatusForm, UploadFileForm,
} from '@/components/product-admin-forms';
import { formatMinor } from '@/components/money-display';
import { requireOwner } from '@/auth/current';
import { adminProductDetail, catalogueOptions } from '@/catalog/admin-queries';
import { PRODUCT_STATUS_LABELS } from '@/lib/labels';
import { isUuid } from '@/lib/uuid';
import { NotFoundError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/**
 * One product, and every step it needs to become sellable (§26, §27, §30).
 *
 * The steps are on ONE page on purpose. They are not independent settings —
 * a product cannot be published until it has a file, an engineer and a price,
 * and an owner who has to hunt for the missing one across three screens is an
 * owner who ships a half-built product. The blockers are listed beside the
 * publish control for the same reason.
 */
export default async function AdminProductPage({
  params,
}: {
  params: Promise<{ locale: string; productId: string }>;
}) {
  const { locale, productId } = await params;
  setRequestLocale(locale);

  // A malformed id must be 404, not a 500 from the database.
  if (!isUuid(productId)) notFound();

  const actor = await requireOwner('/admin/products');

  let product;
  try {
    product = await adminProductDetail(actor, productId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const options = await catalogueOptions(actor);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-7 px-5 py-10">
        <AdminNav current="/admin/products" />

        <header className="flex flex-col gap-2">
          <Link href="/admin/products" className="text-xs text-[var(--color-ink-faint)] hover:underline">
            ← كل المنتجات
          </Link>
          <h1 className="text-2xl font-bold">{product.titleAr}</h1>
          <p className="flex flex-wrap items-baseline gap-3 text-sm text-[var(--color-ink-soft)]">
            <span className="rounded-sm bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs">
              {PRODUCT_STATUS_LABELS[product.status] ?? product.status}
            </span>
            <span>{product.disciplineNameAr}</span>
            <span dir="ltr" className="technical-term text-xs">{product.slug}</span>
            {product.status === 'PUBLISHED' ? (
              <Link href={`/products/${product.slug}`} className="text-xs text-[var(--color-accent-ink)] hover:underline">
                افتح الصفحة العامة ↗
              </Link>
            ) : null}
          </p>
        </header>

        {/* --- 1. the file ------------------------------------------------ */}
        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">١. ملف المنتج</h2>
          {product.files.length > 0 ? (
            <ul className="flex flex-wrap gap-2 text-xs">
              {product.files.map((f) => (
                <li key={f.role} className="rounded-sm border border-[var(--color-line)] px-2 py-1">
                  {f.role === 'ORIGINAL' ? 'الأصل' : f.role === 'PREVIEW' ? 'المعاينة' : f.role}
                  {' · '}{f.scanStatus}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--color-danger)]">لم يُرفع ملف بعد.</p>
          )}
          <UploadFileForm productId={product.id} declaredType={product.fileType} />
        </section>

        {/* --- 2. the engineers ------------------------------------------- */}
        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">٢. المهندسون والحصص</h2>
          <CreditsForm
            productId={product.id}
            contributors={options.contributors.map((c) => ({ id: c.id, displayName: c.displayName }))}
            current={product.credits.map((c) => ({ contributorId: c.contributorId, shareBp: c.shareBp }))}
          />
        </section>

        {/* --- 3. the price ----------------------------------------------- */}
        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            ٣. السعر
            {product.priceMinor !== null ? (
              <span className="mr-2 font-normal tabular-nums text-[var(--color-ink)]">
                — الحالي {formatMinor(product.priceMinor, product.currency)}
              </span>
            ) : null}
          </h2>
          <PriceForm productId={product.id} currency={product.currency} currentMinor={product.priceMinor} />
          {product.priceHistory.length > 1 ? (
            <details className="text-xs text-[var(--color-ink-faint)]">
              <summary className="cursor-pointer">تاريخ الأسعار ({product.priceHistory.length})</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {product.priceHistory.map((p, i) => (
                  <li key={i} className="tabular-nums">
                    {formatMinor(p.amountMinor, product.currency)}
                    {' — '}
                    {p.effectiveTo === null ? 'سارٍ الآن' : 'مُغلق'}
                    {p.reason ? ` · ${p.reason}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>

        {/* --- 4. the details --------------------------------------------- */}
        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">٤. الوصف والتفاصيل</h2>
          <ProductDetailsForm
            productId={product.id}
            titleAr={product.titleAr}
            subtitleAr={product.subtitleAr}
            descriptionAr={product.descriptionAr}
            level={product.level}
            softwareTags={product.softwareTags}
          />
        </section>

        {/* --- 5. publication --------------------------------------------- */}
        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">٥. النشر</h2>
          <StatusForm
            productId={product.id}
            nextStates={product.nextStates}
            blockers={product.blockers}
          />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
