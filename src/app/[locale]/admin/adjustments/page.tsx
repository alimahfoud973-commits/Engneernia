import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../admin-nav';
import { AdjustmentTool, ADJUSTMENT_REASON_LABELS } from '@/components/adjustment-forms';
import { formatMinor } from '@/components/money-display';
import { requireOwner } from '@/auth/current';
import { adjustableContributors, listAdjustments } from '@/finance/adjustments';
import { readFinancialPolicy } from '@/finance/policy';
import { withActor } from '@/db/actor-context';

export const dynamic = 'force-dynamic';

const TARGET_LABELS: Readonly<Record<string, string>> = {
  ENGINEER: 'مهندس',
  PLATFORM: 'المنصة',
};

/**
 * Financial adjustments (owner decision on OPEN-21).
 *
 * OWNER-ONLY at four independent layers: `requireOwner` redirects, every
 * service function refuses a non-owner, the policy matrix denies
 * `platform.readRevenue` to every other role, and the row-level policy on
 * `financial_adjustments` is `app_is_owner()` for ALL commands — so even a
 * query that forgot every check returns nothing.
 *
 * The page is deliberately two things and no more: the tool, and the log of
 * what has been done with it. "أريد أداة مالية صغيرة، واضحة، آمنة، قابلة
 * للتدقيق" — an audit trail nobody can read is not an audit trail, so the log
 * sits directly under the form rather than behind a link.
 */
export default async function AdminAdjustmentsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireOwner('/admin/adjustments');

  const policy = await withActor(actor, readFinancialPolicy);
  const [contributors, adjustments] = await Promise.all([
    adjustableContributors(actor),
    listAdjustments(actor, { limit: 50 }),
  ]);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 py-10">
        <AdminNav current="/admin/adjustments" />

        <header className="flex flex-col gap-2">
          <p className="technical-term text-xs tracking-[0.14em] text-[var(--color-ink-faint)]">
            ADMIN
          </p>
          <h1 className="text-2xl font-bold">قيود التصحيح</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            لتسجيل تصحيح مالي استثنائي بشكل رسمي وقابل للتدقيق. كل تصحيح{' '}
            <strong>قيد جديد</strong> في الدفتر — لا تُعدَّل ولا تُحذف أي عملية بيع سابقة.
          </p>
        </header>

        <AdjustmentTool
          contributors={contributors}
          currency={policy.settlement.currency}
        />

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            سجل التصحيحات
          </h2>

          {adjustments.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">
              لم يُسجَّل أي تصحيح بعد.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {adjustments.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-[var(--color-line)] px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="technical-term font-semibold">{row.reference}</span>
                    <span className="text-[var(--color-ink-soft)]">
                      {TARGET_LABELS[row.target] ?? row.target}
                      {row.contributorName ? ` — ${row.contributorName}` : ''}
                    </span>
                    <span
                      className={`technical-term tabular-nums font-bold ${
                        row.direction === 'DECREASE' ? 'text-[var(--color-danger)]' : ''
                      }`}
                    >
                      {row.direction === 'INCREASE' ? '+' : '−'}
                      {formatMinor(row.amountMinor, row.currency)}
                    </span>
                  </div>

                  <p className="text-xs text-[var(--color-ink-soft)]">
                    {ADJUSTMENT_REASON_LABELS[row.reason] ?? row.reason} — {row.note}
                  </p>

                  <p className="text-xs text-[var(--color-ink-faint)]">
                    <time dateTime={row.occurredAt.toISOString()} className="technical-term">
                      {row.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </time>
                    {row.createdByName ? ` · ${row.createdByName}` : ''}
                  </p>
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
