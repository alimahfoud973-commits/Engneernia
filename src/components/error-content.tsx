'use client';

/**
 * What every unhandled error on the platform says (D1).
 *
 * Shared by `[locale]/error.tsx` (a page failed, the layout stands) and
 * `global-error.tsx` (the layout itself failed — for instance the database is
 * down, since the layout's metadata reads settings), so the two cannot drift.
 *
 * It reads nothing and shows nothing about the error. In production Next
 * replaces a server error's message with a generic one anyway; this page does
 * not print even that, nor the digest: the digest matches the server log, and
 * the server log is where an error is investigated — the same line
 * `toUserMessage` draws for server actions.
 *
 * "Home" is a plain anchor, not a client-side link: after an error the
 * client's state is the thing in doubt, and a full load is the recovery that
 * does not depend on it.
 */
export function ErrorContent({ retry }: { retry: () => void }) {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center gap-6 px-5 py-16">
      <div className="rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-5">
        <h1 className="text-xl font-bold">تعذّر عرض هذه الصفحة</h1>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          حدث خطأ من جهتنا، لا بسبب شيء فعلته. حاول مرة أخرى بعد لحظات، وإن تكرّر فعُد
          إلى الصفحة الرئيسية.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={() => retry()}
          className="flex-1 rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-center text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90"
        >
          حاول مرة أخرى
        </button>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full load is the point; see above. */}
        <a
          href="/"
          className="flex-1 rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-5 py-2.5 text-center text-sm font-semibold transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          الصفحة الرئيسية
        </a>
      </div>
    </main>
  );
}
