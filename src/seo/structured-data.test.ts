import { describe, expect, it, beforeAll } from 'vitest';
import { metaDescription, productJsonLd, type ProductForSearchEngines } from './structured-data';

/**
 * ===========================================================================
 * STRUCTURED DATA IS PUBLIC, AND THESE TESTS TREAT IT THAT WAY
 * ===========================================================================
 * Whatever ends up in a ld+json block is read by crawlers, scrapers and anyone
 * who views source. The platform owner's first rule applies to it in full, so
 * the central test here is not that the right fields are present — it is that
 * no financial field can ever appear, checked against the SERIALISED output
 * rather than the object, because a nested value is just as public as a
 * top-level one.
 * ===========================================================================
 */

beforeAll(() => {
  process.env.APP_URL ??= 'https://example.test';
  process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
  process.env.SESSION_SECRET ??= 'x'.repeat(48);
  process.env.CONFIG_ENCRYPTION_KEY ??= 'y'.repeat(48);
  process.env.STORAGE_ENDPOINT ??= 'file:///tmp/storage';
  process.env.STORAGE_REGION ??= 'us-east-1';
  process.env.STORAGE_ACCESS_KEY_ID ??= 'a';
  process.env.STORAGE_SECRET_ACCESS_KEY ??= 'b';
  process.env.STORAGE_BUCKET_ORIGINALS ??= 'originals';
  process.env.STORAGE_BUCKET_DERIVATIVES ??= 'derivatives';
  process.env.MAIL_TRANSPORT_URL ??= 'log://test';
  process.env.MAIL_FROM ??= 'Enginora <no-reply@example.test>';
});

const paid: ProductForSearchEngines = {
  slug: 'steel-connection-design',
  titleAr: 'تصميم الوصلات المعدنية',
  subtitleAr: 'دليل عملي وفق الكود الأمريكي',
  descriptionAr: 'شرح مفصل لطرق التصميم.',
  disciplineNameAr: 'الهندسة المدنية',
  categoryNameAr: 'المنشآت المعدنية',
  isFree: false,
  priceMinor: '2500',
  currency: 'USD',
  authors: [{ displayName: 'م. أحمد' }],
};

describe('productJsonLd', () => {
  it('converts minor units to a decimal price without touching a float', () => {
    const json = productJsonLd(paid) as { offers: { price: string } };
    expect(json.offers.price).toBe('25.00');
  });

  it.each([
    ['1', '0.01'],
    ['99', '0.99'],
    ['100', '1.00'],
    ['123456789', '1234567.89'],
    // 20.15 is not representable in binary floating point; dividing by 100
    // gives 20.150000000000002. String surgery cannot.
    ['2015', '20.15'],
  ])('renders %s minor units as %s', (minor, expected) => {
    const json = productJsonLd({ ...paid, priceMinor: minor }) as { offers: { price: string } };
    expect(json.offers.price).toBe(expected);
  });

  it('prices a free resource at zero rather than omitting the offer', () => {
    const json = productJsonLd({ ...paid, isFree: true, priceMinor: null }) as {
      offers?: { price: string };
    };
    expect(json.offers?.price).toBe('0');
  });

  it('omits the offer entirely when there is no price at all', () => {
    const json = productJsonLd({ ...paid, isFree: false, priceMinor: null, currency: null });
    expect(json).not.toHaveProperty('offers');
  });

  it('names the authors', () => {
    const json = productJsonLd(paid) as { author: Array<{ name: string }> };
    expect(json.author.map((a) => a.name)).toEqual(['م. أحمد']);
  });

  it('uses an absolute URL, since a crawler has no page to resolve against', () => {
    const json = productJsonLd(paid) as { url: string };
    expect(json.url).toMatch(/^https?:\/\/.+\/products\/steel-connection-design$/);
  });

  /**
   * THE ONE THAT MATTERS. Written against the serialised string so that a
   * field buried three levels deep is caught exactly like a top-level one.
   */
  it('cannot carry a single financial field', () => {
    const serialised = JSON.stringify(
      productJsonLd({ ...paid, authors: [{ displayName: 'م. أحمد' }] }),
    ).toLowerCase();

    for (const forbidden of [
      'commission',
      'engineershare',
      'platformshare',
      'payout',
      'settlement',
      'salescount',
      'netminor',
      'grossminor',
      'basispoints',
      'عمولة',
      'صافي',
      'المستحق',
    ]) {
      expect(serialised).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('metaDescription', () => {
  it('leads with the title and discipline, then the subtitle', () => {
    expect(metaDescription(paid)).toBe(
      'تصميم الوصلات المعدنية — الهندسة المدنية. دليل عملي وفق الكود الأمريكي',
    );
  });

  it('falls back to the description when there is no subtitle', () => {
    expect(metaDescription({ ...paid, subtitleAr: null })).toContain('شرح مفصل');
  });

  it('still says something useful when there is neither', () => {
    expect(metaDescription({ ...paid, subtitleAr: null, descriptionAr: null })).toBe(
      'تصميم الوصلات المعدنية — الهندسة المدنية',
    );
  });

  it('collapses whitespace so a multi-line description does not break the tag', () => {
    const result = metaDescription({ ...paid, subtitleAr: 'سطر\n\nآخر\tهنا' });
    expect(result).toContain('سطر آخر هنا');
    expect(result).not.toMatch(/[\n\t]/);
  });

  it('truncates a long description rather than emitting a wall of text', () => {
    const long = 'ت'.repeat(400);
    const result = metaDescription({ ...paid, subtitleAr: long });
    expect(result.length).toBeLessThan(220);
    expect(result.endsWith('…')).toBe(true);
  });
});
