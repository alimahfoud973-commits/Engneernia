import Link from 'next/link';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { ProductGrid } from '@/components/product-card';
import { disciplineBySlug } from '@/catalog/public-queries';
import type { Metadata } from 'next';
import { publicRobots } from '@/seo/config';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; discipline: string }>;
}): Promise<Metadata> {
  const { discipline: slug } = await params;
  const discipline = await disciplineBySlug(slug);
  if (!discipline) return { title: 'غير موجود', robots: { index: false, follow: false } };

  const description =
    discipline.descriptionAr ??
    `موارد ${discipline.nameAr} الهندسية: ${discipline.totalProducts} مورداً منشوراً.`;

  return {
    title: discipline.nameAr,
    description,
    robots: publicRobots(),
    alternates: { canonical: `/${discipline.slug}` },
    openGraph: { type: 'website', title: discipline.nameAr, description, url: `/${discipline.slug}` },
  };
}

/**
 * Discipline portal (specification §4): each behaves as its own entry point
 * over the shared catalogue, with its own category tree.
 */
export default async function DisciplinePage({
  params,
}: {
  params: Promise<{ locale: string; discipline: string }>;
}) {
  const { locale, discipline: slug } = await params;
  setRequestLocale(locale);

  const discipline = await disciplineBySlug(slug);
  if (!discipline) notFound();

  const populated = discipline.categories.filter((c) => c.productCount > 0);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-10">
        <header className="flex flex-col gap-3 border-b border-[var(--color-line)] pb-6">
          <p className="technical-term text-[11px] tracking-[0.16em] text-[var(--color-ink-faint)]">
            {discipline.nameEn}
          </p>
          <h1 className="text-3xl font-bold">{discipline.nameAr}</h1>
          {discipline.descriptionAr ? (
            <p className="max-w-prose text-base leading-relaxed text-[var(--color-ink-soft)]">
              {discipline.descriptionAr}
            </p>
          ) : null}
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            الأقسام ({discipline.categories.length})
          </h2>
          <ul className="flex flex-wrap gap-2">
            {discipline.categories.map((category) => (
              <li
                key={category.slug}
                className={
                  category.productCount > 0
                    ? 'rounded-[var(--radius-card)] border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-1.5 text-sm text-[var(--color-accent-ink)]'
                    : 'rounded-[var(--radius-card)] border border-[var(--color-line)] px-3 py-1.5 text-sm text-[var(--color-ink-faint)]'
                }
              >
                {category.nameAr}
                {category.productCount > 0 ? (
                  <span className="ms-1.5 tabular-nums text-xs">({category.productCount})</span>
                ) : null}
              </li>
            ))}
          </ul>
          {populated.length === 0 ? (
            <p className="text-xs text-[var(--color-ink-faint)]">
              الأقسام المميزة تحتوي موارد منشورة؛ البقية جاهزة لاستقبال المحتوى.
            </p>
          ) : null}
        </section>

        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
              الموارد المنشورة (<span className="tabular-nums">{discipline.totalProducts}</span>)
            </h2>
            {discipline.hasMore ? (
              <Link
                href={`/search?discipline=${discipline.slug}`}
                className="text-xs text-[var(--color-accent-ink)]"
              >
                عرض الكل مع الفلاتر
              </Link>
            ) : null}
          </div>

          <ProductGrid products={discipline.products} />

          {discipline.hasMore ? (
            <Link
              href={`/search?discipline=${discipline.slug}`}
              className="self-center rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-5 py-2.5 text-sm font-semibold transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent-ink)]"
            >
              تصفّح جميع موارد {discipline.nameAr}
            </Link>
          ) : null}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
