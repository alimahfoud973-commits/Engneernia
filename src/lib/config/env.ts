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

  // Either an S3-compatible https endpoint, or file://<path> to select the
  // filesystem adapter for local development (refused in production).
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

  /**
   * Outbound email, as one URL — the same idiom as STORAGE_ENDPOINT.
   *
   * `log://` writes messages to the log instead of sending them, which is what
   * local work wants and what production must never have. `smtp://` and
   * `smtps://` carry the credentials, so the provider can be replaced without
   * a code change; the platform is operated from Syria and that is not a
   * hypothetical requirement.
   *
   * There is no default. A deployment that forgets this variable stops at
   * boot, rather than accepting registrations whose verification mail is
   * addressed to nowhere.
   */
  MAIL_TRANSPORT_URL: urlLike('MAIL_TRANSPORT_URL'),
  /** RFC 5322 From header, e.g. `إنجينيرنيا <no-reply@example.com>`. */
  MAIL_FROM: nonEmpty('MAIL_FROM'),

  PLATFORM_TIMEZONE: nonEmpty('PLATFORM_TIMEZONE').default('Asia/Damascus'),
  PLATFORM_BASE_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  DEFAULT_LOCALE: z.enum(['ar', 'en']).default('ar'),

  // Specification §26: five pages. Held as configuration because §26 calls it
  // a policy the owner may revisit, not a constant.
  PREVIEW_PAGE_COUNT: z.coerce.number().int().min(1).max(50).default(5),

  // Explicit: running without a scanner must be a recorded decision.
  MALWARE_SCANNER: z.enum(['none', 'clamav']).default('none'),

  /**
   * May search engines index this deployment?
   *
   * DEFAULTS TO FALSE, and that default is the safe one: a staging copy that
   * forgets to set it stays out of the index, whereas a production site that
   * forgets it merely stays invisible until somebody notices. The reverse
   * default would put a half-finished catalogue — and the engineers' names on
   * it — into Google permanently, since removal is slow and partial.
   *
   * Only ever widens what `robots.ts` and the page metadata allow; the private
   * areas are refused regardless of this flag.
   */
  SEO_INDEXABLE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
})
  /**
   * Cross-field rules — the ones that only make sense once everything else has
   * parsed. Each exists because the configuration it rejects produces a
   * deployment that STARTS, serves pages, and fails later on a specific
   * action, which is the worst way to learn about a misconfiguration.
   */
  .superRefine((env, ctx) => {
    /**
     * Filesystem storage in production.
     *
     * `getStorage()` already refuses it — but lazily, on the first request
     * that actually reaches a file. A deployment missing STORAGE_ENDPOINT
     * therefore boots clean, serves the whole catalogue, and then answers 500
     * the first time the owner opens a payment receipt. Checked here, the same
     * mistake stops the process at startup with the variable named.
     */
    if (env.NODE_ENV === 'production' && env.STORAGE_ENDPOINT.startsWith('file:')) {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_ENDPOINT'],
        message:
          'Filesystem storage is not permitted in production — a single-node disk cannot '
          + 'survive the container being replaced. Configure an S3-compatible endpoint.',
      });
    }

    /**
     * The log mail transport in production.
     *
     * `getEmail()` refuses it too, but lazily — on the first registration that
     * actually tries to send. A deployment carrying `log://` therefore boots
     * clean, serves the whole catalogue, and then quietly accepts sign-ups
     * whose verification mail never leaves the server. Nobody reports that as
     * a bug; they just never come back. Checked here, it stops at startup.
     */
    if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT_URL.startsWith('log:')) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT_URL'],
        message:
          'The log mail transport is not permitted in production — verification emails '
          + 'would never be delivered. Configure an smtp:// or smtps:// URL.',
      });
    }

    /**
     * An indexable deployment pointing at localhost.
     *
     * APP_URL is what every canonical link, sitemap entry and Open Graph URL
     * is built from. Letting a production deployment publish a sitemap full of
     * `http://localhost:3000/...` is not a small error: those URLs are what
     * search engines record.
     */
    if (env.SEO_INDEXABLE) {
      const host = new URL(env.APP_URL).hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        ctx.addIssue({
          code: 'custom',
          path: ['APP_URL'],
          message:
            'SEO_INDEXABLE is on while APP_URL points at localhost. Every canonical URL and '
            + 'sitemap entry would name a host no crawler can reach.',
        });
      }
    }
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
