/**
 * ===========================================================================
 * SAYING "WAIT THIS LONG" IN ARABIC
 * ===========================================================================
 * Arabic does not pluralise the way an English template does. The noun after a
 * number changes form by the number's VALUE, in four bands, and getting it
 * wrong produces text that reads as machine-translated — on the sign-in
 * screen, which is the first thing a locked-out customer sees.
 *
 *   1   → singular, with the word "one"     دقيقة واحدة
 *   2   → the dual form                     دقيقتان
 *   3–10→ the plural of paucity             ٥ دقائق
 *   11+ → back to the singular              ١٥ دقيقة
 *
 * Lives in its own module, not inside the `'use server'` action file that uses
 * it: such a file may export nothing but async functions, and a helper worth
 * unit-testing has to be exported to be reached.
 * ===========================================================================
 */

interface Forms {
  readonly one: string;
  readonly two: string;
  readonly few: string;
  readonly many: string;
}

const SECONDS: Forms = {
  one: 'ثانية واحدة',
  two: 'ثانيتين',
  few: 'ثوانٍ',
  many: 'ثانية',
};

const MINUTES: Forms = {
  one: 'دقيقة واحدة',
  two: 'دقيقتين',
  few: 'دقائق',
  many: 'دقيقة',
};

function countWith(count: number, forms: Forms): string {
  if (count === 1) return forms.one;
  if (count === 2) return forms.two;
  if (count >= 3 && count <= 10) return `${count} ${forms.few}`;
  return `${count} ${forms.many}`;
}

/**
 * A wait, rounded up, in the largest unit that does not lose the point.
 *
 * Rounded UP on purpose: telling someone to wait slightly longer than
 * necessary costs them one refreshed page, telling them to come back too early
 * costs them another refusal and the belief that the site is broken.
 */
export function waitLabelAr(seconds: number): string {
  const safe = Math.max(1, Math.ceil(seconds));
  if (safe < 60) return countWith(safe, SECONDS);
  return countWith(Math.ceil(safe / 60), MINUTES);
}
