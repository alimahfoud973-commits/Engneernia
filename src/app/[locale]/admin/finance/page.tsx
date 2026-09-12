import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../admin-nav';
import { formatMinor } from '@/components/money-display';
import { requireOwner } from '@/auth/current';
import { outstandingPayables, revenueByDiscipline, revenueByPeriod } from '@/finance/reports';
import { checkLedgerHealth } from '@/ledger/verify';
import { readFinancialPolicy } from '@/finance/policy';
import { withActor } from '@/db/actor-context';

export const dynamic = 'force-dynamic';

/**
 * The owner's financial report (specification §19, §20, §49).
 *
 * OWNER-ONLY, and not by hiding a link: `requireOwner` redirects, the report
 * functions refuse a non-owner, the policy matrix denies `platform.readRevenue`
 * to every other role, and the ledger's row-level policies would return an
 * empty set even if all three were removed.
 *
 * The integrity banner is deliberately at the top rather than buried in a
 * settings page. A report is only worth reading if the books behind it still
 * verify, and that fact should be the first thing on the screen — including
 * when the answer is no.
 */
export default async function AdminFinancePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireOwner('/admin/finance');

  const policy = await withActor(actor, readFinancialPolicy);
  const [health, periods, disciplines, payables] = await Promise.all([
    checkLedgerHealth(actor),
    revenueByPeriod(actor, { periods: 12 }),
    revenueByDiscipline(actor),
    outstandingPayables(actor, { minimumPayoutMinor: policy.settlement.minimumPayoutMinor }),
  ]);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-10">
        <AdminNav current="/admin/finance" />
        <header className="flex flex-col gap-2">
          <p className="technical-term text-xs tracking-[0.14em] text-[var(--color-ink-faint)]">
            ADMIN
          </p>
          <h1 className="text-2xl font-bold">التقرير المالي</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            كل رقم هنا مقروء من دفتر القيد المزدوج، لا محسوباً من جديد.
          </p>
        </header>

        {/* --- integrity --------------------------------------------------- */}
        <section
          className={`flex flex-col gap-2 rounded-[var(--radius-card)] border px-4 py-3 text-sm ${
            health.isHealthy
              ? 'border-[var(--color-line)] bg-[var(--color-surface)]'
              : 'border-[var(--color-danger)] bg-[var(--color-danger-soft)]'
          }`}
        >
          <p className="font-semibold">
            {health.isHealthy ? 'سلامة الدفتر: سليم' : 'سلامة الدفتر: يوجد خلل'}
          </p>
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-[var(--color-ink-soft)]">
            {health.balances.length === 0 ? (
              <li>لا توجد قيود بعد.</li>
            ) : (
              health.balances.map((balance) => (
                <li key={balance.currency}>
                  <span className="technical-term">{balance.currency}</span>: مجموع القيود{' '}
                  <span className="tabular-nums">{balance.totalMinor.toString()}</span> عبر{' '}
                  <span className="tabular-nums">{balance.lineCount.toString()}</span> سطراً
                  {balance.totalMinor === 0n ? ' — متوازن' : ' — غير متوازن'}
                </li>
              ))
            )}
          </ul>
          {health.chainProblems.length > 0 ? (
            <ul className="flex flex-col gap-1 text-[var(--color-danger)]">
              {health.chainProblems.slice(0, 5).map((problem) => (
                <li key={`${problem.seq}-${problem.problem}`}>
                  القيد رقم <span className="tabular-nums">{problem.seq.toString()}</span>:{' '}
                  {problem.problem}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* --- by period ---------------------------------------------------- */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            حسب الشهر المحاسبي (توقيت دمشق)
          </h2>
          {periods.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">
              لا توجد مبيعات مسجَّلة بعد.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line-strong)] text-right text-xs text-[var(--color-ink-soft)]">
                    <th className="py-2 font-semibold">الشهر</th>
                    <th className="py-2 font-semibold">المبيعات</th>
                    <th className="py-2 font-semibold">عمولة المنصة</th>
                    <th className="py-2 font-semibold">حصة المهندسين</th>
                    <th className="py-2 font-semibold">الاسترجاعات</th>
                    <th className="py-2 font-semibold">صافي المنصة</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((row) => (
                    <tr
                      key={`${row.periodKey}-${row.currency}`}
                      className="border-b border-[var(--color-line)]"
                    >
                      <td className="py-2.5">
                        <span className="technical-term tabular-nums">{row.periodKey}</span>{' '}
                        <span className="text-xs text-[var(--color-ink-faint)]">
                          {row.currency}
                        </span>
                      </td>
                      <td className="py-2.5 tabular-nums">
                        {formatMinor(row.grossSalesMinor, row.currency)}
                        <span className="block text-xs text-[var(--color-ink-faint)]">
                          {row.salesCount} عملية
                        </span>
                      </td>
                      <td className="py-2.5 tabular-nums">
                        {formatMinor(row.platformRevenueMinor, row.currency)}
                      </td>
                      <td className="py-2.5 tabular-nums">
                        {formatMinor(row.engineerShareMinor, row.currency)}
                      </td>
                      <td className="py-2.5 tabular-nums">
                        {formatMinor(row.refundsMinor, row.currency)}
                        {row.refundCount > 0 ? (
                          <span className="block text-xs text-[var(--color-ink-faint)]">
                            {row.refundCount} استرجاع
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 font-semibold tabular-nums text-[var(--color-accent-ink)]">
                        {formatMinor(row.netPlatformMinor, row.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* --- by discipline ------------------------------------------------ */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">حسب التخصص</h2>
          {disciplines.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-6 text-center text-sm text-[var(--color-ink-faint)]">
              لا توجد بيانات بعد.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {disciplines.map((row) => (
                <li
                  key={`${row.disciplineSlug}-${row.currency}`}
                  className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
                >
                  <span className="font-semibold">{row.disciplineNameAr}</span>
                  <span className="technical-term text-lg font-bold tabular-nums">
                    {formatMinor(row.grossMinor, row.currency)}
                  </span>
                  <span className="text-xs text-[var(--color-ink-soft)]">
                    <span className="tabular-nums">{row.unitsSold}</span> عملية بيع · عمولة{' '}
                    {formatMinor(row.platformMinor, row.currency)}
                    {row.unitsRefunded > 0
                      ? ` · ${row.unitsRefunded} مسترجَعة (مستبعدة من المجموع)`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --- payables ------------------------------------------------------ */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            مستحقات المهندسين — الحد الأدنى للصرف{' '}
            {formatMinor(policy.settlement.minimumPayoutMinor, policy.settlement.currency)}
          </h2>
          {payables.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-6 text-center text-sm text-[var(--color-ink-faint)]">
              لا توجد مستحقات قائمة.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {payables.map((row) => (
                <li
                  key={`${row.contributorId}-${row.currency}`}
                  className="flex flex-wrap items-baseline justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] px-4 py-3 text-sm"
                >
                  <span className="font-semibold">{row.contributorName ?? '—'}</span>
                  <span
                    className={`technical-term tabular-nums font-bold ${
                      row.balanceMinor < 0n ? 'text-[var(--color-danger)]' : ''
                    }`}
                  >
                    {formatMinor(row.balanceMinor, row.currency)}
                  </span>
                  <span className="text-xs text-[var(--color-ink-faint)]">
                    {row.balanceMinor < 0n
                      ? 'رصيد سالب — استرجاع بعد تسوية'
                      : row.meetsMinimum
                        ? 'بلغ الحد الأدنى'
                        : 'يُرحَّل إلى الشهر التالي'}
                  </span>
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
