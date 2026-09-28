import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../admin-nav';
import { formatMinor } from '@/components/money-display';
import { requireOwner } from '@/auth/current';
import { salesHistory, salesHistoryEngineers } from '@/finance/sales-history';
import {
  COMMISSION_MODEL_LABELS, ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS,
  SETTLEMENT_STATUS_LABELS, formatPercent,
} from '@/lib/labels';
import { isUuid } from '@/lib/uuid';
import { divRoundHalfAwayFromZero } from '@/lib/money/money';

export const dynamic = 'force-dynamic';

const FIELD =
  'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm';

const percent = (bp: number) => `${formatPercent(bp)}٪`;

/**
 * The owner's sales and commission history (Stage 5, S5-09).
 *
 * Every sale as it was FROZEN at payment approval (owner decision D-04): the
 * price and discount the customer saw, what they paid, the tax, and for each
 * engineer credited — their contribution, the terms that governed their
 * slice, what they received and what the platform kept. Nothing is recomputed
 * from today's price, agreement or credits; see `src/finance/sales-history.ts`.
 *
 * Review only. There is no form here that changes anything, and the filters
 * are plain query parameters validated on the server.
 */
export default async function AdminSalesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ period?: string; engineer?: string; capped?: string; page?: string }>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  setRequestLocale(locale);

  const actor = await requireOwner('/admin/sales');

  const periodKey = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.period ?? '') ? query.period! : null;
  const contributorId = isUuid(query.engineer ?? '') ? query.engineer! : null;
  const cappedOnly = query.capped === '1';
  const pageNo = /^\d{1,5}$/.test(query.page ?? '') ? Math.max(Number(query.page), 1) : 1;

  const [history, engineers] = await Promise.all([
    salesHistory(actor, { periodKey, contributorId, cappedOnly, page: pageNo }),
    salesHistoryEngineers(actor),
  ]);

  const linkFor = (page: number) => {
    const next = new URLSearchParams();
    if (periodKey) next.set('period', periodKey);
    if (contributorId) next.set('engineer', contributorId);
    if (cappedOnly) next.set('capped', '1');
    if (page > 1) next.set('page', String(page));
    const qs = next.toString();
    return qs ? `/admin/sales?${qs}` : '/admin/sales';
  };

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-10">
        <AdminNav current="/admin/sales" />

        <header className="flex flex-col gap-2">
          <p className="technical-term text-xs tracking-[0.14em] text-[var(--color-ink-faint)]">
            ADMIN
          </p>
          <h1 className="text-2xl font-bold">سجل المبيعات والعمولات</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            كل بيع كما ثُبِّت لحظة اعتماد الدفع: السعر والخصم والمدفوع، ولكل مهندس مساهمته
            والاتفاق الذي طُبِّق على حصته وما ناله هو والمنصة. لا يُعاد حساب أي رقم بالشروط الحالية.
          </p>
        </header>

        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--color-ink-faint)]">الشهر (YYYY-MM)</span>
            <input
              name="period"
              defaultValue={periodKey ?? ''}
              placeholder="2026-09"
              pattern="\d{4}-(0[1-9]|1[0-2])"
              inputMode="numeric"
              className={`${FIELD} technical-term w-32`}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--color-ink-faint)]">المهندس</span>
            <select name="engineer" defaultValue={contributorId ?? ''} className={FIELD}>
              <option value="">الجميع</option>
              {engineers.map((engineer) => (
                <option key={engineer.id} value={engineer.id}>
                  {engineer.name}{engineer.isActive ? '' : ' (موقوف)'}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 py-2 text-sm">
            <input type="checkbox" name="capped" value="1" defaultChecked={cappedOnly} />
            المقصوصة فقط
          </label>
          <button
            type="submit"
            className="rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-4 py-2 text-sm transition-colors hover:border-[var(--color-accent)]"
          >
            عرض
          </button>
        </form>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">المجموع لهذا الاختيار</h2>
          {history.totals.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">
              لا توجد مبيعات مطابقة.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {history.totals.map((total) => (
                <li
                  key={total.currency}
                  className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4 text-sm"
                >
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <dt className="text-xs text-[var(--color-ink-faint)]">المدفوع ({total.sales} عملية)</dt>
                    <dd className="tabular-nums font-semibold">{formatMinor(total.paidMinor, total.currency)}</dd>
                    <dt className="text-xs text-[var(--color-ink-faint)]">الضريبة</dt>
                    <dd className="tabular-nums">{formatMinor(total.taxMinor, total.currency)}</dd>
                    <dt className="text-xs text-[var(--color-ink-faint)]">حصص المهندسين</dt>
                    <dd className="tabular-nums">{formatMinor(total.engineerMinor, total.currency)}</dd>
                    <dt className="text-xs text-[var(--color-ink-faint)]">حصة المنصة</dt>
                    <dd className="tabular-nums">{formatMinor(total.platformMinor, total.currency)}</dd>
                  </dl>
                  {total.clampedRows > 0 ? (
                    <p className="text-xs text-[var(--color-warn)]">
                      {total.clampedRows} حصة قُصّت لأن المبلغ الثابت تجاوز المدفوع.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {history.rows.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
              المبيعات — حصة لكل مهندس في كل بيع
            </h2>
            <ul className="flex flex-col gap-3">
              {history.rows.map((row) => (
                <li
                  key={row.rowId}
                  className={`flex flex-col gap-3 rounded-[var(--radius-card)] border p-4 text-sm ${
                    row.clamped
                      ? 'border-[var(--color-warn)] bg-[var(--color-warn-soft)]'
                      : 'border-[var(--color-line)] bg-[var(--color-surface)]'
                  }`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold">
                      {row.productTitle}
                      {row.versionNo !== null ? (
                        <span className="technical-term ms-2 text-xs text-[var(--color-ink-faint)]">
                          V{row.versionNo}
                        </span>
                      ) : null}
                      {row.isUpgrade ? (
                        <span className="ms-2 text-xs text-[var(--color-ink-soft)]">ترقية</span>
                      ) : null}
                    </span>
                    <span className="technical-term text-xs tabular-nums text-[var(--color-ink-faint)]">
                      {row.orderNumber} · {row.soldAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
                    </span>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                    <Field label="سعر القائمة" value={formatMinor(row.listPriceMinor, row.currency)} />
                    <Field label="الخصم" value={formatMinor(row.discountMinor, row.currency)} />
                    <Field label="المدفوع" value={formatMinor(row.paidMinor, row.currency)} strong />
                    <Field
                      label="الضريبة · الصافي"
                      value={row.taxMinor === null || row.netMinor === null
                        ? '—'
                        : `${formatMinor(row.taxMinor, row.currency)} · ${formatMinor(row.netMinor, row.currency)}`}
                    />
                    <Field
                      label="المهندس"
                      value={`${row.contributorName ?? '—'}${row.authorCount > 1 ? ` (1 من ${row.authorCount})` : ''}`}
                    />
                    <Field label="المساهمة" value={percent(row.shareBp)} />
                    <Field
                      label="أساس العمولة (حصته من الصافي)"
                      value={row.sliceMinor === null ? '—' : formatMinor(row.sliceMinor, row.currency)}
                    />
                    <Field label="الاتفاق" value={termsOf(row)} />
                    <Field label="حصة المهندس" value={formatMinor(row.engineerMinor, row.currency)} strong />
                    <Field
                      label="حصة المنصة"
                      value={row.platformMinor === null ? '—' : formatMinor(row.platformMinor, row.currency)}
                      strong
                    />
                    <Field
                      label="الطلب · الدفع"
                      value={`${ORDER_STATUS_LABELS[row.orderStatus] ?? row.orderStatus} · ${
                        row.paymentStatus ? (PAYMENT_STATUS_LABELS[row.paymentStatus] ?? row.paymentStatus) : '—'
                      }`}
                    />
                    <Field
                      label={`التسوية (${row.periodKey})`}
                      value={row.settlementStatus
                        ? `${SETTLEMENT_STATUS_LABELS[row.settlementStatus] ?? row.settlementStatus}${row.settlementReference ? ` · ${row.settlementReference}` : ''}`
                        : 'لم يصدر كشف بعد'}
                    />
                  </dl>

                  {row.clamped ? (
                    <p className="text-xs font-semibold text-[var(--color-warn)]">
                      قُصّت العمولة: طلب الاتفاق{' '}
                      {row.requestedMinor === null ? 'مبلغاً أكبر من المدفوع' : formatMinor(row.requestedMinor, row.currency)}
                      {' '}ولم يتوفر في هذه الحصة إلا{' '}
                      {row.sliceMinor === null ? '—' : formatMinor(row.sliceMinor, row.currency)}.
                      راجع اتفاق هذا المهندس.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>

            <nav className="flex items-center justify-between gap-3 text-sm">
              {history.page > 1 ? (
                <Link href={linkFor(history.page - 1)} className="underline underline-offset-4">
                  الأحدث
                </Link>
              ) : <span />}
              <span className="tabular-nums text-xs text-[var(--color-ink-faint)]">صفحة {history.page}</span>
              {history.hasMore ? (
                <Link href={linkFor(history.page + 1)} className="underline underline-offset-4">
                  الأقدم
                </Link>
              ) : <span />}
            </nav>
          </section>
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}

function Field({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[var(--color-ink-faint)]">{label}</dt>
      <dd className={`tabular-nums ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  );
}

/** The frozen terms as the owner wrote them. */
function termsOf(row: {
  commissionModel: string | null;
  engineerBp: number | null;
  engineerFixedMinor: bigint | null;
  platformFixedMinor: bigint | null;
  requestedMinor: bigint | null;
  currency: string;
}): string {
  if (row.commissionModel === null) return '—';
  const label = COMMISSION_MODEL_LABELS[row.commissionModel] ?? row.commissionModel;
  if (row.commissionModel === 'PERCENTAGE' && row.engineerBp !== null) {
    return `${label}: المهندس ${percent(row.engineerBp)} · المنصة ${percent(10_000 - row.engineerBp)}`;
  }
  if (row.commissionModel === 'FIXED_BOTH') {
    if (row.engineerFixedMinor === null || row.platformFixedMinor === null) return label;
    const e = row.engineerFixedMinor;
    const p = row.platformFixedMinor;
    // What the two fixed amounts came to on this sale, before the pot was
    // shared in their ratio: `requestedMinor` is their total (migration 0063).
    // Display only, with the engine's own rounding (engineer rounded, platform
    // the remainder) so the two figures shown re-add to the recorded total.
    const engineerPart = row.requestedMinor === null || e + p === 0n
      ? null
      : divRoundHalfAwayFromZero(row.requestedMinor * e, e + p);
    const scaled = engineerPart === null || row.requestedMinor === null
      ? ''
      : ` · بعد الخصم: للمهندس ${formatMinor(engineerPart, row.currency)} وللمنصة ${formatMinor(row.requestedMinor - engineerPart, row.currency)}، والمدفوع بنسبتهما`;
    return `${label}: ${formatMinor(e, row.currency)} للمهندس و${formatMinor(p, row.currency)} للمنصة للمنتج كاملاً${scaled}`;
  }
  const fixed = row.commissionModel === 'FIXED_ENGINEER' ? row.engineerFixedMinor : row.platformFixedMinor;
  if (fixed === null) return label;
  // Sales from migration 0062 on carry the amount their fixed terms asked for
  // on this slice, and were computed on the whole product (D-02, D-03); the
  // ones before it applied the fixed amount to the slice itself.
  return row.requestedMinor === null
    ? `${label}: ${formatMinor(fixed, row.currency)}`
    : `${label}: ${formatMinor(fixed, row.currency)} للمنتج كاملاً`;
}
