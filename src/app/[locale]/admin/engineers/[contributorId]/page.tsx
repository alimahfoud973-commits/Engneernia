import Link from 'next/link';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../../admin-nav';
import { EditEngineerForm, EngineerActiveForm } from '@/components/engineer-forms';
import { formatMinor } from '@/components/money-display';
import { requireOwner } from '@/auth/current';
import { disciplineOptions, engineerDetail } from '@/contributors/admin';
import { isUuid } from '@/lib/uuid';
import { PRODUCT_STATUS_LABELS, formatPercent } from '@/lib/labels';
import type { EngineerProductRow } from '@/contributors/admin';

export const dynamic = 'force-dynamic';

/**
 * How much of each sale of this product goes to this engineer, and how much to
 * the platform — OWNER-ONLY (§12).
 *
 * A percentage agreement is a rate, so the platform's share is its complement.
 * A fixed agreement is an AMOUNT, and its complement depends on the slice this
 * particular sale produced — which is not a property of the product. So the
 * fixed cases state the amount and say what it is, rather than printing a
 * percentage the next sale would contradict.
 */
function describeTerms(row: EngineerProductRow): string {
  const currency = row.currency ?? 'USD';
  switch (row.model) {
    case 'PERCENTAGE':
      return row.engineerBp === null
        ? 'اتفاق ناقص'
        : `${formatPercent(row.engineerBp)}٪ للمهندس · `
          + `${formatPercent(10_000 - row.engineerBp)}٪ للمنصة`;
    case 'FIXED_ENGINEER':
      return row.engineerFixedMinor === null
        ? 'اتفاق ناقص'
        : `${formatMinor(row.engineerFixedMinor, currency)} ثابت للمهندس · والباقي للمنصة`;
    case 'FIXED_PLATFORM':
      return row.platformFixedMinor === null
        ? 'اتفاق ناقص'
        : `${formatMinor(row.platformFixedMinor, currency)} ثابت للمنصة · والباقي للمهندس`;
    default:
      return 'لا اتفاق عمولة — البيع يُرفض';
  }
}

/**
 * One engineer: who they are, what they have, what it sold, what they are owed.
 *
 * `isUuid` at the edge so a malformed id is 404 and not 500, and a
 * contributor that does not resolve is the SAME 404 as one that does not
 * exist (CLAUDE.md rule 5).
 */
export default async function AdminEngineerPage({
  params,
}: {
  params: Promise<{ locale: string; contributorId: string }>;
}) {
  const { locale, contributorId } = await params;
  setRequestLocale(locale);

  if (!isUuid(contributorId)) notFound();

  const actor = await requireOwner(`/admin/engineers/${contributorId}`);
  const [detail, disciplines] = await Promise.all([
    engineerDetail(actor, contributorId),
    disciplineOptions(actor),
  ]);
  if (!detail) notFound();

  const { engineer, products } = detail;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-10">
        <AdminNav current="/admin/engineers" />

        <header className="flex flex-col gap-2">
          <Link
            href="/admin/engineers"
            className="text-xs text-[var(--color-ink-faint)] hover:text-[var(--color-accent)]"
          >
            ← كل المهندسين
          </Link>
          <h1 className="text-2xl font-bold">{engineer.displayName}</h1>
          <p className="text-sm text-[var(--color-ink-soft)]" dir="ltr">
            {engineer.email} · /contributors/{engineer.publicSlug} · {engineer.settlementCode}
          </p>
        </header>

        {/* --- 1. state ----------------------------------------------- */}
        <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">الحالة</h2>
          <p className="text-sm">
            {engineer.isActive ? 'مفعَّل — ملفه العام ظاهر.' : 'غير مفعَّل — ملفه العام مخفي.'}
          </p>
          <EngineerActiveForm
            contributorId={engineer.contributorId}
            isActive={engineer.isActive}
          />
          <p className="text-xs text-[var(--color-ink-faint)]">
            إيقاف التفعيل لا يمسّ بيعاً سابقاً ولا رصيداً مستحقاً: ما استحقه المهندس
            يبقى واجب الدفع، وكشفه الشهري يستمر.
          </p>
        </section>

        {/* --- 2. profile --------------------------------------------- */}
        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">البيانات</h2>
          <EditEngineerForm
            contributorId={engineer.contributorId}
            displayName={engineer.displayName}
            disciplineId={engineer.disciplineId}
            specialization={engineer.specialization}
            bio={null}
            disciplines={disciplines}
          />
        </section>

        {/* --- 3. money ----------------------------------------------- */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            المبيعات والمستحقات
          </h2>

          {engineer.sales.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-soft)]">لا مبيعات بعد.</p>
          ) : (
            engineer.sales.map((row) => (
              <div
                key={row.currency}
                className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-line)] px-4 py-3 text-sm"
              >
                <p>
                  <span className="tabular-nums">{row.unitsSold}</span> عملية بيع ·{' '}
                  قيمة حصته منها {formatMinor(row.sliceMinor, row.currency)}
                </p>
                <p className="text-xs text-[var(--color-ink-soft)]">
                  للمهندس {formatMinor(row.engineerMinor, row.currency)} · للمنصة{' '}
                  {formatMinor(row.platformMinor, row.currency)}
                </p>
              </div>
            ))
          )}

          {engineer.dues.map((due) => (
            <div
              key={due.currency}
              className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-4 py-3 text-sm"
            >
              <p>
                المستحق الآن{' '}
                <strong className="tabular-nums">
                  {formatMinor(due.balanceMinor, due.currency)}
                </strong>
              </p>
              <p className="text-xs text-[var(--color-ink-soft)]">
                صُرف عبر التسوية الشهرية {formatMinor(due.settledMinor, due.currency)} ·{' '}
                <Link href="/admin/settlements" className="hover:text-[var(--color-accent)]">
                  شاشة التسوية
                </Link>
              </p>
            </div>
          ))}

          <p className="text-xs text-[var(--color-ink-faint)]">
            الأرقام أعلاه مجموعة من الدفتر ومن حصص المهندس المجمَّدة وقت البيع. الصرف
            شهري عبر التسوية، لا بعد كل عملية.
          </p>
        </section>

        {/* --- 4. catalogue ------------------------------------------- */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            منتجاته وملفاته <span className="tabular-nums">({products.length})</span>
          </h2>

          {products.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-soft)]">لا منتجات منسوبة إليه.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {products.map((product) => (
                <li
                  key={product.productId}
                  className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-line)] px-4 py-3"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <Link
                      href={`/admin/products/${product.productId}`}
                      className="text-sm font-semibold hover:text-[var(--color-accent)]"
                    >
                      {product.titleAr}
                    </Link>
                    <span className="text-xs text-[var(--color-ink-faint)]">
                      {PRODUCT_STATUS_LABELS[product.status] ?? product.status}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--color-ink-soft)]">
                    {product.priceMinor === null
                      ? 'بلا سعر بعد'
                      : `السعر ${formatMinor(product.priceMinor, product.currency ?? 'USD')}`}
                    {' · '}
                    نسبته من المنتج {formatPercent(product.shareBp)}٪
                    {' · '}
                    {describeTerms(product)}
                    {product.isOverride ? ' (استثناء لهذا المنتج)' : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-[var(--color-ink-faint)]">
            نسب العمولة تُضبط في{' '}
            <Link href="/admin/commissions" className="hover:text-[var(--color-accent)]">
              اتفاقات العمولة
            </Link>
            ، والمنتجات تُرفع وتُنشر وتُحذف من{' '}
            <Link href="/admin/products" className="hover:text-[var(--color-accent)]">
              الكتالوج
            </Link>
            . المهندس لا يملك أياً من الاثنين.
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
