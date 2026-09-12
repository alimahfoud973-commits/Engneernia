import { getTranslations, setRequestLocale } from 'next-intl/server';
import { PLATFORM_TIMEZONE } from '@/lib/time/period';
import { BASE_CURRENCY } from '@/lib/money/currency';

const DISCIPLINE_KEYS = ['electrical', 'mechanical', 'architecture', 'civil'] as const;

/**
 * Phase-0 foundation page.
 *
 * It exists to prove the stack end to end — Arabic RTL rendering, the font
 * superfamily, design tokens, locale messages and the accounting constants —
 * and is replaced by the real storefront in phase P4.
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-10 px-5 py-14">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-xs tracking-[0.18em] text-[var(--color-ink-faint)]">
          <span className="technical-term">PHASE P0</span> — {t('status.buildFoundation')}
        </p>
        <h1 className="text-3xl font-bold text-balance sm:text-4xl">{t('platform.name')}</h1>
        <p className="max-w-prose text-lg text-[var(--color-ink-soft)]">{t('platform.tagline')}</p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">
          {t('home.featured')}
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {DISCIPLINE_KEYS.map((key) => (
            <li
              key={key}
              className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
            >
              <span className="block text-base font-semibold">{t(`disciplines.${key}`)}</span>
              <span className="mt-1 block font-mono text-xs text-[var(--color-ink-faint)]">
                <span className="technical-term">{key}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
        <h2 className="mb-4 text-sm font-semibold text-[var(--color-ink-soft)]">
          إعدادات المنصة المحاسبية
        </h2>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <dt className="font-mono text-[10px] tracking-[0.14em] text-[var(--color-ink-faint)]">
              {t('common.timezone')}
            </dt>
            <dd className="technical-term text-sm font-medium">{PLATFORM_TIMEZONE}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="font-mono text-[10px] tracking-[0.14em] text-[var(--color-ink-faint)]">
              {t('common.currency')}
            </dt>
            <dd className="technical-term text-sm font-medium">{BASE_CURRENCY}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="font-mono text-[10px] tracking-[0.14em] text-[var(--color-ink-faint)]">
              {t('common.locale')}
            </dt>
            <dd className="technical-term text-sm font-medium">{locale} (RTL)</dd>
          </div>
        </dl>
      </section>

      <p className="rounded-[var(--radius-card)] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]">
        {t('status.underConstruction')}
      </p>
    </main>
  );
}
