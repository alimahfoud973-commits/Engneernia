import { describe, it, expect } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { Pagination, activeFilterCount } from './search-filters';
import type { SearchFilters } from '@/catalog/search';

/**
 * ===========================================================================
 * SEARCH PAGINATION AND THE ACTIVE-FILTER COUNT
 * ===========================================================================
 * Found in the Stage 2 audit by operating the site: a category page
 * (`/search?discipline=civil&category=soil-mechanics`) showed 250 results, and
 * its "next page" link — `/search?discipline=civil&page=2` — showed 1,252:
 * the whole discipline. `pageHref` rebuilt the query by hand and left the
 * category out. The sort links were right because they go through `buildHref`.
 *
 * `Pagination` is a server component with no hooks, so calling it returns the
 * element tree and the links' `href` props can be read without rendering.
 * ===========================================================================
 */

function hrefs(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(hrefs);
  const element = node as ReactElement<{ href?: unknown; children?: ReactNode }>;
  const own = typeof element.props?.href === 'string' ? [element.props.href] : [];
  return [...own, ...hrefs(element.props?.children)];
}

function links(filters: SearchFilters, page: number, totalPages: number): URL[] {
  return hrefs(Pagination({ filters, page, totalPages })).map(
    (href) => new URL(href, 'http://localhost'),
  );
}

describe('Pagination keeps the category (B1)', () => {
  const category: SearchFilters = { discipline: 'civil', category: 'soil-mechanics' };

  it('the next-page link keeps discipline and category and changes only the page', () => {
    const [next] = links(category, 1, 5);
    expect(next!.pathname).toBe('/search');
    expect(next!.searchParams.get('discipline')).toBe('civil');
    expect(next!.searchParams.get('category')).toBe('soil-mechanics');
    expect(next!.searchParams.get('page')).toBe('2');
    expect([...next!.searchParams.keys()].sort()).toEqual(['category', 'discipline', 'page']);
  });

  it('the previous-page link keeps the category too', () => {
    const [previous, next] = links(category, 3, 5);
    expect(previous!.searchParams.get('category')).toBe('soil-mechanics');
    expect(previous!.searchParams.get('page')).toBe('2');
    expect(next!.searchParams.get('category')).toBe('soil-mechanics');
    expect(next!.searchParams.get('page')).toBe('4');
  });

  it('going back to page 1 drops only the page number', () => {
    const [previous] = links(category, 2, 5);
    expect(previous!.searchParams.get('category')).toBe('soil-mechanics');
    expect(previous!.searchParams.get('discipline')).toBe('civil');
    expect(previous!.searchParams.has('page')).toBe(false);
  });

  it('keeps every other filter alongside the category', () => {
    const [next] = links(
      { ...category, q: 'تربة', fileTypes: ['PDF', 'EXCEL'], price: 'paid', sort: 'price_asc' },
      1,
      2,
    );
    expect(next!.searchParams.get('category')).toBe('soil-mechanics');
    expect(next!.searchParams.get('q')).toBe('تربة');
    expect(next!.searchParams.getAll('type')).toEqual(['PDF', 'EXCEL']);
    expect(next!.searchParams.get('price')).toBe('paid');
    expect(next!.searchParams.get('sort')).toBe('price_asc');
  });

  it('adds no category when none is selected (unchanged behaviour)', () => {
    const [next] = links({ discipline: 'civil' }, 1, 2);
    expect(next!.searchParams.has('category')).toBe(false);
  });
});

describe('activeFilterCount counts the category (B2)', () => {
  it('is zero with no filters', () => {
    expect(activeFilterCount({})).toBe(0);
  });

  it('counts a category on its own', () => {
    expect(activeFilterCount({ category: 'soil-mechanics' })).toBe(1);
  });

  it('counts discipline and category as two', () => {
    expect(activeFilterCount({ discipline: 'civil', category: 'soil-mechanics' })).toBe(2);
  });

  it('counts every filter, and not the query, sort or page', () => {
    expect(
      activeFilterCount({
        q: 'تربة',
        discipline: 'civil',
        category: 'soil-mechanics',
        fileTypes: ['PDF', 'EXCEL'],
        levels: ['ADVANCED'],
        software: ['ETABS'],
        price: 'paid',
        sort: 'price_asc',
        page: 3,
      }),
    ).toBe(7);
  });
});
