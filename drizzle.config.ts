import { defineConfig } from 'drizzle-kit';

/**
 * Migrations intentionally use DATABASE_MIGRATION_URL (a privileged role),
 * never the restricted role the application runs as. This keeps the
 * application role unable to alter schema, drop RLS policies, or bypass them.
 */
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
