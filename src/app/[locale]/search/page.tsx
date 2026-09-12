import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { ProductGrid } from '@/components/product-card';
import { searchProducts } from '@/catalog/public-queries';

export const dynamic = 'force-dynamic';

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { q = '' } = await searchParams;

  const results = await searchProducts(q);
  const tooShort = q.trim().length > 0 && q.trim().length < 2;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10">
        <h1 className="text-2xl font-bold">
          {q.trim() ? `نتائج البحث عن: ${q.trim()}` : 'البحث في الموارد'}
        </h1>

        {tooShort ? (
          <p className="text-sm text-[var(--color-ink-soft)]">
            اكتب حرفين على الأقل للبحث.
          </p>
        ) : q.trim() ? (
          <>
            <p className="text-sm text-[var(--color-ink-soft)]">
              {results.length} نتيجة
            </p>
            <ProductGrid products={results} />
          </>
        ) : (
          <p className="text-sm text-[var(--color-ink-soft)]">
            ابحث بعنوان المورد أو وصفه. البحث بالفلاتر المتقدمة — التخصص ونوع الملف والمستوى
            ونطاق السعر — يُضاف في مرحلة الواجهة العامة.
          </p>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
