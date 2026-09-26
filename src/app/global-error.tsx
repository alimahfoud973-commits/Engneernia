'use client';

import { ErrorContent } from '@/components/error-content';
import { fontVariables } from './fonts';
import './globals.css';

/**
 * The last error boundary: it replaces the whole document when the
 * `[locale]` layout itself fails (D1).
 *
 * The case that matters is the database being unreachable. The layout's
 * metadata reads the platform settings, so every page fails in the layout,
 * above `[locale]/error.tsx`, and before this file existed the visitor got
 * Next's built-in English page with no language, direction or styling.
 *
 * It renders its own `<html>`, and Arabic and right-to-left are written here:
 * the layout that would have said so is the thing that failed. Client
 * components cannot export metadata, so the title is React's `<title>`.
 */
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="ar" dir="rtl">
      <body className={fontVariables}>
        <title>تعذّر عرض الصفحة</title>
        <ErrorContent retry={retry} />
      </body>
    </html>
  );
}
