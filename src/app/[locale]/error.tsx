'use client';

import { ErrorContent } from '@/components/error-content';

/**
 * The error boundary for every page under `[locale]` (D1).
 *
 * It renders inside the `[locale]` layout, so the document keeps its `lang`,
 * `dir`, fonts and stylesheet. It does NOT catch an error in that layout
 * itself — an error boundary never wraps the layout of its own segment — so
 * that case is `global-error.tsx`.
 */
export default function LocaleError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorContent retry={retry} />;
}
