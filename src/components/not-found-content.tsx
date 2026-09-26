import Link from 'next/link';

/**
 * What every 404 on the platform says (D1).
 *
 * Shared by the two not-found pages — the one inside the `[locale]` layout
 * and the root one that renders its own document — so a missing product and
 * a mistyped address cannot drift into two different pages.
 *
 * It reads nothing: no database, no settings, no session. A 404 page that
 * needs a query is a 404 page that fails with the thing it reports on, and
 * the root one runs precisely when the `[locale]` layout did not. That is why
 * it carries no site header (the header reads settings and the session), and
 * links to the two places a lost visitor most likely wanted instead.
 *
 * Plain links, not next-intl's: the root page renders outside the locale
 * provider, and Arabic is served without a prefix (`localePrefix:
 * 'as-needed'`), so `/` and `/search` are the right addresses from both.
 */
export function NotFoundContent() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center gap-6 px-5 py-16">
      <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-5">
        <p className="font-mono text-sm text-[var(--color-ink-faint)]">404</p>
        <h1 className="mt-1 text-xl font-bold">الصفحة غير موجودة</h1>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          لم نجد ما تبحث عنه. ربما تغيّر الرابط أو أُزيلت الصفحة، أو كُتب العنوان بشكل مختلف.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link
          href="/"
          className="flex-1 rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-center text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90"
        >
          الصفحة الرئيسية
        </Link>
        <Link
          href="/search"
          className="flex-1 rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-5 py-2.5 text-center text-sm font-semibold transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          البحث في الموارد
        </Link>
      </div>
    </main>
  );
}
