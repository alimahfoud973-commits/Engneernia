import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ===========================================================================
 * THE THEME'S STRUCTURE
 * ===========================================================================
 * Three different, plausible-looking ways of writing the dark palette were
 * tried here, and all three were WRONG in the browser while looking right in
 * the file:
 *
 *   `@theme` nested inside `@media` — hoisted out by Tailwind v4, so the dark
 *     values applied to everyone. Measured: light and dark contexts both
 *     resolved --color-ground to #0b0b0a.
 *   `:root` inside `@media` — same specificity as the `:root` Tailwind emits
 *     for `@theme`, which lands later and wins. The media query matched and
 *     changed nothing.
 *   `light-dark()` inside `@theme` — resolved statically to the light branch
 *     at build time; the dark value never reached the browser.
 *
 * None of that is visible to a type checker, a linter, or any other test in
 * this project — the symptom is a colour. So the structure is asserted here,
 * cheaply, against the source file.
 * ===========================================================================
 */

const CSS = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** The `@theme` block, which defines the light values and the utilities. */
function themeBlock(): string {
  const start = CSS.indexOf('@theme {');
  expect(start, '@theme block is missing').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error('@theme block is unterminated');
}

function darkBlock(): string {
  const start = CSS.indexOf('@media (prefers-color-scheme: dark)');
  expect(start, 'dark-mode media query is missing').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error('dark-mode block is unterminated');
}

function tokensIn(block: string): string[] {
  return [...block.matchAll(/--(color-[a-z-]+)\s*:/g)].map((match) => match[1]!);
}

describe('the dark palette is actually conditional', () => {
  it('does not nest @theme inside a media query', () => {
    // Tailwind v4 hoists it, and the dark values then apply to everyone.
    expect(darkBlock()).not.toContain('@theme');
  });

  it('uses a selector that outranks the :root @theme emits', () => {
    // `:root` alone is (0,1,0) and loses on source order. `:root:root` is
    // (0,2,0) and wins regardless of where Tailwind places its own block.
    expect(darkBlock()).toContain(':root:root');
  });

  it('does not use light-dark() inside @theme', () => {
    // Resolved statically to the light branch at build time.
    expect(themeBlock()).not.toContain('light-dark(');
  });

  it('declares color-scheme on the root element', () => {
    expect(CSS).toMatch(/html\s*\{[^}]*color-scheme:\s*light dark/);
  });
});

describe('every colour has both a light and a dark value', () => {
  it('no token is defined in one scheme only', () => {
    const light = tokensIn(themeBlock());
    const dark = tokensIn(darkBlock());

    expect(light.length).toBeGreaterThan(10);

    // A token with no dark value keeps its light value on a black page —
    // which is how a palette ends up with white-on-white somewhere nobody
    // looked.
    const missingDark = light.filter((token) => !dark.includes(token));
    expect(missingDark, `tokens with no dark value: ${missingDark.join(', ')}`).toEqual([]);

    const orphanDark = dark.filter((token) => !light.includes(token));
    expect(orphanDark, `dark tokens with no light value: ${orphanDark.join(', ')}`).toEqual([]);
  });

  it('defines the contrast colour buttons sit under', () => {
    // Components used to hardcode `text-white`, which is 2.1:1 on the dark
    // mode's bright gold. The token exists so a palette swap cannot reintroduce
    // that.
    expect(tokensIn(themeBlock())).toContain('color-accent-contrast');
  });
});

describe('components read tokens, never literal colours', () => {
  it('no component hardcodes text-white on an accent background', async () => {
    const { globSync } = await import('node:fs');
    const files = [...globSync('src/**/*.tsx', { cwd: process.cwd() })];
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      if (/\btext-white\b/.test(source)) offenders.push(file);
    }

    expect(
      offenders,
      `these hardcode text-white instead of --color-accent-contrast: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
