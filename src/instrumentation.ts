/**
 * ===========================================================================
 * BOOT-TIME CONFIGURATION CHECK
 * ===========================================================================
 * Next calls `register()` once, when the server starts, before it serves
 * anything. Reading the environment here is what turns a bad configuration
 * from a running site that fails later into a process that does not run.
 *
 * WHY THAT DISTINCTION IS WORTH A FILE. `serverEnv()` is memoised and lazy, so
 * without this the first validation happens on whichever request happens to
 * need it first. A deployment with no STORAGE_ENDPOINT would boot, pass a
 * health check, and answer 500 on every page — with the real cause buried in a
 * stack trace under `generateMetadata`. The same mistake caught here prints
 * the variable's name and stops the process.
 *
 * Node runtime only: the edge runtime has neither this configuration nor the
 * server-only modules that read it.
 * ===========================================================================
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertEnvironmentOrExit } = await import('@/lib/config/boot-check');
  assertEnvironmentOrExit();
}
