/**
 * The Enginora mark, inline.
 *
 * Inline rather than an <img>, for two reasons that both matter in a header
 * rendered on every page: it costs no second request, and it can be painted
 * from the theme tokens, so the same drawing is a muted gold on the light
 * ground and a bright gold on the dark one without shipping two files.
 *
 * No literal colour appears here — that is the project rule, and it is also
 * what makes the mark survive the dark palette. `src/app/icon.svg` is the
 * same geometry with literal colours, because a browser tab cannot read a
 * stylesheet; the two must be changed together.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      focusable="false"
      className={className}
    >
      <path
        d="M62.62 27.15 L62.62 36.85 L57.46 37.27 L55.70 42.70 L59.62 46.07 L53.92 53.92 L49.50 51.23 L44.88 54.58 L46.07 59.62 L36.85 62.62 L34.85 57.84 L29.15 57.84 L27.15 62.62 L17.93 59.62 L19.12 54.58 L14.50 51.23 L10.08 53.92 L4.38 46.07 L8.30 42.70 L6.54 37.27 L1.38 36.85 L1.38 27.15 L6.54 26.73 L8.30 21.30 L4.38 17.93 L10.08 10.08 L14.50 12.77 L19.12 9.42 L17.93 4.38 L27.15 1.38 L29.15 6.16 L34.85 6.16 L36.85 1.38 L46.07 4.38 L44.88 9.42 L49.50 12.77 L53.92 10.08 L59.62 17.93 L55.70 21.30 L57.46 26.73 Z M32 54.0 A22.0 22.0 0 1 0 32 10.0 A22.0 22.0 0 1 0 32 54.0 Z"
        fill="var(--color-accent)"
        fillRule="evenodd"
      />
      <path
        d="M32 19.5 L46 45 L39.6 45 L37.0 39.2 L27.0 39.2 L24.4 45 L18 45 Z M32 27.5 L29.1 34.6 L34.9 34.6 Z"
        fill="var(--color-ink)"
        fillRule="evenodd"
      />
      <path d="M37.5 20.5 L27.6 34.2 L31.8 34.2 L26.4 45.5 L36.6 32.2 L32.4 32.2 Z" fill="var(--color-accent)" />
    </svg>
  );
}
