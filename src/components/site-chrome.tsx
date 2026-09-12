import Link from 'next/link';

const DISCIPLINE_NAV = [
  { slug: 'electrical', label: 'كهربائية' },
  { slug: 'civil', label: 'مدنية' },
  { slug: 'architecture', label: 'معمارية' },
  { slug: 'mechanical', label: 'ميكانيكية' },
] as const;

export function SiteHeader() {
  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
        <Link href="/" className="flex items-center gap-2 font-bold">
          <span
            aria-hidden
            className="inline-block h-6 w-6 rounded-sm bg-[var(--color-accent)]"
          />
          <span className="text-base">منصة الموارد الهندسية</span>
        </Link>

        <nav aria-label="التخصصات" className="flex flex-wrap items-center gap-1 text-sm">
          {DISCIPLINE_NAV.map((item) => (
            <Link
              key={item.slug}
              href={`/${item.slug}`}
              className="rounded-sm px-2.5 py-1.5 text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <form action="/search" className="ms-auto flex min-w-[220px] flex-1 items-center gap-2">
          <label htmlFor="site-search" className="sr-only">
            ابحث في الموارد الهندسية
          </label>
          <input
            id="site-search"
            name="q"
            type="search"
            placeholder="ابحث في الموارد الهندسية"
            className="w-full rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-ground)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </form>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 text-sm text-[var(--color-ink-soft)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="font-semibold text-[var(--color-ink)]">منصة الموارد الهندسية</p>
          <p className="text-xs text-[var(--color-ink-faint)]">
            المرحلة <span className="technical-term">P2</span> — الكتالوج والتصنيفات
          </p>
        </div>
        <p className="max-w-prose text-xs leading-relaxed text-[var(--color-ink-faint)]">
          هل لديك موارد هندسية عالية الجودة؟ النشر على المنصة يتم باعتماد من إدارتها —
          تواصل معنا لتصبح أحد المهندسين المساهمين.
        </p>
      </div>
    </footer>
  );
}
