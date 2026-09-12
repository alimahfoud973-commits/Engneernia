import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../admin-nav';
import {
  MarkRefundPaidForm, RefundDecisionForms,
  REFUND_REASON_LABELS, REFUND_STATUS_LABELS,
} from '@/components/refund-forms';
import { formatMinor } from '@/components/money-display';
import { requireOwner } from '@/auth/current';
import { refundQueue } from '@/commerce/refund-queries';

export const dynamic = 'force-dynamic';

/**
 * The owner's refund queue (specification §17, §38 — decisions §7).
 *
 * Decisions §7 puts the owner in the loop for every refund, so this screen is
 * the loop. Each card carries what a decision actually needs: what they bought,
 * what they said, how much is at stake, and how many times they downloaded it —
 * the last as EVIDENCE, not a gate, because "الملف التالف" is only discovered
 * by downloading.
 */
export default async function AdminRefundsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireOwner('/admin/refunds');
  const queue = await refundQueue(actor);

  const pending = queue.filter((row) => row.status === 'REQUESTED');
  const approved = queue.filter((row) => row.status === 'APPROVED');
  const closed = queue.filter((row) => !['REQUESTED', 'APPROVED'].includes(row.status));

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 py-10">
        <AdminNav current="/admin/refunds" />
        <header className="flex flex-col gap-2">
          <p className="technical-term text-xs tracking-[0.14em] text-[var(--color-ink-faint)]">
            ADMIN
          </p>
          <h1 className="text-2xl font-bold">طلبات الاسترجاع</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            <span className="tabular-nums">{pending.length}</span> بانتظار قرارك ·{' '}
            <span className="tabular-nums">{approved.length}</span> بانتظار التحويل
          </p>
        </header>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">بانتظار قرارك</h2>
          {pending.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-8 text-center text-sm text-[var(--color-ink-faint)]">
              لا توجد طلبات استرجاع قيد المراجعة.
            </p>
          ) : (
            <ul className="flex flex-col gap-4">
              {pending.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="technical-term text-sm font-bold">{row.reference}</span>
                    <span className="technical-term text-lg font-bold text-[var(--color-accent-ink)]">
                      {formatMinor(row.amountMinor, row.currency)}
                    </span>
                  </div>

                  <ul className="flex flex-col gap-1 text-sm text-[var(--color-ink-soft)]">
                    <li>
                      الطلب <span className="technical-term">{row.orderNumber}</span>
                      {row.customerName ? ` · ${row.customerName}` : ''}
                    </li>
                    <li>
                      السبب:{' '}
                      <span className="font-semibold text-[var(--color-ink)]">
                        {REFUND_REASON_LABELS[row.reason] ?? row.reason}
                      </span>
                    </li>
                    <li>
                      <span className="tabular-nums">{row.itemCount}</span> بنداً ·{' '}
                      <span className="tabular-nums">{row.downloadsSoFar}</span> تنزيلاً حتى الآن
                    </li>
                  </ul>

                  <blockquote className="rounded-[var(--radius-card)] border-r-2 border-[var(--color-line-strong)] bg-[var(--color-surface-muted)] px-4 py-3 text-sm">
                    {row.customerNote}
                  </blockquote>

                  <RefundDecisionForms
                    refundRequestId={row.id}
                    amountLabel={formatMinor(row.amountMinor, row.currency)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
            معتمدة — المال ما زال عندنا
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
                    <span className="technical-term text-sm font-bold">{row.reference}</span>
                    <span className="technical-term text-lg font-bold">
                      {formatMinor(row.amountMinor, row.currency)}
                    </span>
                  </div>
                  <p className="text-sm text-[var(--color-ink-soft)]">
                    الطلب <span className="technical-term">{row.orderNumber}</span> · القيد المعاكس
                    مسجَّل في الدفتر، ويبقى المبلغ ديناً على المنصة حتى يُحوَّل.
                  </p>
                  <MarkRefundPaidForm refundRequestId={row.id} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {closed.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">مغلقة</h2>
            <ul className="flex flex-col gap-2">
              {closed.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] px-4 py-3 text-sm"
                >
                  <span className="technical-term font-semibold">{row.reference}</span>
                  <span className="text-[var(--color-ink-soft)]">
                    {REFUND_STATUS_LABELS[row.status] ?? row.status}
                    {row.decisionNote ? ` — ${row.decisionNote}` : ''}
                  </span>
                  <span className="technical-term tabular-nums">
                    {formatMinor(row.amountMinor, row.currency)}
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
