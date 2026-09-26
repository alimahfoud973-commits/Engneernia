/**
 * The root layout, deliberately empty (D1).
 *
 * The document — `<html lang dir>`, fonts, stylesheet, messages — belongs to
 * `[locale]/layout.tsx`, because language and direction come from the URL.
 * This file exists only because Next needs a layout at the root for the root
 * `not-found.tsx` to exist, and without that every unmatched URL (`/a/b/c`)
 * and every `notFound()` raised by the `[locale]` layout itself (`/en/x`)
 * fell through to Next's built-in English page.
 *
 * It renders nothing of its own, so no existing page changes: each one still
 * gets its whole document from the `[locale]` layout. The two pages that
 * cannot rely on that layout — `not-found.tsx` and `global-error.tsx` here —
 * render their own `<html>`.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
