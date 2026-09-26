/**
 * =============================================================================
 * NO PAGE SCROLLS SIDEWAYS
 * =============================================================================
 *   node scripts/layout-check.mjs [base-url]
 *
 * This guards a defect no unit test can reach, because it is not a property of
 * any module: it is a property of a laid-out page in a real browser.
 *
 * The register page shipped 10,389 pixels wide on a 390-pixel phone. The cause
 * was the ordinary off-screen idiom for a honeypot field,
 * `position:absolute; left:-9999px`, which is written for a left-to-right
 * page — there, content pushed past the left edge is unreachable and the
 * browser discards it. This site is right-to-left, so leftward is the
 * scrolling direction and those 9,999 pixels became real, scrollable page.
 *
 * Nothing caught it. The page rendered, every element was in its right place,
 * 528 unit tests passed, and the production build was clean. It was found by
 * screenshotting the site to show the owner, and noticing the image was eight
 * times too wide.
 *
 * Run it against a production build after any work that touches layout.
 * =============================================================================
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? process.env.PROBE_BASE_URL ?? 'http://localhost:3111';
const CHROME = process.env.PROBE_CHROMIUM ?? undefined;

/** Both ends of the range: a phone, and a wide desktop. */
const WIDTHS = [390, 1360];

const PATHS = [
  '/ar',
  '/ar/register',
  '/ar/login',
  '/ar/search?q=',
  '/ar/civil',
  // Arabic only: `routing.locales` in src/i18n/routing.ts lists one locale, so
  // /en is a correct 404 rather than a page to measure. Add the English paths
  // here the day that list grows — RTL is where this class of defect lives,
  // but a page can overflow in either direction.
];

/**
 * The platform's own 404 page (D1), measured like any other page: it is the
 * page a mistyped link lands on, so it is seen on phones as often as any. One
 * path through each of its two documents — the root one, which renders its
 * own `<html>`, and the one inside the `[locale]` layout. A 404 is the
 * expected answer here; anything else fails.
 */
const NOT_FOUND_PATHS = ['/a/b/c', '/ar/products/no-such-product'];
const EXPECTED_STATUS = new Map(NOT_FOUND_PATHS.map((path) => [path, 404]));

/**
 * One pixel of slack, and no more. Sub-pixel rounding can add a fraction; a
 * threshold generous enough to hide a stray element is a threshold that lets
 * this defect back in.
 */
const SLACK = 1;

let failures = 0;

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

for (const width of WIDTHS) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ar' });
  const page = await context.newPage();

  for (const path of [...PATHS, ...NOT_FOUND_PATHS]) {
    let measured;
    try {
      const response = await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 45_000 });
      const expected = EXPECTED_STATUS.get(path);
      if (!response || (expected ? response.status() !== expected : response.status() >= 400)) {
        console.log(`  FAIL  ${width}px ${path} — HTTP ${response ? response.status() : 'no response'}`);
        failures += 1;
        continue;
      }
      measured = await page.evaluate(() => {
        const root = document.documentElement;
        // The widest offenders, named, so the failure says what to fix rather
        // than only that something is wrong.
        const offenders = [...document.querySelectorAll('*')]
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => rect.right > window.innerWidth + 1 || rect.left < -1)
          .slice(0, 3)
          // Math.trunc, not Math.round: the lint rule bans Math.round across the
          // repository so that no money is ever rounded by accident. These are
          // pixel coordinates in a diagnostic line, and truncation reads the same.
          .map(({ el, rect }) =>
            `<${el.tagName.toLowerCase()} class="${(el.className || '').toString().slice(0, 70)}"> `
            + `left=${Math.trunc(rect.left)} right=${Math.trunc(rect.right)}`);
        return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, offenders };
      });
    } catch (error) {
      console.log(`  FAIL  ${width}px ${path} — ${error.message.split('\n')[0]}`);
      failures += 1;
      continue;
    }

    const overflow = measured.scrollWidth - measured.clientWidth;
    if (overflow > SLACK) {
      console.log(
        `  FAIL  ${width}px ${path} — scrolls ${overflow}px sideways `
        + `(page ${measured.scrollWidth}px in a ${measured.clientWidth}px viewport)`,
      );
      for (const offender of measured.offenders) console.log(`          ${offender}`);
      failures += 1;
    } else {
      console.log(`  PASS  ${width}px ${path}`);
    }
  }

  await context.close();
}

await browser.close();

if (failures > 0) {
  console.log(`\n${failures} page(s) scroll sideways.\n`);
  process.exit(1);
}
console.log('\nNo page scrolls sideways.\n');
