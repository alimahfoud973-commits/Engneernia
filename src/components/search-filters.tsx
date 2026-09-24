import Link from 'next/link';
import type { FacetCount, SearchFilters } from '@/catalog/search';

/**
 * Filters are LINKS, not a client-side form.
 *
 * Every filter state is a URL, which means it can be bookmarked, shared and
 * indexed, works with the browser's back button, and needs no JavaScript to
 * function. The server already has to run the query; making the client
 * re-implement the same state machine would add weight and a second source of
 * truth for no gain.
 */

type ParamValue = string | readonly string[] | undefined;

function buildHref(current: SearchFilters, changes: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  const set = (key: string, value: ParamValue) => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (typeof value === 'string' && value.length > 0) {
      params.set(key, value);
    }
  };

  const merged: Record<string, ParamValue> = {
    q: current.q,
    discipline: current.discipline,
    category: current.category,
    type: current.fileTypes,
    level: current.levels,
    software: current.software,
    price: current.price,
    sort: current.sort,
    ...changes,
  };

  for (const [key, value] of Object.entries(merged)) set(key, value);
  const query = params.toString();
  return query ? `/search?${query}` : '/search';
}

/** Adds or removes one value from a multi-select facet. */
function toggled(list: readonly string[] | undefined, value: string): readonly string[] {
  const current = list ?? [];
  return current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
}

function FacetGroup({
  title,
  facets,
  paramKey,
  selected,
  filters,
  multi = true,
}: {
  title: string;
  facets: readonly FacetCount[];
  paramKey: string;
  selected: readonly string[];
  filters: SearchFilters;
  multi?: boolean;
}) {
  if (facets.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 border-b border-[var(--color-line)] pb-4 last:border-b-0">
      <h3 className="text-xs font-semibold text-[var(--color-ink-soft)]">{title}</h3>
      <ul className="flex flex-col gap-1">
        {facets.map((facet) => {
          const isOn = selected.includes(facet.value);
          const next = multi
            ? toggled(selected, facet.value)
            : isOn
              ? undefined
              : facet.value;

          return (
            <li key={facet.value}>
              <Link
                href={buildHref(filters, { [paramKey]: next, page: undefined })}
                aria-pressed={isOn}
                className={
                  'flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors ' +
                  (isOn
                    ? 'bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent-ink)]'
                    : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-muted)]')
                }
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={
                      'inline-block h-3 w-3 shrink-0 rounded-[2px] border ' +
                      (isOn
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]'
                        : 'border-[var(--color-line-strong)]')
                    }
                  />
                  {facet.label}
                </span>
                <span className="tabular-nums text-xs text-[var(--color-ink-faint)]">
                  {facet.count}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function SearchFiltersPanel({
  filters,
  facets,
  activeCount,
}: {
  filters: SearchFilters;
  facets: {
    disciplines: readonly FacetCount[];
    fileTypes: readonly FacetCount[];
    levels: readonly FacetCount[];
    software: readonly FacetCount[];
    price: readonly FacetCount[];
  };
  activeCount: number;
}) {
  return (
    <aside className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">تصفية النتائج</h2>
        {activeCount > 0 ? (
          <Link
            href={filters.q ? `/search?q=${encodeURIComponent(filters.q)}` : '/search'}
            className="text-xs text-[var(--color-accent-ink)] underline underline-offset-2"
          >
            مسح الكل ({activeCount})
          </Link>
        ) : null}
      </div>

      <FacetGroup
        title="التخصص"
        facets={facets.disciplines}
        paramKey="discipline"
        selected={filters.discipline ? [filters.discipline] : []}
        filters={filters}
        multi={false}
      />
      <FacetGroup
        title="نوع الملف"
        facets={facets.fileTypes}
        paramKey="type"
        selected={filters.fileTypes ?? []}
        filters={filters}
      />
      <FacetGroup
        title="المستوى"
        facets={facets.levels}
        paramKey="level"
        selected={filters.levels ?? []}
        filters={filters}
      />
      <FacetGroup
        title="السعر"
        facets={facets.price}
        paramKey="price"
        selected={filters.price ? [filters.price] : []}
        filters={filters}
        multi={false}
      />
      <FacetGroup
        title="البرنامج"
        facets={facets.software}
        paramKey="software"
        selected={filters.software ?? []}
        filters={filters}
      />
    </aside>
  );
}

export function SortControl({ filters }: { filters: SearchFilters }) {
  const options = [
    { value: 'relevance', label: 'الأكثر صلة' },
    { value: 'newest', label: 'الأحدث' },
    { value: 'bestselling', label: 'الأكثر مبيعاً' },
    { value: 'price_asc', label: 'الأقل سعراً' },
    { value: 'price_desc', label: 'الأعلى سعراً' },
  ] as const;

  const active = filters.sort ?? (filters.q ? 'relevance' : 'newest');

  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="ms-1 text-xs text-[var(--color-ink-faint)]">الترتيب:</span>
      {options.map((option) => (
        <Link
          key={option.value}
          href={buildHref(filters, { sort: option.value, page: undefined })}
          className={
            'rounded-sm px-2 py-1 text-xs transition-colors ' +
            (active === option.value
              ? 'bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent-ink)]'
              : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-muted)]')
          }
        >
          {option.label}
        </Link>
      ))}
    </div>
  );
}

/** How many filters narrow the results — the "N فلتر مُفعّل" count. */
export function activeFilterCount(filters: SearchFilters): number {
  return (
    (filters.discipline ? 1 : 0) +
    (filters.category ? 1 : 0) +
    (filters.fileTypes?.length ?? 0) +
    (filters.levels?.length ?? 0) +
    (filters.software?.length ?? 0) +
    (filters.price ? 1 : 0)
  );
}

export function Pagination({
  filters,
  page,
  totalPages,
}: {
  filters: SearchFilters;
  page: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;

  const pageHref = (target: number) => {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.discipline) params.set('discipline', filters.discipline);
    if (filters.category) params.set('category', filters.category);
    for (const type of filters.fileTypes ?? []) params.append('type', type);
    for (const level of filters.levels ?? []) params.append('level', level);
    for (const software of filters.software ?? []) params.append('software', software);
    if (filters.price) params.set('price', filters.price);
    if (filters.sort) params.set('sort', filters.sort);
    if (target > 1) params.set('page', String(target));
    const query = params.toString();
    return query ? `/search?${query}` : '/search';
  };

  return (
    <nav aria-label="تصفّح النتائج" className="flex flex-wrap items-center justify-center gap-1">
      {page > 1 ? (
        <Link href={pageHref(page - 1)} className="rounded-sm border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]">
          السابق
        </Link>
      ) : null}
      <span className="px-3 py-1.5 text-sm tabular-nums text-[var(--color-ink-soft)]">
        صفحة {page} من {totalPages}
      </span>
      {page < totalPages ? (
        <Link href={pageHref(page + 1)} className="rounded-sm border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]">
          التالي
        </Link>
      ) : null}
    </nav>
  );
}
