import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE PRODUCTION STACK MUST PASS EVERY VARIABLE THE PRODUCTION STACK NEEDS.
 *
 * `serverEnv()` is fail-fast by design: a missing variable stops the process
 * at boot rather than surfacing hours later. That design has one blind spot,
 * and it is not in the code — it is in the gap between two files. Compose only
 * forwards the variables named in a service's `environment:` block. A variable
 * can therefore be required by the schema, documented in
 * `.env.production.example`, filled in correctly by the operator, and still
 * never reach the container.
 *
 * That is exactly what happened when self-registration added MAIL_TRANSPORT_URL
 * and MAIL_FROM: every test was green, `.env.production.example` was complete,
 * and `docker compose up` would have produced a container that exits at boot.
 * Nothing in the test suite could see it, because the defect lives between a
 * YAML file and a shell environment rather than inside any module.
 *
 * The direction matters: the example file is the operator-facing contract, so
 * it is the source and the compose file is checked against it. A variable
 * documented for production that compose never forwards is the failure this
 * catches.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Keys assigned in a dotenv-style file, ignoring comments and blank lines. */
function declaredKeys(file: string): string[] {
  return file
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim() ?? '')
    .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key));
}

describe('docker-compose.prod.yml carries the whole production environment', () => {
  it('forwards every variable that .env.production.example documents', () => {
    const compose = read('docker-compose.prod.yml');
    const missing = declaredKeys(read('.env.production.example'))
      // The backup credentials are deliberately absent from the stack: the
      // application must not be able to reach its own history (OPEN-10, and
      // src/lib/security/backup-isolation.test.ts). A cron job on the host
      // reads them; no container does.
      .filter((key) => !key.startsWith('BACKUP_'))
      .filter((key) => !compose.includes(key));

    expect(missing, `not forwarded by docker-compose.prod.yml: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('sends mail through a real transport, never the log adapter', () => {
    // `log://` boots cleanly, accepts sign-ups, and delivers nothing. The
    // environment schema refuses it in production; this refuses it one step
    // earlier, in the file an operator copies.
    const example = read('.env.production.example');
    const line = example.split('\n').find((l) => l.startsWith('MAIL_TRANSPORT_URL='));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/=\s*log:/);
  });
});
