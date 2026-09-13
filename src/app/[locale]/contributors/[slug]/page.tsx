import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { ProductGrid } from '@/components/product-card';
import { contributorBySlug } from '@/catalog/public-queries';
import type { Metadata } from 'next';
import { publicRobots } from '@/seo/config';

export const dynamic = 'force-dynamic';

/**
 * The profile's metadata carries the same facts the page shows and no others.
 * An engineer's earnings, commission and sales figures have no field on the
 * type this page receives, so there is nothing here to remember to leave out.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const contributor = await contributorBySlug(slug);
  if (!contributor) return { title: 'غير موجود', robots: { index: false, follow: false } };

  const description = [contributor.specialization, contributor.bio]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 180) || `أعمال ${contributor.displayName} المنشورة على المنصة.`;

  return {
    title: contributor.displayName,
    description,
    robots: publicRobots(),
    alternates: { canonical: `/contributors/${slug}` },
    openGraph: {
      type: 'profile',
      title: contributor.displayName,
      description,
      url: `/contributors/${slug}`,
    },
  };
}

/**
 * Public contributor profile (specification §31).
 *
 * Shows the intentionally public facts and the engineer's published work.
 * Their commission, earnings, sales figures and financial agreement have no
 * field on the type this page receives — they are absent, not hidden.
 */
export default async function ContributorPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const contributor = await contributorBySlug(slug);
  if (!contributor) notFound();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-10">
        <header className="flex flex-col gap-3 border-b border-[var(--color-line)] pb-6">
          <h1 className="text-3xl font-bold">{contributor.displayName}</h1>
          {contributor.specialization ? (
            <p className="text-base text-[var(--color-accent-ink)]">{contributor.specialization}</p>
          ) : null}
          {contributor.bio ? (
            <p className="max-w-prose text-base leading-loose text-[var(--color-ink-soft)]">
              {contributor.bio}
            </p>
          ) : null}
          <p className="text-sm tabular-nums text-[var(--color-ink-faint)]">
            {contributor.totalProducts} مورد منشور
          </p>
        </header>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">الموارد المنشورة</h2>
          <ProductGrid products={contributor.products} />
          {contributor.hasMore ? (
            <p className="text-center text-sm text-[var(--color-ink-soft)]">
              يُعرض {contributor.products.length} من {contributor.totalProducts} مورد.
            </p>
          ) : null}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
