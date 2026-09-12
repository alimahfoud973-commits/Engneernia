import 'server-only';
import { z } from 'zod';

/**
 * Server environment, validated once at boot.
 *
 * Two deliberate properties:
 *   1. `import 'server-only'` makes it a BUILD ERROR to import this module from
 *      a client component. Secrets cannot reach the browser by accident.
 *   2. Validation is fail-fast. A missing DATABASE_URL stops the process at
 *      startup rather than surfacing as a confusing error during a checkout.
 */

const nonEmpty = (label: string) => z.string().min(1, `${label} is required`);

const urlLike = (label: string) =>
  nonEmpty(label).refine((value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }, `${label} must be a valid URL`);

const base64Key = (label: string) =>
  nonEmpty(label)
    .min(32, `${label} must be at least 32 characters`)
    .refine(
      (value) => !value.startsWith('replace-me'),
      `${label} still holds the placeholder value from .env.example`,
    );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: urlLike('APP_URL'),

  DATABASE_URL: urlLike('DATABASE_URL'),
  DATABASE_MIGRATION_URL: urlLike('DATABASE_MIGRATION_URL').optional(),

  SESSION_SECRET: base64Key('SESSION_SECRET'),
  CONFIG_ENCRYPTION_KEY: base64Key('CONFIG_ENCRYPTION_KEY'),

  STORAGE_ENDPOINT: urlLike('STORAGE_ENDPOINT'),
  STORAGE_REGION: nonEmpty('STORAGE_REGION'),
  STORAGE_ACCESS_KEY_ID: nonEmpty('STORAGE_ACCESS_KEY_ID'),
  STORAGE_SECRET_ACCESS_KEY: nonEmpty('STORAGE_SECRET_ACCESS_KEY'),
  STORAGE_BUCKET_ORIGINALS: nonEmpty('STORAGE_BUCKET_ORIGINALS'),
  STORAGE_BUCKET_DERIVATIVES: nonEmpty('STORAGE_BUCKET_DERIVATIVES'),
  STORAGE_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((value) => value === 'true'),

  PLATFORM_TIMEZONE: nonEmpty('PLATFORM_TIMEZONE').default('Asia/Damascus'),
  PLATFORM_BASE_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  DEFAULT_LOCALE: z.enum(['ar', 'en']).default('ar'),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Deliberately verbose: this only ever runs at boot, on the server.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test-only: clears the memoised value so a test can vary the environment. */
export function resetEnvCacheForTests(): void {
  cached = null;
}
