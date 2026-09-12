import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { formatMinor } from '@/components/money-display';
import { requireActor } from '@/auth/current';
import { activeContributorId } from '@/authz/actor';
import { contributorSales, contributorStatement } from '@/finance/balances';
import { myStatements } from '@/settlements/queries';
import { SETTLEMENT_STATUS_LABELS } from '@/components/settlement-forms';

export const dynamic = 'force-dynamic';

/**
 * The engineer's own financial page (specification §18, §12, §49).
 *
 * PRIVACY TIER 2, enforced four times over. This page shows one contributor
 * their own figures and there is no parameter on it — not a query string, not
 * a path segment — that could name somebody else. Even if there were, the
 * policy layer refuses, and the row-level policy on ledger_lines returns
 * nothing for another contributor's rows.
 *
 * What is deliberately ABSENT: any platform-wide total, any other
 * contributor's figure, and the platform's share of a CO-AUTHORED sale — see
 * `contributorSales` for why that last one is a disclosure.
 */
export default async function EarningsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireActor('/account/earnings');

  // A customer has no earnings page to be told about. Not a 403: confirming
  // that a contributor console exists is itself a hint (CLAUDE.md rule 5).
  if (activeContributorId(actor) === null) redirect('/account');

  const [statement, sales, statements] = await Promise.all([
    contributorStatement(actor),
    contributorSales(actor),
    myStatements(actor),
  ]);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-10">
        <header className="flex flex-col gap-2">
          <p className="technical-term text-xs tracking-[0.14em] text-[var(--color-ink-faint)]">
            MY EARNINGS
          </p>
          <h1 className="text-2xl font-bold">مستحقاتي</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            التسوية شهرية: تتراكم المبيعات خلال الشهر ويُصرف الرصيد في بداية الشهر التالي.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">الرصيد الحالي</h2>
          {statement.balances.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">
              لا توجد مبيعات مسجَّلة بعد.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {statement.balances.map((balance) => (
                <li
                  key={balance.currency}
                  className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="text-sm font-semibold">المستحق الآن</span>
                    <span
                      className={`technical-term text-2xl font-bold tabular-nums ${
                        balance.balanceMinor < 0n
                          ? 'text-[var(--color-danger)]'
                          : 'text-[var(--color-accent-ink)]'
                      }`}
                    >
                      {formatMinor(balance.balanceMinor, balance.currency)}
                    </span>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                    <div className="flex flex-col">
                      <dt className="text-xs text-[var(--color-ink-faint)]">إجمالي المحقق</dt>
                      <dd className="tabular-nums">
                        {formatMinor(balance.earnedMinor, balance.currency)}
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-xs text-[var(--color-ink-faint)]">مسترجَع</dt>
                      <dd className="tabular-nums">
                        {formatMinor(balance.reversedMinor, balance.currency)}
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-xs text-[var(--color-ink-faint)]">مصروف سابقاً</dt>
                      <dd className="tabular-nums">
                        {formatMinor(balance.settledMinor, balance.currency)}
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-xs text-[var(--color-ink-faint)]">الحد الأدنى للصرف</dt>
                      <dd className="tabular-nums">
                        {formatMinor(balance.minimumPayoutMinor, balance.currency)}
                      </dd>
                    </div>
                  </dl>

                  <p className="text-xs text-[var(--color-ink-soft)]">
                    {balance.balanceMinor < 0n
                      ? 'رصيدك سالب لأن استرجاعاً اعتُمد بعد تسوية شهره. يُخصم من مستحقات الشهر القادم.'
                      : balance.meetsMinimum
                        ? 'رصيدك بلغ الحد الأدنى وسيُدرج في تسوية الشهر القادم.'
                        : 'رصيدك دون الحد الأدنى، ويُرحَّل إلى الشهر التالي.'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {statement.byPeriod.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">حسب الشهر</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line-strong)] text-right text-xs text-[var(--color-ink-soft)]">
                    <th className="py-2 font-semibold">الشهر</th>
                    <th className="py-2 font-semibold">محقق</th>
                    <th className="py-2 font-semibold">مسترجَع</th>
                    <th className="py-2 font-semibold">الصافي</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.byPeriod.map((row) => (
                    <tr
                      key={`${row.periodKey}-${row.currency}`}
                      className="border-b border-[var(--color-line)]"
                    >
                      <td className="py-2.5">
                        <span className="technical-term tabular-nums">{row.periodKey}</span>
                      </td>
                      <td className="py-2.5 tabular-nums">
                        {formatMinor(row.earnedMinor, row.currency)}
                      </td>
                      <td className="py-2.5 tabular-nums">
                        {formatMinor(row.reversedMinor, row.currency)}
                      </td>
                      <td className="py-2.5 font-semibold tabular-nums">
                        {formatMinor(row.netMinor, row.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-[var(--color-ink-faint)]">
              يُحسب الاسترجاع في شهر اعتماده، لا في شهر البيع الأصلي: الشهر المُسوّى لا يُعاد فتحه.
            </p>
          </section>
        ) : null}

        {/*
          THE MONTHLY STATEMENTS (specification §18 — decisions §9).

          Every statement appears, including the ones that paid nothing:
          decisions §8 says a balance under the threshold rolls forward "ويظهر
          ذلك في كشفه" — it must be visible, not silently skipped. A negative
          balance appears too, because an engineer whose sale was refunded
          after payment needs to know why next month is short.
        */}
        {statements.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
              الكشوف الشهرية
            </h2>
            <ul className="flex flex-col gap-3">
              {statements.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="technical-term text-sm font-semibold">
                      {row.reference}
                    </span>
                    <span className="text-xs text-[var(--color-ink-soft)]">
                      {SETTLEMENT_STATUS_LABELS[row.status] ?? row.status}
                    </span>
                    <span
                      className={`technical-term tabular-nums font-bold ${
                        row.status === 'PAID' ? 'text-[var(--color-accent-ink)]' : ''
                      } ${row.balanceMinor < 0n ? 'text-[var(--color-danger)]' : ''}`}
                    >
                      {row.status === 'PAID'
                        ? formatMinor(row.netDueMinor, row.currency)
                        : formatMinor(row.balanceMinor, row.currency)}
                    </span>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                    <div className="flex flex-col">
                      <dt className="text-[var(--color-ink-faint)]">مبيعات الشهر</dt>
                      <dd className="tabular-nums">
                        {formatMinor(row.periodSalesMinor, row.currency)}
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-[var(--color-ink-faint)]">استرجاعات</dt>
                      <dd className="tabular-nums">
                        {formatMinor(row.periodRefundsMinor, row.currency)}
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-[var(--color-ink-faint)]">مُرحَّل سابقاً</dt>
                      <dd className="tabular-nums">
                        {formatMinor(row.carriedForwardMinor, row.currency)}
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-[var(--color-ink-faint)]">عدد المبيعات</dt>
                      <dd className="tabular-nums">{row.periodUnitsSold}</dd>
                    </div>
                  </dl>

                  <p className="text-xs text-[var(--color-ink-soft)]">
                    {row.status === 'PAID'
                      ? `حُوِّل${row.payoutReference ? ` — مرجع ${row.payoutReference}` : ''}.`
                      : row.status === 'CARRIED_FORWARD'
                        ? row.balanceMinor < 0n
                          ? 'رصيد سالب بسبب استرجاع اعتُمد بعد تسوية شهره. يُخصم من مستحقات الشهر القادم.'
                          : `الرصيد دون الحد الأدنى ${formatMinor(row.minimumPayoutMinor, row.currency)}، ويُرحَّل إلى الشهر التالي.`
                        : 'قيد المراجعة لدى المالك.'}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {sales.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
              المبيعات وراء هذه الأرقام
            </h2>
            <ul className="flex flex-col gap-2">
              {sales.map((row) => (
                <li
                  key={`${row.periodKey}-${row.currency}`}
                  className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-line)] px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="technical-term tabular-nums font-semibold">
                      {row.periodKey}
                    </span>
                    <span className="tabular-nums">
                      <span className="tabular-nums">{row.unitsSold}</span> عملية ·{' '}
                      {formatMinor(row.grossMinor, row.currency)} إجمالي
                    </span>
                  </div>
                  <p className="text-xs text-[var(--color-ink-soft)]">
                    حصتي {formatMinor(row.engineerMinor, row.currency)}
                    {row.coAuthoredUnits === 0
                      ? ` · عمولة المنصة ${formatMinor(row.platformMinor, row.currency)}`
                      : ` · عمولة المنصة تُعرض فقط للمنتجات المنفردة (${row.coAuthoredUnits} عملية مشتركة مستبعدة)`}
                    {row.refundedUnits > 0 ? ` · ${row.refundedUnits} مسترجَعة` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}
