import Link from 'next/link';
import { getPublicSettings } from '@/platform/settings';
import { BrandMark } from '@/components/brand-mark';
import { currentActor } from '@/auth/current';
import { isOwner, type Actor } from '@/authz/actor';
import { unreadNotificationCount } from '@/notifications/queries';
import { navDisciplines } from '@/catalog/public-queries';

/**
 * The header's way in: sign-in for a visitor, the account for anyone signed
 * in. Same test as the notifications link, so the two cannot disagree. A
 * session still owing its second factor counts as signed in; `/account` sends
 * it to the challenge, which is the step it actually has to take.
 */
export function accountEntry(actor: Actor): { href: '/login' | '/account'; label: string } {
  return actor.kind === 'USER'
    ? { href: '/account', label: 'الحساب' }
    : { href: '/login', label: 'تسجيل الدخول' };
}

/**
 * The brand comes from the settings table, not from a constant, so the owner
 * can rename the platform without a deploy (OPEN-8).
 */
export async function SiteHeader() {
  const settings = await getPublicSettings();
  // Read from the `disciplines` table, never listed here (D3): the owner adds,
  // renames, disables and reorders disciplines as data.
  const disciplineNav = await navDisciplines();

  // A signed-in visitor needs to know a sale happened without hunting for it.
  // `currentActor` is request-cached, and the count swallows its own failures,
  // so this costs one query and cannot take the header down.
  const actor = await currentActor();
  const unread = await unreadNotificationCount(actor);
  const signedIn = actor.kind === 'USER';
  // The same predicate `requireOwner` applies, so the link and the gate cannot
  // disagree. It is rendered on the server: for anyone else it is not hidden,
  // it is absent from the response.
  const owner = isOwner(actor);
  const entry = accountEntry(actor);

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[var(--color-surface)]/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
        <Link href="/" className="flex items-center gap-2 font-bold">
          <BrandMark className="h-7 w-7 shrink-0" />
          <span className="text-base">{settings.platformNameAr}</span>
        </Link>

        <nav aria-label="التخصصات" className="flex flex-wrap items-center gap-1 text-sm">
          {disciplineNav.map((item) => (
            <Link
              key={item.slug}
              href={`/${item.slug}`}
              className="rounded-sm px-2.5 py-1.5 text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
            >
              {item.nameAr}
            </Link>
          ))}
        </nav>

        <Link
          href={entry.href}
          className="order-last rounded-sm px-2.5 py-1.5 text-sm font-semibold text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-surface-muted)] sm:order-none"
        >
          {entry.label}
        </Link>

        {signedIn ? (
          <Link
            href="/account/notifications"
            className="order-last flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-sm text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)] sm:order-none"
          >
            <span>الإشعارات</span>
            {unread > 0 ? (
              <span
                aria-label={`${unread} إشعاراً غير مقروء`}
                className="technical-term inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-[var(--color-accent-contrast)]"
              >
                {unread}
              </span>
            ) : null}
          </Link>
        ) : null}

        {owner ? (
          <Link
            href="/admin"
            className="order-last rounded-sm px-2.5 py-1.5 text-sm text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)] sm:order-none"
          >
            لوحة الإدارة
          </Link>
        ) : null}

        <form action="/search" className="ms-auto flex min-w-[220px] flex-1 items-center gap-2">
          <label htmlFor="site-search" className="sr-only">
            ابحث في الموارد الهندسية
          </label>
          <input
            id="site-search"
            name="q"
            type="search"
            placeholder="ابحث في الموارد الهندسية"
            className="w-full rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-ground)] px-3 py-1.5 text-sm outline-none transition-colors focus:border-[var(--color-accent)]"
          />
        </form>
      </div>
    </header>
  );
}

export async function SiteFooter() {
  const settings = await getPublicSettings();

  return (
    <footer className="mt-16 border-t border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-5 py-8 text-sm text-[var(--color-ink-soft)]">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-[var(--color-ink)]">{settings.platformNameAr}</p>
            <p className="technical-term text-xs text-[var(--color-ink-faint)]">
              {settings.platformName}
            </p>
          </div>
          <nav aria-label="روابط" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <Link href="/search" className="hover:text-[var(--color-ink)]">
              تصفّح الموارد
            </Link>
            <Link href="/search?price=free" className="hover:text-[var(--color-ink)]">
              الموارد المجانية
            </Link>
          </nav>
        </div>

        <p className="max-w-prose text-xs leading-relaxed text-[var(--color-ink-faint)]">
          النشر على المنصة يتم باعتماد من إدارتها. إن كانت لديك موارد هندسية عالية الجودة،
          تواصل معنا لتصبح أحد المهندسين المساهمين.
        </p>
      </div>
    </footer>
  );
}
