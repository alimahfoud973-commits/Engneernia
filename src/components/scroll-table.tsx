import type { ReactNode } from 'react';

/**
 * A table too wide for a phone, made usable there (S5-10).
 *
 * The table keeps its columns and scrolls sideways inside its own box — the
 * page itself never scrolls horizontally (`scripts/layout-check.mjs`). What
 * was missing is that nothing SAID so: a cut-off last column looked like the
 * whole table. Below the `sm` breakpoint a line under the table says it
 * scrolls, and the box is focusable so a keyboard reaches its last column.
 */
export function ScrollTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
        {children}
      </div>
      <p className="text-xs text-[var(--color-ink-faint)] sm:hidden">
        اسحب الجدول أفقياً لعرض بقية الأعمدة.
      </p>
    </div>
  );
}
