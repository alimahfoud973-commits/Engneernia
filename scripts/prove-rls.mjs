/**
 * Runs the row-level-security proof against a real database.
 *
 * Needs a SUPERUSER connection, because the proof works by `SET ROLE app_user`
 * and then attempting things the application must not be able to do. Only a
 * superuser can assume another role, and the whole point of the script is to
 * ask the question from outside the application's own privileges.
 */
import { spawnSync } from 'node:child_process';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* CI provides the environment */
}

const url = process.env.DATABASE_SUPERUSER_URL;
if (!url) {
  console.error(
    'DATABASE_SUPERUSER_URL must be set. The proof assumes the app_user role,\n'
    + 'which requires a superuser connection — the migrator role cannot do it.',
  );
  process.exit(1);
}

const result = spawnSync(
  'psql',
  [url, '-v', 'ON_ERROR_STOP=1', '-f', 'src/db/security/rls-foundation.test.sql'],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
