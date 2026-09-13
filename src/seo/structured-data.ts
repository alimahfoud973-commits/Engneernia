import 'server-only';
import { minorDigitsOf } from '@/lib/money/currency';
import { absoluteUrl } from './config';

/**
 * ===========================================================================
 * STRUCTURED DATA
 * ===========================================================================
 * What a search engine is told about a page, in its own vocabulary, so a
 * result can carry a price and an author instead of a bare title.
 *
 * ONE RULE GOVERNS EVERYTHING HERE, and it is the platform owner's first rule
 * restated for a new audience: structured data is PUBLIC. It is read by
 * crawlers, scrapers and anyone who views source. So it may contain only what
 * the product page already shows a visitor — title, discipline, author NAME,
 * the selling price. It must never carry the commission rate, the engineer's
 * share, the platform's share, or a sales count. Those fields are not omitted
 * by choice here; they are not present on the DTO this module receives, which
 * is the stronger arrangement.
 * ===========================================================================
 */

export interface ProductForSearchEngines {
  readonly slug: string;
  readonly titleAr: string;
  readonly subtitleAr: string | null;
  readonly descriptionAr: string | null;
  readonly disciplineNameAr: string;
  readonly categoryNameAr: string | null;
  readonly isFree: boolean;
  readonly priceMinor: string | null;
  readonly currency: string | null;
  readonly authors: readonly { readonly displayName: string }[];
}

/**
 * Minor units as a decimal string, e.g. 2500 USD → "25.00".
 *
 * Built by string surgery on the integer rather than by dividing: a price is
 * money, and the moment it becomes a float it can come out as 24.999999999.
 */
function majorUnits(minor: string, currency: string): string {
  const digits = minorDigitsOf(currency);
  if (digits === 0) return minor;

  const negative = minor.startsWith('-');
  const value = (negative ? minor.slice(1) : minor).padStart(digits + 1, '0');
  const whole = value.slice(0, value.length - digits);
  const fraction = value.slice(value.length - digits);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** The first sentence or so of the description, for a search snippet. */
export function metaDescription(product: ProductForSearchEngines): string {
  const source = product.subtitleAr ?? product.descriptionAr ?? '';
  const cleaned = source.replace(/\s+/g, ' ').trim();
  const prefix = `${product.titleAr} — ${product.disciplineNameAr}`;
  if (cleaned.length === 0) return prefix;
  const body = cleaned.length > 150 ? `${cleaned.slice(0, 149).trimEnd()}…` : cleaned;
  return `${prefix}. ${body}`;
}

export function productJsonLd(product: ProductForSearchEngines): Record<string, unknown> {
  const url = absoluteUrl(`/products/${product.slug}`);

  /**
   * A free resource is still an Offer, priced at zero — not an absent offer.
   * Omitting it makes the result look like something that cannot be obtained.
   */
  const offer =
    product.isFree
      ? { price: '0', priceCurrency: product.currency ?? 'USD' }
      : product.priceMinor && product.currency
        ? {
            price: majorUnits(product.priceMinor, product.currency),
            priceCurrency: product.currency,
          }
        : null;

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.titleAr,
    description: metaDescription(product),
    url,
    category: [product.disciplineNameAr, product.categoryNameAr]
      .filter(Boolean)
      .join(' / '),
    ...(product.authors.length
      ? {
          author: product.authors.map((author) => ({
            '@type': 'Person',
            name: author.displayName,
          })),
        }
      : {}),
    ...(offer
      ? {
          offers: {
            '@type': 'Offer',
            ...offer,
            availability: 'https://schema.org/InStock',
            url,
          },
        }
      : {}),
  };
}
