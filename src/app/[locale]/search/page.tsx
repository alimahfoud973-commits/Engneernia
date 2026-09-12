import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { ProductGrid } from '@/components/product-card';
import { Pagination, SearchFiltersPanel, SortControl } from '@/components/search-filters';
import { searchCatalogue, type SearchFilters, type SortOption } from '@/catalog/search';

export const dynamic = 'force-dynamic';

const SORTS = new Set<SortOption>(['relevance', 'newest', 'bestselling', 'price_asc', 'price_desc']);

/** Search parameters arrive as strings or arrays; normalise once, here. */
function asList(value: string | string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value]).filter((v) => v.length > 0);
  return list.length > 0 ? list : undefined;
}

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const raw = await searchParams;

  const sortParam = typeof raw.sort === 'string' ? raw.sort : undefined;

  const filters: SearchFilters = {
    q: typeof raw.q === 'string' ? raw.q : undefined,
    discipline: typeof raw.discipline === 'string' ? raw.discipline : undefined,
    category: typeof raw.category === 'string' ? raw.category : undefined,
    fileTypes: asList(raw.type),
    levels: asList(raw.level),
    software: asList(raw.software),
    price: raw.price === 'free' || raw.price === 'paid' ? raw.price : undefined,
    sort: sortParam && SORTS.has(sortParam as SortOption) ? (sortParam as SortOption) : undefined,
    page: typeof raw.page === 'string' ? Number(raw.page) || 1 : 1,
  };

  const results = await searchCatalogue(filters);

  const activeCount =
    (filters.discipline ? 1 : 0) +
    (filters.fileTypes?.length ?? 0) +
    (filters.levels?.length ?? 0) +
    (filters.software?.length ?? 0) +
    (filters.price ? 1 : 0);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">
            {filters.q?.trim() ? `نتائج البحث عن: ${filters.q.trim()}` : 'تصفّح الموارد الهندسية'}
          </h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            <span className="tabular-nums">{results.total}</span> مورد
            {activeCount > 0 ? ` · ${activeCount} فلتر مُفعّل` : ''}
            <span className="technical-term ms-2 text-xs text-[var(--color-ink-faint)]">
              {results.tookMs}ms
            </span>
          </p>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <SearchFiltersPanel
            filters={filters}
            facets={results.facets}
            activeCount={activeCount}
          />

          <div className="flex min-w-0 flex-col gap-5">
            <SortControl filters={filters} />

            {results.items.length === 0 ? (
              <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-12 text-center">
                <p className="text-sm font-semibold">لا توجد نتائج مطابقة</p>
                <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
                  جرّب كلمات أعم، أو ألغِ بعض الفلاتر.
                </p>
              </div>
            ) : (
              <ProductGrid products={results.items} />
            )}

            <Pagination filters={filters} page={results.page} totalPages={results.totalPages} />
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
