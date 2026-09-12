import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../admin-nav';
import {
  ApproveSettlementForm, CancelSettlementForm, GenerateSettlementsForm,
  PaySettlementForm, SETTLEMENT_STATUS_LABELS,
} from '@/components/settlement-forms';
import { formatMinor } from '@/components/money-display';
import { requireOwner } from '@/auth/current';
import { defaultSettlementPeriod, settlementRun } from '@/settlements/queries';

export const dynamic = 'force-dynamic';

/**
 * The owner's monthly settlement run (specification §15, §16, §20).
 *
 * The operating loop decisions §8 describes: on the first of the month,
 * generate the statements for the month that just closed, review them, approve
 * what is due, and record each transfer as it is made.
 *
 * Statements that pay nothing are shown, not hidden. Decisions §8 requires a
 * carried-forward balance to be visible, and the owner needs to see a NEGATIVE
 * balance — an engineer who was paid for a sale later refunded — because that
 * is the one that will quietly net off next month.
 */
export default async function AdminSettlementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { locale } = await params;
  const { period } = await searchParams;
  setRequestLocale(locale);

  const actor = await requireOwner('/admin/settlements');

  const fallback = defaultSettlementPeriod();
  const periodKey = /^\d{4}-(0[1-9]|1[0-2])$/.test(period ?? '') ? period! : fallback;
  const rows = await settlementRun(actor, periodKey);

  const pending = rows.filter((row) => row.status === 'PENDING');
  const approved = rows.filter((row) => row.status === 'APPROVED');
  const others = rows.filter((row) => !['PENDING', 'APPROVED'].includes(row.status));

  const payableTotal = pending.reduce((total, row) => total + row.netDueMinor, 0n);
  const currency = rows[0]?.currency ?? 'USD';

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-10">
        <AdminNav current="/admin/settlements" />

        <header className="flex flex-col gap-2">
          <p className="technical-term text-xs tracking-[0.14em] text-[var(--color-ink-faint)]">
            ADMIN
          </p>
          <h1 className="text-2xl font-bold">التسوية الشهرية</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            الفترة <span className="technical-term tabular-nums">{periodKey}</span> ·{' '}
            <span className="tabular-nums">{pending.length}</span> بانتظار الاعتماد ·{' '}
            <span className="tabular-nums">{approved.length}</span> بانتظار التحويل
            {pending.length > 0 ? (
              <>
                {' '}· إجمالي المستحق{' '}
                <span className="technical-term tabular-nums">
                  {formatMinor(payableTotal, currency)}
                </span>
              </>
            ) : null}
          </p>
        </header>

        <GenerateSettlementsForm defaultPeriod={periodKey} />

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            بانتظار اعتمادك
          </h2>
          {pending.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">
              لا توجد كشوف بانتظار الاعتماد لهذه الفترة.
            </p>
          ) : (
            <ul className="flex flex-col gap-4">
              {pending.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="font-semibold">{row.contributorName ?? '—'}</span>
                    <span className="technical-term text-xs text-[var(--color-ink-faint)]">
                      {row.reference}
                    </span>
                    <span className="technical-term text-lg font-bold text-[var(--color-accent-ink)]">
                      {formatMinor(row.netDueMinor, row.currency)}
                    </span>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                    <div className="flex flex-col">
                      <dt className="text-xs text-[var(--color-ink-faint)]">مبيعات الشهر</dt>
                      <dd className="tabular-nums">
                        {formatMinor(row.periodSalesMinor, row.currency)}
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-xs text-[var(--color-ink-faint)]">استرجاعات</dt>
                      <dd className="tabular-nums">
                        {formatMinor(row.periodRefundsMinor, row.currency)}
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-xs text-[var(--color-ink-faint)]">مُرحَّل سابقاً</dt>
                      <dd className="tabular-nums">
                        {formatMinor(row.carriedForwardMinor, row.currency)}
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-xs text-[var(--color-ink-faint)]">عدد المبيعات</dt>
                      <dd className="tabular-nums">{row.periodUnitsSold}</dd>
                    </div>
                  </dl>

                  <div className="flex flex-col gap-2 border-t border-[var(--color-line)] pt-3">
                    <ApproveSettlementForm settlementId={row.id} />
                    <CancelSettlementForm settlementId={row.id} />
                    <a
                      href={`/api/settlements/${row.id}/statement`}
                      className="self-start text-xs font-semibold text-[var(--color-ink-soft)] underline underline-offset-4"
                    >
                      معاينة الكشف PDF كما يصل المهندس
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            معتمدة — بانتظار التحويل
          </h2>
          {approved.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-6 text-center text-sm text-[var(--color-ink-faint)]">
              لا شيء بانتظار التحويل.
            </p>
          ) : (
            <ul className="flex flex-col gap-4">
              {approved.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="font-semibold">{row.contributorName ?? '—'}</span>
                    <span className="technical-term text-xs text-[var(--color-ink-faint)]">
                      {row.reference}
                    </span>
                    <span className="technical-term text-lg font-bold">
                      {formatMinor(row.netDueMinor, row.currency)}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--color-ink-soft)]">
                    يُسجَّل القيد في الدفتر لحظة تسجيل التحويل، لا قبله.
                  </p>
                  <PaySettlementForm
                    settlementId={row.id}
                    amountLabel={formatMinor(row.netDueMinor, row.currency)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {others.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
              بقية كشوف الفترة
            </h2>
            <ul className="flex flex-col gap-2">
              {others.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] px-4 py-3 text-sm"
                >
                  <span className="font-semibold">{row.contributorName ?? '—'}</span>
                  <span className="text-[var(--color-ink-soft)]">
                    {SETTLEMENT_STATUS_LABELS[row.status] ?? row.status}
                  </span>
                  <span
                    className={`technical-term tabular-nums ${
                      row.balanceMinor < 0n ? 'font-bold text-[var(--color-danger)]' : ''
                    }`}
                  >
                    {row.status === 'PAID'
                      ? formatMinor(row.netDueMinor, row.currency)
                      : formatMinor(row.balanceMinor, row.currency)}
                  </span>
                  <span className="text-xs text-[var(--color-ink-faint)]">
                    {row.status === 'PAID'
                      ? row.payoutReference ?? 'مصروف'
                      : row.balanceMinor < 0n
                        ? 'رصيد سالب — استرجاع بعد تسوية، يُخصم الشهر القادم'
                        : row.minimumPayoutMinor > 0n
                          ? `دون الحد الأدنى ${formatMinor(row.minimumPayoutMinor, row.currency)}`
                          : 'لا رصيد مستحق'}
                  </span>
                  <a
                    href={`/api/settlements/${row.id}/statement`}
                    className="text-xs text-[var(--color-ink-soft)] underline underline-offset-4"
                  >
                    PDF
                  </a>
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
