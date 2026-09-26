import { IBM_Plex_Sans_Arabic, IBM_Plex_Mono } from 'next/font/google';

/**
 * The platform's two faces, declared once.
 *
 * Three documents carry them: the `[locale]` layout, and the two pages that
 * render their own `<html>` because they must not depend on that layout —
 * the root 404 and the global error page (D1). Declaring the fonts in each
 * would load three copies of the same files.
 *
 * IBM Plex Sans Arabic carries both Arabic and Latin glyphs from one
 * superfamily, which keeps English engineering terms inside Arabic copy
 * visually consistent rather than falling back to an unrelated face.
 */
export const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-arabic',
  display: 'swap',
});

export const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

/** The class list a `<body>` needs for both variables to resolve. */
export const fontVariables = `${plexArabic.variable} ${plexMono.variable}`;
