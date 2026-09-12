import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { MarkAllReadButton, MarkOneReadButton } from '@/components/notification-forms';
import { requireActor } from '@/auth/current';
import { myNotifications } from '@/notifications/queries';
import { renderNotification } from '@/notifications/render';

export const dynamic = 'force-dynamic';

const TONE_CLASSES: Readonly<Record<string, string>> = {
  good: 'border-r-2 border-r-[var(--color-accent)]',
  warn: 'border-r-2 border-r-[var(--color-warn)]',
  neutral: 'border-r-2 border-r-[var(--color-line-strong)]',
};

/**
 * The recipient's own notifications (specification §33).
 *
 * This page is why the messages the rest of the system writes are worth
 * writing: an engineer is told about every sale of their work here, and the
 * monthly statement is announced here too.
 *
 * There is no recipient parameter — not in the path, not in a query string.
 * The list is whatever the row-level policy returns for whoever is signed in.
 */
export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireActor('/account/notifications');
  const rows = await myNotifications(actor, { limit: 100 });
  const unread = rows.filter((row) => row.readAt === null);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-10">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold">الإشعارات</h1>
            <p className="text-sm text-[var(--color-ink-soft)]">
              {unread.length > 0
                ? `${unread.length} غير مقروء`
                : 'لا جديد.'}
            </p>
          </div>
          <MarkAllReadButton count={unread.length} />
        </header>

        {rows.length === 0 ? (
          <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] px-4 py-10 text-center text-sm text-[var(--color-ink-faint)]">
            لا توجد إشعارات بعد.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const message = renderNotification(row.type, row.payload);
              const isUnread = row.readAt === null;

              return (
                <li
                  key={row.id}
                  className={`flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-[var(--color-line)] px-4 py-3 ${
                    TONE_CLASSES[message.tone] ?? ''
                  } ${isUnread ? 'bg-[var(--color-surface)]' : ''}`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className={`text-sm ${isUnread ? 'font-semibold' : ''}`}>
                      {message.href ? (
                        <Link href={message.href} className="hover:text-[var(--color-accent-ink)]">
                          {message.title}
                        </Link>
                      ) : (
                        message.title
                      )}
                    </span>
                    <time
                      dateTime={row.createdAt.toISOString()}
                      className="technical-term text-xs tabular-nums text-[var(--color-ink-faint)]"
                    >
                      {row.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </time>
                  </div>

                  {message.detail ? (
                    <p className="text-xs text-[var(--color-ink-soft)]">{message.detail}</p>
                  ) : null}

                  {isUnread ? <MarkOneReadButton notificationId={row.id} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
