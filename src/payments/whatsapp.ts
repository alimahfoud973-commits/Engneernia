/**
 * ===========================================================================
 * WHATSAPP CONTACT (specification §23 — Stage 2 audit, W2)
 * ===========================================================================
 * One rule for what a WhatsApp number is, shared by the owner's settings
 * screen (which stores it) and checkout (which links to it). Pure, so it is
 * testable without a database — and so the screen cannot accept a number the
 * checkout would then turn into a broken link.
 *
 * WhatsApp is a way to REACH the platform, not an account money goes to, so
 * the number is always read from settings at the moment a link is built —
 * never copied onto an order (owner decision on W2).
 * ===========================================================================
 */

/** Used when the owner has not written a message of their own. */
export const DEFAULT_WHATSAPP_TEMPLATE =
  'مرحباً، أرغب بشراء:\n{{items}}\nرقم الطلب: {{order}}\nالمبلغ: {{amount}} {{currency}}';

const ARABIC_INDIC = /[٠-٩۰-۹]/g;

/**
 * A number as wa.me needs it — the international number in digits, with no
 * "+", no "00" and no separators — or null when it cannot be one.
 *
 *   - Arabic-Indic digits are read as digits; spaces, dashes, dots, brackets
 *     and direction marks are ignored.
 *   - A leading "+" or "00" is the international prefix and is dropped.
 *   - What remains must be 8 to 15 digits (E.164 allows at most 15) and must
 *     not start with 0. A leading 0 is a local trunk prefix: "0933…" carries
 *     no country code, and wa.me/0933… reaches nobody.
 */
export function normalizeWhatsappNumber(raw: string): string | null {
  const compact = raw
    .replace(ARABIC_INDIC, (d) => String((d.charCodeAt(0) & 0xf)))
    .trim()
    .replace(/[\s\-.()‎‏‪-‮]/g, '');
  const digits = compact.startsWith('+')
    ? compact.slice(1)
    : compact.startsWith('00')
      ? compact.slice(2)
      : compact;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/** Minor units → "25.00". Two decimals: every currency the platform prices in has two. */
export function formatMajor(amountMinor: bigint): string {
  const whole = amountMinor / 100n;
  const fraction = amountMinor % 100n;
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

export interface WhatsappMessageValues {
  readonly items: readonly string[];
  readonly order: string;
  readonly amountMinor: bigint;
  readonly currency: string;
}

/** Fill every occurrence of each placeholder, not only the first. */
export function fillWhatsappTemplate(template: string, values: WhatsappMessageValues): string {
  return template
    .replaceAll('{{items}}', values.items.join('، '))
    .replaceAll('{{order}}', values.order)
    .replaceAll('{{amount}}', formatMajor(values.amountMinor))
    .replaceAll('{{currency}}', values.currency);
}

/** The chat link. `number` must already be normalised. */
export function whatsappLink(number: string, message: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
