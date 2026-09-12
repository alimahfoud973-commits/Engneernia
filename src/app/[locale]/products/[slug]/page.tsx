import Link from 'next/link';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { FILE_TYPE_LABELS, LEVEL_LABELS, formatPrice } from '@/components/product-card';
import { BuyButton } from '@/components/commerce-forms';
import { productBySlug } from '@/catalog/public-queries';

export const dynamic = 'force-dynamic';

/**
 * Public product page (specification §28).
 *
 * Shows: title, discipline, category, author name, description, file type,
 * language, level, software and the current price.
 *
 * Does NOT show — and structurally CANNOT show — commission, engineer share,
 * platform share, or sales accounting. Those fields do not exist on the DTO
 * this page receives.
 */
export default async function ProductPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const product = await productBySlug(slug);
  if (!product) notFound();

  const facts: ReadonlyArray<readonly [string, string]> = [
    ['التخصص', product.disciplineNameAr],
    ...(product.categoryNameAr ? ([['القسم', product.categoryNameAr]] as const) : []),
    ['نوع الملف', FILE_TYPE_LABELS[product.fileType] ?? product.fileType],
    ...(product.level ? ([['المستوى', LEVEL_LABELS[product.level] ?? product.level]] as const) : []),
    ['اللغة', product.language === 'ar' ? 'العربية' : product.language],
  ];

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-10">
        <nav aria-label="مسار التصفح" className="text-sm text-[var(--color-ink-faint)]">
          <Link href="/" className="hover:text-[var(--color-ink)]">
            الرئيسية
          </Link>
          <span className="mx-2">/</span>
          <Link href={`/${product.disciplineSlug}`} className="hover:text-[var(--color-ink)]">
            {product.disciplineNameAr}
          </Link>
        </nav>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <article className="flex flex-col gap-6">
            <header className="flex flex-col gap-3">
              <h1 className="text-balance text-3xl font-bold leading-tight">{product.titleAr}</h1>
              {product.subtitleAr ? (
                <p className="text-lg leading-relaxed text-[var(--color-ink-soft)]">
                  {product.subtitleAr}
                </p>
              ) : null}
            </header>

            {product.descriptionAr ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">الوصف</h2>
                <p className="max-w-prose text-base leading-loose">{product.descriptionAr}</p>
              </section>
            ) : null}

            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">المعاينة</h2>

              {product.hasPreview ? (
                <>
                  <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface-muted)]">
                    {/*
                      The preview served here is a generated document holding
                      only the first pages, as raster images with the watermark
                      burned in. The original is not in this file, so nothing
                      about this viewer is protecting it.
                    */}
                    <iframe
                      src={`/api/files/${product.slug}/preview`}
                      title={`معاينة ${product.titleAr}`}
                      className="h-[560px] w-full border-0 bg-white"
                      loading="lazy"
                    />
                  </div>
                  <p className="text-xs text-[var(--color-ink-faint)]">
                    {product.previewPageCount && product.totalPageCount
                      ? `تعرض المعاينة ${product.previewPageCount} صفحات من أصل ${product.totalPageCount}.`
                      : 'تعرض المعاينة الصفحات الأولى فقط.'}{' '}
                    يُتاح الملف الكامل بعد إتمام الشراء والتحقق منه.
                  </p>
                </>
              ) : (
                <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-8 text-center">
                  <p className="text-sm text-[var(--color-ink-soft)]">
                    لا تتوفر معاينة لهذه الصيغة
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
                    المعاينة متاحة لملفات PDF فقط. تفاصيل المحتوى موضّحة في الوصف أعلاه.
                  </p>
                </div>
              )}

              <p className="text-xs text-[var(--color-ink-faint)]">
                الملف الأصلي محفوظ في تخزين خاص ولا يملك رابطاً عاماً.
              </p>
            </section>

            {product.softwareTags.length > 0 ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
                  البرامج والتقنيات
                </h2>
                <ul className="flex flex-wrap gap-2">
                  {product.softwareTags.map((tag) => (
                    <li
                      key={tag}
                      className="technical-term rounded-sm border border-[var(--color-line)] px-2 py-1 text-xs text-[var(--color-ink-soft)]"
                    >
                      {tag}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </article>

          <aside className="flex h-fit flex-col gap-5 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-[var(--color-ink-faint)]">السعر</span>
              <span
                className={
                  product.isFree
                    ? 'text-2xl font-bold text-[var(--color-ok)]'
                    : 'text-2xl font-bold tabular-nums text-[var(--color-accent-ink)]'
                }
              >
                {formatPrice(product.priceMinor, product.currency, product.isFree)}
              </span>
            </div>

            <BuyButton
              slug={product.slug}
              label={product.isFree ? 'الحصول عليه مجاناً' : 'شراء الآن'}
            />

            <dl className="flex flex-col gap-3 border-t border-[var(--color-line)] pt-4">
              {facts.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-[var(--color-ink-faint)]">{label}</dt>
                  <dd className="text-sm font-medium">{value}</dd>
                </div>
              ))}
            </dl>

            {product.authors.length > 0 ? (
              <div className="flex flex-col gap-2 border-t border-[var(--color-line)] pt-4">
                <span className="text-xs text-[var(--color-ink-faint)]">إعداد</span>
                {product.authors.map((author) => (
                  <Link
                    key={author.contributorSlug}
                    href={`/contributors/${author.contributorSlug}`}
                    className="flex flex-col rounded-sm px-1 py-0.5 transition-colors hover:bg-[var(--color-surface-muted)]"
                  >
                    <span className="text-sm font-semibold">{author.displayName}</span>
                    {author.specialization ? (
                      <span className="text-xs text-[var(--color-ink-soft)]">
                        {author.specialization}
                      </span>
                    ) : null}
                  </Link>
                ))}
              </div>
            ) : null}
          </aside>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
