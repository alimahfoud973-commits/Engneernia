import 'server-only';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { GlobalFonts } from '@napi-rs/canvas';

/**
 * ===========================================================================
 * ARABIC TYPOGRAPHY ON THE SERVER
 * ===========================================================================
 * The platform's primary language is Arabic, so anything the server DRAWS —
 * a settlement statement, a preview watermark — has to shape Arabic properly:
 * letters joined, rendered right to left, with the correct contextual forms.
 *
 * Two facts decided the approach:
 *
 *   1. pdf-lib CANNOT do this. It embeds a font and places glyphs, with no
 *      shaping engine, so Arabic comes out as disconnected isolated letters
 *      in visual reverse — worse than useless on a financial document.
 *
 *   2. @napi-rs/canvas CAN. It draws through Skia, which shapes text with
 *      HarfBuzz. Give it a font with Arabic glyphs and it produces correct
 *      joined text, including bidirectional runs.
 *
 * So every Arabic page in this project is DRAWN on a canvas and then placed
 * into a PDF as an image. That is the same technique the preview pipeline
 * already uses, for a different reason, and it is why the statement PDF has
 * no selectable text layer — an acceptable trade for a document that must be
 * readable in Arabic at all.
 *
 * The font is Noto Naskh Arabic (SIL Open Font License), vendored in
 * `assets/fonts/` rather than fetched at runtime: a server that cannot reach
 * the internet must still be able to issue an engineer their statement.
 * ===========================================================================
 */

export const ARABIC_FONT = 'NotoNaskhAr';
export const ARABIC_FONT_BOLD = 'NotoNaskhArBold';

/** Latin fallback for references and figures, which read better unshaped. */
export const LATIN_FONT = 'sans-serif';

/**
 * The directory is a literal and only the FILE NAME varies.
 *
 * Written this way for the bundler, not for tidiness. With the whole path in
 * the variable, Turbopack cannot tell which files are reached and warns that
 * "this filesystem access causes tracing of the whole project" — which means
 * every source file, and the public folder, shipped inside the server bundle.
 * A statically scoped directory lets it trace just this folder.
 */
const FONT_DIR = 'assets/fonts';

const FONT_FILES = [
  { file: 'NotoNaskhArabic-Regular.ttf', family: ARABIC_FONT },
  { file: 'NotoNaskhArabic-Bold.ttf', family: ARABIC_FONT_BOLD },
] as const;

let registered: boolean | null = null;

/**
 * Register the Arabic faces once per process.
 *
 * Returns whether the fonts are actually available. A caller that gets `false`
 * must NOT silently draw boxes across a document — see `assertArabicFonts`.
 */
export function registerArabicFonts(): boolean {
  if (registered !== null) return registered;

  registered = FONT_FILES.every(({ file, family }) => {
    const absolute = join(process.cwd(), FONT_DIR, file);
    if (!existsSync(absolute)) return false;
    return GlobalFonts.registerFromPath(absolute, family);
  });

  return registered;
}

/**
 * For documents where unreadable Arabic is not an acceptable outcome.
 *
 * A settlement statement full of empty boxes is worse than an error: the
 * engineer would receive it, be unable to read it, and have no idea whether
 * the numbers on it were even right.
 */
export function assertArabicFonts(): void {
  if (!registerArabicFonts()) {
    throw new Error(
      'Arabic fonts are missing from assets/fonts — cannot render an Arabic document. '
      + 'Expected NotoNaskhArabic-Regular.ttf and NotoNaskhArabic-Bold.ttf.',
    );
  }
}

/**
 * Isolate a run so bidirectional reordering leaves it alone.
 *
 * Without this, "SEP-2026-CIVIL" inside an Arabic line is re-ordered by the
 * bidi algorithm and a reader sees the parts in the wrong order — technically
 * correct rendering of a string that is not natural-language text. The same
 * applies to a period key like "2026-09", which otherwise displays as
 * "09-2026".
 *
 * U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE.
 */
export function ltr(value: string): string {
  return `⁦${value}⁩`;
}

/**
 * Arabic-Indic digits, for body text where they read more naturally.
 *
 * NOT used for money or references: a figure an engineer may need to quote in
 * a bank transfer, or type into a search box, should be in the digits their
 * keyboard produces.
 */
export function arabicDigits(value: string): string {
  return value.replace(/[0-9]/g, (digit) => '٠١٢٣٤٥٦٧٨٩'[Number(digit)]!);
}
