import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { ProductGrid } from '@/components/product-card';
import {
  bestSellers,
  featuredContributors,
  freeProducts,
  latestProducts,
  listDisciplines,
} from '@/catalog/public-queries';
import { getPublicSettings } from '@/platform/settings';

export const dynamic = 'force-dynamic';

/**
 * Homepage (specification §29, §45).
 *
 * The four disciplines lead, as §4 requires. Every rail below is omitted
 * entirely when it has nothing in it — an empty "best sellers" heading on a
 * new platform advertises that nothing has sold.
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [settings, disciplines, latest, best, free, contributors] = await Promise.all([
    getPublicSettings(),
    listDisciplines(),
    latestProducts(8),
    bestSellers(4),
    freeProducts(4),
    featuredContributors(6),
  ]);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-6xl flex-col gap-12 px-5 py-10">
        <section className="flex flex-col gap-4">
          <h1 className="max-w-3xl text-balance text-3xl font-bold leading-tight sm:text-4xl">
            {settings.tagline}
          </h1>
          <p className="max-w-prose text-lg leading-relaxed text-[var(--color-ink-soft)]">
            كتب ومشاريع وجداول حسابات وملفات CAD و BIM، منتقاة ومراجَعة، في أربعة تخصصات هندسية.
          </p>
          <form action="/search" className="flex max-w-xl gap-2">
            <label htmlFor="hero-search" className="sr-only">
              ابحث في الموارد الهندسية
            </label>
            <input
              id="hero-search"
              name="q"
              type="search"
              placeholder="ابحث بعنوان المورد أو موضوعه"
              className="w-full rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5 outline-none transition-colors focus:border-[var(--color-accent)]"
            />
            <button
              type="submit"
              className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90"
            >
              بحث
            </button>
          </form>
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

        {best.length > 0 ? (
          <section className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">الأكثر مبيعاً</h2>
              <Link href="/search?sort=bestselling" className="text-xs text-[var(--color-accent-ink)]">
                عرض الكل
              </Link>
            </div>
            <ProductGrid products={best} />
          </section>
        ) : null}

        <section className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">أحدث الموارد</h2>
            <Link href="/search?sort=newest" className="text-xs text-[var(--color-accent-ink)]">
              عرض الكل
            </Link>
          </div>
          <ProductGrid products={latest} />
        </section>

        {free.length > 0 ? (
          <section className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">موارد مجانية</h2>
              <Link href="/search?price=free" className="text-xs text-[var(--color-accent-ink)]">
                عرض الكل
              </Link>
            </div>
            <ProductGrid products={free} />
          </section>
        ) : null}

        {contributors.length > 0 ? (
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
              المهندسون المساهمون
            </h2>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {contributors.map((contributor) => (
                <li key={contributor.slug}>
                  <Link
                    href={`/contributors/${contributor.slug}`}
                    className="flex h-full flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-accent)]"
                  >
                    <span className="font-semibold">{contributor.displayName}</span>
                    {contributor.specialization ? (
                      <span className="text-sm text-[var(--color-ink-soft)]">
                        {contributor.specialization}
                      </span>
                    ) : null}
                    <span className="mt-1 text-xs tabular-nums text-[var(--color-accent-ink)]">
                      {contributor.productCount} مورد منشور
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}
