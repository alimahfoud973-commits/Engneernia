import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { ProductGrid } from '@/components/product-card';
import { freeProducts, latestProducts, listDisciplines } from '@/catalog/public-queries';

export const dynamic = 'force-dynamic';

/**
 * Homepage (specification §29, §45).
 * The four disciplines are the primary navigation, exactly as §4 requires.
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [disciplines, latest, free] = await Promise.all([
    listDisciplines(),
    latestProducts(8),
    freeProducts(4),
  ]);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-6xl flex-col gap-12 px-5 py-10">
        <section className="flex flex-col gap-4">
          <h1 className="max-w-3xl text-balance text-3xl font-bold leading-tight sm:text-4xl">
            المعرفة الهندسية والموارد الرقمية
          </h1>
          <p className="max-w-prose text-lg leading-relaxed text-[var(--color-ink-soft)]">
            كتب ومشاريع وجداول حسابات وملفات CAD و BIM، منتقاة ومراجَعة، في أربعة تخصصات هندسية.
          </p>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">التخصصات الهندسية</h2>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {disciplines.map((discipline) => (
              <li key={discipline.slug}>
                <Link
                  href={`/${discipline.slug}`}
                  className="flex h-full flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5 transition-colors hover:border-[var(--color-accent)]"
                >
                  <span className="text-lg font-semibold">{discipline.nameAr}</span>
                  <span className="technical-term text-[11px] text-[var(--color-ink-faint)]">
                    {discipline.nameEn}
                  </span>
                  {discipline.descriptionAr ? (
                    <span className="text-sm leading-relaxed text-[var(--color-ink-soft)]">
                      {discipline.descriptionAr}
                    </span>
                  ) : null}
                  <span className="mt-auto pt-2 text-xs tabular-nums text-[var(--color-accent-ink)]">
                    {discipline.productCount} مورد منشور
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">أحدث الموارد</h2>
          <ProductGrid products={latest} />
        </section>

        {free.length > 0 ? (
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">موارد مجانية</h2>
            <ProductGrid products={free} />
          </section>
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}
