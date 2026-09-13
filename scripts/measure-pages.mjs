/**
 * ===========================================================================
 * WHAT EACH PAGE COSTS
 * ===========================================================================
 *   node scripts/measure-pages.mjs [baseUrl]
 *
 * For every public page: how long the server takes, how many bytes it sends,
 * and — the part that matters — HOW MANY DATABASE QUERIES it runs and how many
 * rows those touch.
 *
 * The query count is what finds an N+1. A page that runs one query per product
 * card is indistinguishable from a fast one on a seeded laptop with twelve
 * products; at five thousand it is the difference between a site and a
 * slideshow. Counting rather than timing makes it visible immediately.
 *
 * Counts come from pg_stat_statements, reset before each page and read after,
 * so they are the database's own accounting and not an instrumented client.
 * Needs the extension loaded:
 *   shared_preload_libraries = 'pg_stat_statements'
 * ===========================================================================
 */
import postgres from 'postgres';

process.loadEnvFile('.env.local');
const BASE = process.argv[2] ?? 'http://localhost:3111';
const sql = postgres(process.env.DATABASE_SUPERUSER_URL, { max: 2, onnotice: () => {} });

const PAGES = [
  ['home', '/'],
  ['discipline portal', '/civil'],
  ['product detail', process.env.MEASURE_PRODUCT_PATH ?? '/products/scale-4625'],
  ['search, no query', '/search'],
  ['search, term', '/search?q=%D8%AA%D8%AD%D9%84%D9%8A%D9%84'],
  ['search, facets', '/search?discipline=civil&fileTypes=PDF&price=paid&sort=newest'],
  ['search, deep page', '/search?page=40'],
  ['sitemap', '/sitemap.xml'],
];

// One warm run per page first: the first hit pays for connection setup and
// query planning, and reporting that as the page's cost would be a lie.
for (const [, path] of PAGES) await fetch(BASE + path).then((r) => r.arrayBuffer());

console.log(
  'page'.padEnd(20) + 'ms'.padStart(7) + 'KB'.padStart(9) + 'queries'.padStart(9) + 'rows'.padStart(9),
);
console.log('-'.repeat(54));

const results = [];
for (const [label, path] of PAGES) {
  await sql`SELECT pg_stat_statements_reset()`;

  const started = performance.now();
  const response = await fetch(BASE + path);
  const body = await response.arrayBuffer();
  const ms = performance.now() - started;

  const [stats] = await sql`
    SELECT COALESCE(SUM(calls), 0)::int AS calls, COALESCE(SUM(rows), 0)::int AS rows
      FROM pg_stat_statements
     WHERE query NOT LIKE '%pg_stat_statements%'
  `;

  results.push({ label, path, ms, kb: body.byteLength / 1024, calls: stats.calls, rows: stats.rows });
  console.log(
    label.padEnd(20) +
      ms.toFixed(0).padStart(7) +
      (body.byteLength / 1024).toFixed(1).padStart(9) +
      String(stats.calls).padStart(9) +
      String(stats.rows).padStart(9),
  );
}

/**
 * The statement list is gathered from a SECOND pass over every page, because
 * the loop above resets the counters before each one — so reading them at the
 * end would describe only the last page visited, which is the least
 * interesting of them.
 */
await sql`SELECT pg_stat_statements_reset()`;
for (const [, path] of PAGES) await fetch(BASE + path).then((r) => r.arrayBuffer());

console.log('\nMost expensive statements across one visit to every page:');
const slow = await sql`
  SELECT calls, round(total_exec_time::numeric, 1) AS total_ms,
         round(mean_exec_time::numeric, 2) AS mean_ms, rows,
         left(regexp_replace(query, '\\s+', ' ', 'g'), 150) AS query
    FROM pg_stat_statements
   WHERE query NOT LIKE '%pg_stat_statements%'
   ORDER BY total_exec_time DESC LIMIT 10
`;
for (const row of slow) {
  console.log(`  ${String(row.calls).padStart(4)}x  ${String(row.mean_ms).padStart(8)}ms  ${row.query}`);
}

await sql.end();
