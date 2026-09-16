import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../admin-nav';
import { CommissionForm } from '@/components/commission-forms';
import { formatMinor } from '@/components/money-display';
import { requireOwner } from '@/auth/current';
import { commissionOverview } from '@/finance/commissions';

export const dynamic = 'force-dynamic';

/**
 * Basis points as a person reads them: 8000 is "80", 6250 is "62.5".
 *
 * Trailing zeros are stripped only AFTER a decimal point — a blanket strip
 * would turn 10000 into "1" and put every engineer on a one percent rate as
 * far as the screen is concerned.
 */
function formatPercent(bp: number): string {
  return (bp / 100).toFixed(2).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/**
 * Commission agreements, one engineer at a time (§11 — owner decision OPEN-15).
 *
 * OWNER-ONLY at every layer that exists: `requireOwner` redirects,
 * `commissionOverview` and `saveCommissionAgreement` each refuse a non-owner,
 * and the row policy on `commission_agreements` is `app_is_owner()` for writes
 * and hands a contributor only their own row on reads — so a query that forgot
 * every check still could not build this page for anyone else.
 *
 * WHY THE SCREEN EXISTS AT ALL. Since OPEN-15 the sale path applies each
 * engineer's own terms to their own slice, which makes "what is this engineer
 * paid?" a question with a per-person answer. It was previously answerable
 * only through a database console.
 */
export default async function AdminCommissionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireOwner('/admin/commissions');
  const { engineers, overrides, creditedProducts } = await commissionOverview(actor);


  const currency = engineers.find((e) => e.currency)?.currency ?? 'USD';

  const describe = (row: (typeof engineers)[number]) => {
    if (row.model === 'PERCENTAGE' && row.engineerBp !== null) {
      return `${formatPercent(row.engineerBp)}٪ للمهندس`;
    }
    if (row.model === 'FIXED_ENGINEER' && row.engineerFixedMinor !== null) {
      return `${formatMinor(row.engineerFixedMinor, row.currency ?? currency)} ثابت للمهندس`;
    }
    if (row.model === 'FIXED_PLATFORM' && row.platformFixedMinor !== null) {
      return `${formatMinor(row.platformFixedMinor, row.currency ?? currency)} ثابت للمنصة`;
    }
    return null;
  };

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-10">
        <AdminNav current="/admin/commissions" />

        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">اتفاقات العمولة</h1>
          <p className="max-w-prose text-sm leading-relaxed text-[var(--color-ink-soft)]">
            لكل مهندس اتفاقه الخاص. على المنتج المشترك يُقسَّم صافي البيع بحسب
            نسبة المساهمة، ثم <strong>تُطبَّق على حصة كل مهندس نسبته هو</strong> — لا
            نسبة زميله.
          </p>
        </header>

        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            تحديد أو تعديل اتفاق
          </h2>
          <CommissionForm
            engineers={engineers.map((e) => ({
              contributorId: e.contributorId,
              displayName: e.isActive ? e.displayName : `${e.displayName} (موقوف)`,
            }))}
            products={creditedProducts}
            currency={currency}
          />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            الاتفاقات السارية ({engineers.length})
          </h2>

          {engineers.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-faint)]">لا يوجد مهندسون بعد.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-line)] rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)]">
              {engineers.map((row) => {
                const terms = describe(row);
                return (
                  <li
                    key={row.contributorId}
                    className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3"
                  >
                    <span className="text-sm font-semibold">{row.displayName}</span>
                    <span className="flex flex-wrap items-baseline gap-3 text-xs">
                      {terms ? (
                        <span className="tabular-nums text-[var(--color-ink)]">{terms}</span>
                      ) : (
                        /*
                         * Not a blank. An engineer with no agreement cannot be
                         * sold at all — §11 refuses a sale nobody agreed terms
                         * for — so this is the reason their product would be
                         * refused, said where the owner can act on it.
                         */
                        <span className="text-[var(--color-danger)]">
                          لا اتفاق سارٍ — لا يمكن بيع منتجاته
                        </span>
                      )}
                      {row.overrideCount > 0 ? (
                        <span className="text-[var(--color-ink-faint)]">
                          و{row.overrideCount} استثناء على منتجات بعينها
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {overrides.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
              استثناءات على منتجات بعينها ({overrides.length})
            </h2>
            <ul className="flex flex-col divide-y divide-[var(--color-line)] rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)]">
              {overrides.map((row) => (
                <li
                  key={row.agreementId}
                  className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 text-sm"
                >
                  <span>
                    {row.contributorName} — <span className="text-[var(--color-ink-soft)]">{row.productTitle}</span>
                  </span>
                  <span className="tabular-nums text-xs">
                    {row.model === 'PERCENTAGE' && row.engineerBp !== null
                      ? `${formatPercent(row.engineerBp)}٪`
                      : row.model}
                  </span>
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
