import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../admin-nav';
import { AddEngineerForm } from '@/components/engineer-forms';
import { formatMinor } from '@/components/money-display';
import { requireOwner } from '@/auth/current';
import { disciplineOptions, engineerRoster } from '@/contributors/admin';
import { formatPercent } from '@/lib/labels';

export const dynamic = 'force-dynamic';

/**
 * The owner's engineers (§19, §32, §46).
 *
 * OWNER-ONLY at every layer that exists: `requireOwner` redirects,
 * `engineerRoster` refuses a non-owner outright, and underneath,
 * `product_contributors` has been owner-only since migration 0049 while
 * `order_item_contributors` resolves one engineer's own row — so a query that
 * forgot every check would still hand an engineer an empty page rather than a
 * colleague's earnings.
 *
 * WHAT IS ON IT AND WHAT IS NOT. Rates are SHOWN here and SET on
 * `/admin/commissions`; products are shown here and created on
 * `/admin/products`. A second write path for either would be a second chance
 * to get the versioning wrong, and the versioning is what keeps a past sale on
 * the terms it was booked at.
 */
export default async function AdminEngineersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireOwner('/admin/engineers');
  const [engineers, disciplines] = await Promise.all([
    engineerRoster(actor),
    disciplineOptions(actor),
  ]);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-10">
        <AdminNav current="/admin/engineers" />

        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">المهندسون</h1>
          <p className="max-w-prose text-sm leading-relaxed text-[var(--color-ink-soft)]">
            المهندس يسجّل حسابه بنفسه، والمالك وحده يمنحه ملف مهندس ويفعّله. رفع
            المنتجات ونشرها وحذفها من صلاحية المالك وحده أيضاً.
          </p>
        </header>

        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">مهندس جديد</h2>
          <AddEngineerForm disciplines={disciplines} />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            كل المهندسين <span className="tabular-nums">({engineers.length})</span>
          </h2>

          {engineers.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-soft)]">لا يوجد مهندسون بعد.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {engineers.map((engineer) => (
                <li
                  key={engineer.contributorId}
                  className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-line)] px-4 py-3"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <Link
                      href={`/admin/engineers/${engineer.contributorId}`}
                      className="text-sm font-semibold hover:text-[var(--color-accent)]"
                    >
                      {engineer.displayName}
                    </Link>
                    <span
                      className={`rounded-[var(--radius-card)] px-2 py-0.5 text-xs ${
                        engineer.isActive
                          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]'
                          : 'text-[var(--color-ink-faint)]'
                      }`}
                    >
                      {engineer.isActive ? 'مفعَّل' : 'غير مفعَّل'}
                    </span>
                  </div>

                  <p className="text-xs text-[var(--color-ink-soft)]">
                    {engineer.disciplineNameAr ?? 'تخصص غير محدّد'}
                    {engineer.specialization ? ` · ${engineer.specialization}` : ''}
                    {' · '}
                    <span className="tabular-nums">{engineer.productsPublished}</span> منشور من{' '}
                    <span className="tabular-nums">{engineer.productsTotal}</span> منتج
                    {engineer.model === 'PERCENTAGE' && engineer.engineerBp !== null
                      ? ` · ${formatPercent(engineer.engineerBp)}٪ له`
                      : engineer.model === null
                        ? ' · بلا اتفاق عمولة'
                        : ' · اتفاق بمبلغ ثابت'}
                  </p>

                  {engineer.sales.length > 0 ? (
                    <p className="text-xs text-[var(--color-ink-soft)]">
                      {engineer.sales.map((row) => (
                        <span key={row.currency} className="ms-0 me-3 inline-block">
                          <span className="tabular-nums">{row.unitsSold}</span> مبيع ·{' '}
                          {formatMinor(row.engineerMinor, row.currency)} للمهندس ·{' '}
                          {formatMinor(row.platformMinor, row.currency)} للمنصة
                        </span>
                      ))}
                    </p>
                  ) : (
                    <p className="text-xs text-[var(--color-ink-faint)]">لا مبيعات بعد.</p>
                  )}

                  {engineer.dues.map((due) => (
                    <p key={due.currency} className="text-xs text-[var(--color-ink-soft)]">
                      المستحق الآن{' '}
                      <strong className="tabular-nums">
                        {formatMinor(due.balanceMinor, due.currency)}
                      </strong>
                      {' · '}صُرف حتى الآن {formatMinor(due.settledMinor, due.currency)}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
