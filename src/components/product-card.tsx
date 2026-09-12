import Link from 'next/link';
import type { PublicProductCard } from '@/catalog/public-queries';

const FILE_TYPE_LABELS: Record<string, string> = {
  PDF: 'PDF',
  EXCEL: 'Excel',
  CAD: 'CAD',
  REVIT_BIM: 'Revit / BIM',
  TEMPLATE: 'قالب',
  PROJECT: 'مشروع',
  OTHER: 'أخرى',
};

const LEVEL_LABELS: Record<string, string> = {
  BEGINNER: 'مبتدئ',
  INTERMEDIATE: 'متوسط',
  ADVANCED: 'متقدم',
};

/**
 * Formats minor units for display.
 *
 * Display only — the value arrives as a string of minor units and is never
 * used in a calculation here. All money arithmetic happens server-side in
 * src/lib/money (CLAUDE.md rule 2).
 */
function formatPrice(priceMinor: string | null, currency: string, isFree: boolean): string {
  if (isFree || priceMinor === '0') return 'مجاني';
  if (priceMinor === null) return '—';
  const major = Number(priceMinor) / 100;
  return new Intl.NumberFormat('ar', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(major);
}

export function ProductCard({ product }: { product: PublicProductCard }) {
  return (
    <li className="group">
      <Link
        href={`/products/${product.slug}`}
        className="flex h-full flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-accent)]"
      >
        <div className="flex items-center gap-2">
          <span className="technical-term rounded-sm bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-ink-soft)]">
            {FILE_TYPE_LABELS[product.fileType] ?? product.fileType}
          </span>
          {product.level ? (
            <span className="text-[11px] text-[var(--color-ink-faint)]">
              {LEVEL_LABELS[product.level] ?? product.level}
            </span>
          ) : null}
        </div>

        <h3 className="text-balance text-base font-semibold leading-snug">{product.titleAr}</h3>

        {product.subtitleAr ? (
          <p className="line-clamp-2 text-sm leading-relaxed text-[var(--color-ink-soft)]">
            {product.subtitleAr}
          </p>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-[var(--color-line)] pt-3">
          <span className="text-xs text-[var(--color-ink-faint)]">
            {product.categoryNameAr ?? product.disciplineNameAr}
          </span>
          <span
            className={
              product.isFree
                ? 'text-sm font-semibold text-[var(--color-ok)]'
                : 'text-sm font-semibold tabular-nums text-[var(--color-accent-ink)]'
            }
          >
            {formatPrice(product.priceMinor, product.currency, product.isFree)}
          </span>
        </div>
      </Link>
    </li>
  );
}

export function ProductGrid({ products }: { products: readonly PublicProductCard[] }) {
  if (products.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">
        لا توجد موارد منشورة في هذا القسم بعد.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {products.map((product) => (
        <ProductCard key={product.slug} product={product} />
      ))}
    </ul>
  );
}

export { formatPrice, FILE_TYPE_LABELS, LEVEL_LABELS };
