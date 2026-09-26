import { NotFoundContent } from '@/components/not-found-content';

/**
 * The 404 for every `notFound()` raised by a page under `[locale]` — a
 * missing product, engineer, discipline or order, and a malformed id (D1).
 *
 * It renders inside the `[locale]` layout, so the document already carries
 * `lang`, `dir`, the fonts and the stylesheet. Next keeps the 404 status and
 * adds `noindex` itself.
 */
export default function LocaleNotFound() {
  return <NotFoundContent />;
}
