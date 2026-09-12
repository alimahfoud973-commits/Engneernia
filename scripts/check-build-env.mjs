/**
 * Refuses a production build started with a development NODE_ENV.
 *
 * This is the guard for KI-1. `next build` honours a NODE_ENV that is already
 * in the process environment; with `development` it warns that the value is
 * non-standard and then dies while prerendering /_global-error with
 * "Cannot read properties of null (reading 'useContext')" — an error that
 * names neither the cause nor the variable.
 *
 * The variable does not belong in .env.local, but a shell can still export it,
 * and a CI job can still inherit it. Failing here costs one second and says
 * exactly what is wrong.
 */
const value = process.env.NODE_ENV;

if (value !== undefined && value !== 'production') {
  console.error(
    [
      '',
      `✗ Refusing to build with NODE_ENV="${value}".`,
      '',
      '  `next build` honours this value and produces a broken build: it warns',
      '  that NODE_ENV is non-standard, then fails prerendering /_global-error',
      '  with "Cannot read properties of null (reading \'useContext\')".',
      '',
      '  Leave NODE_ENV unset — Next sets it itself — or set it to "production".',
      '  It must not appear in .env.local; see the note at the top of .env.example.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
