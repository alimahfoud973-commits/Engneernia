import 'server-only';
import { serverEnv } from './env';

/**
 * Validate the environment, or stop the process.
 *
 * Lives in its own module, imported dynamically by `src/instrumentation.ts`,
 * for a build reason worth stating: Next statically analyses the
 * instrumentation file for the EDGE runtime, and `process.exit` there produces
 * a warning that reads "Ecmascript file had an error" on every build. The
 * runtime guard in the hook already prevents edge from reaching this code —
 * but a warning that cries error on a healthy build is how people learn to
 * stop reading build output, so the call is moved where the analyser cannot
 * see it instead of being left to be ignored.
 */
export function assertEnvironmentOrExit(): void {
  try {
    serverEnv();
  } catch (error) {
    // Printed rather than only thrown: Next wraps a throw from the hook in its
    // own message, and the useful part — which variable, and why — ends up
    // several frames down.
    console.error('\nThe server cannot start with this configuration:\n');
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\nSee .env.example and docs/DEPLOYMENT.md §3.\n');

    /**
     * AND THEN EXIT, RATHER THAN THROW.
     *
     * Measured: a throw from the instrumentation hook is reported as an
     * unhandled rejection and the process KEEPS LISTENING, answering 500 to
     * everything. That is the worst of both worlds — a port that accepts
     * connections, a TCP health check that passes, and a site that serves
     * nothing, with the cause in one boot-time stack trace that scrolls away.
     *
     * Exiting makes a misconfigured deployment fail the way it should: the
     * supervisor restarts it, the restarts fail, and the reason is the last
     * thing printed.
     */
    process.exit(1);
  }
}
