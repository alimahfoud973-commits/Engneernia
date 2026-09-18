import Link from 'next/link';

/**
 * Navigation between the owner's screens.
 *
 * A convenience, never a control. Each page behind these links calls
 * `requireOwner` and each service behind it re-checks the actor — removing
 * this component would change what the owner can find, not what anyone can do.
 */
const LINKS = [
  { href: '/admin/products', label: 'الكتالوج' },
  { href: '/admin/payments', label: 'المدفوعات' },
  { href: '/admin/settlements', label: 'التسوية الشهرية' },
  { href: '/admin/commissions', label: 'اتفاقات العمولة' },
  { href: '/admin/finance', label: 'التقرير المالي' },
  { href: '/admin/adjustments', label: 'قيود التصحيح' },
] as const;

export function AdminNav({ current }: { current: string }) {
  return (
    <nav className="flex flex-wrap gap-2 border-b border-[var(--color-line)] pb-4">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={link.href === current ? 'page' : undefined}
          className={`rounded-[var(--radius-card)] px-3 py-1.5 text-sm transition-colors ${
            link.href === current
              ? 'bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent-ink)]'
              : 'text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]'
          }`}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
