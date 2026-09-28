/**
 * ===========================================================================
 * A SUBSCRIBER'S PHONE NUMBER (Stage 6)
 * ===========================================================================
 * The phone identifies a subscriber — at registration, and together with the
 * email at sign-in — so it is stored in exactly one form, E.164 (`+9639…`),
 * and the database refuses any other (`users_phone_e164`, migration 0064).
 * One stored form is what makes the unique index mean "one account per
 * number" rather than "one account per way of typing it".
 *
 * What is forgiven, because people type numbers the way their phone shows
 * them:
 *   - Arabic-Indic digits (٠-٩) and Persian ones (۰-۹) are read as digits;
 *   - spaces, dashes, dots, brackets and direction marks are ignored;
 *   - a leading "00" is the international prefix and becomes "+".
 *
 * What is NOT guessed (owner decision): a number without "+" or "00" carries
 * no country code, so "0933…" or "933…" is refused rather than assumed to be
 * Syrian. Choosing a country for someone would bind the account to a number
 * that may not be theirs.
 *
 * Pure, so the form, the server action and the tests share one rule.
 * ===========================================================================
 */

const ARABIC_INDIC = /[٠-٩۰-۹]/g;
const SEPARATORS = /[\s\-.() ‎‏‪-‮⁦-⁩]/g;
const E164 = /^\+[1-9]\d{7,14}$/;

/** The number in E.164, or null when it cannot be one. */
export function normalizePhone(raw: string): string | null {
  const compact = raw
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) & 0xf))
    .replace(SEPARATORS, '');
  const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return E164.test(international) ? international : null;
}
