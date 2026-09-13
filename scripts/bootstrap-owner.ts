/**
 * Creates the single platform owner account (specification §2.1).
 *
 * Run once, against a fresh database:
 *   npm run bootstrap:owner                       (interactive prompts)
 *   OWNER_EMAIL=... OWNER_NAME=... OWNER_PASSWORD=... npm run bootstrap:owner
 *
 * The non-interactive form reads the password from the ENVIRONMENT, never
 * from a command-line argument: argv is visible to every process on the host
 * and lands in shell history.
 *
 * Deliberately self-contained — it connects with the MIGRATION role, because
 * the RLS policy on `users` permits inserts only to an actor that is already
 * the owner, and at this moment no owner exists. This is the only place in the
 * system that sidesteps that policy, and it refuses to run twice.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import postgres from 'postgres';
import { hash as argonHash } from '@node-rs/argon2';

const ARGON_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const MIN_PASSWORD_LENGTH = 12;

try {
  process.loadEnvFile('.env.local');
} catch {
  // Environment already populated (CI or production).
}

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  const existing = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM users WHERE role = 'OWNER'
  `;

  if ((existing[0]?.count ?? 0) > 0) {
    console.error('An owner account already exists. Refusing to create a second one.');
    console.error('The platform has exactly one owner by design (specification §2.1),');
    console.error('and since migration 0041 the database enforces it: the unique index');
    console.error('users_single_owner would refuse the INSERT even if this check did not.');
    console.error('');
    console.error('To hand the platform to a different account instead of creating one:');
    console.error('  SELECT app_transfer_ownership(\'<the new owner\'s user id>\');');
    console.error('run with the migration role. It demotes the current owner to CUSTOMER');
    console.error('and promotes the new one in a single transaction, and audits both.');
    process.exit(1);
  }

  let email = process.env.OWNER_EMAIL?.trim().toLowerCase() ?? '';
  let displayName = process.env.OWNER_NAME?.trim() ?? '';
  let password = process.env.OWNER_PASSWORD ?? '';

  const needsPrompting = email === '' || displayName === '' || password === '';
  if (needsPrompting) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      if (email === '') email = (await rl.question('Owner email: ')).trim().toLowerCase();
      if (displayName === '') displayName = (await rl.question('Display name: ')).trim();
      if (password === '') password = (await rl.question('Password (min 12 chars): ')).trim();
    } finally {
      rl.close();
    }
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Invalid email address.');
  if (displayName.length === 0) throw new Error('Display name is required.');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const passwordHash = await argonHash(password, ARGON_OPTIONS);

  const [created] = await sql<Array<{ id: string }>>`
    INSERT INTO users (email, password_hash, role, status, display_name, email_verified_at)
    VALUES (${email}, ${passwordHash}, 'OWNER', 'ACTIVE', ${displayName}, now())
    RETURNING id
  `;

  await sql`
    INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, after)
    VALUES (${created!.id}, 'OWNER', 'USER_CREATED', 'user', ${created!.id},
            ${sql.json({ role: 'OWNER', bootstrap: true })})
  `;

  console.log(`\nOwner account created: ${email}`);
  console.log('\nNEXT STEP — enable two-factor authentication before this account');
  console.log('is used on any network you do not control.');
} catch (error) {
  console.error(`\nBootstrap failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
