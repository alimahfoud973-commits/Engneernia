import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * NOTHING SECRET IS COMMITTED (owner decision on OPEN-10).
 *
 * The owner's rule: no passwords, API keys or payment credentials in GitHub or
 * in the code — environment variables and secrets only. `.gitignore` already
 * keeps `.env.local` and `.env.production` out, but .gitignore protects
 * against the files somebody expected. This looks at what is actually tracked.
 *
 * It runs over `git ls-files`, so a secret pasted into a source file, a
 * migration, a doc or a workflow is caught by the same pass — and caught by
 * the ordinary unit suite, before a commit becomes a push and a push becomes
 * permanent. A key that reached GitHub is compromised even after deletion:
 * the history keeps it, and so do any forks.
 */

const root = process.cwd();

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  // Lockfiles and binary assets carry integrity hashes and font bytes that are
  // long and random-looking but are not credentials.
  .filter((path) => !/^package-lock\.json$|^assets\/|\.(png|jpe?g|woff2?|ttf|ico|pdf|zip)$/.test(path));

const files = tracked
  .map((path) => {
    try {
      return { path, text: readFileSync(join(root, path), 'utf8') };
    } catch {
      return null;
    }
  })
  .filter((file): file is { path: string; text: string } => file !== null)
  // This file necessarily contains every pattern it looks for.
  .filter((file) => !file.path.endsWith('no-committed-secrets.test.ts'));

/**
 * Values that are deliberately in the repository and are not secrets: the
 * placeholders in `.env.example`, and the fixed credentials of the LOCAL
 * development database, which exists only inside docker-compose on a
 * developer's machine and is created by `docker/postgres/init/01-roles.sql`.
 */
const ALLOWED = [
  /replace-me[\w-]*/,
  /^(minioadmin|postgres|ci|test|x|a|b|changeme)$/i,
  /_password$/,          // app_password, migrator_password — the local cluster
  /^ci-[\w-]+$/,         // the workflow's throwaway values
  /example|placeholder|your-|<[^>]+>|\.\.\./i,
  // The words documentation uses where a credential goes, as in
  // `smtps://user:pass@host:465`. Meant to be replaced, never to work.
  /^(user|pass|password|secret|key|token|username)$/i,
];

const isAllowed = (value: string) => ALLOWED.some((pattern) => pattern.test(value));

describe('no credential is committed', () => {
  it('contains no private key block', () => {
    const offenders = files
      .filter((f) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(f.text))
      .map((f) => f.path);
    expect(offenders, `private key material in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('contains no AWS access key id', () => {
    const offenders = files
      .filter((f) => /\b(AKIA|ASIA)[0-9A-Z]{16}\b/.test(f.text))
      .map((f) => f.path);
    expect(offenders, `AWS key id in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('contains no provider API token', () => {
    // Stripe, GitHub, Slack, SendGrid: the shapes that actually get pasted.
    const pattern = /\b(sk_live_[0-9a-zA-Z]{16,}|rk_live_[0-9a-zA-Z]{16,}|gh[pousr]_[0-9A-Za-z]{30,}|xox[baprs]-[0-9A-Za-z-]{20,}|SG\.[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{20,})\b/;
    const offenders = files.filter((f) => pattern.test(f.text)).map((f) => f.path);
    expect(offenders, `API token in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('assigns no real value to a secret-bearing variable', () => {
    /**
     * The general case, and the one that catches a mistake nobody planned:
     * any NAME=value or NAME: value where the name reads like a credential.
     * Placeholders and the local cluster's fixed passwords are allowed by
     * name — anything else has to be explained, not committed.
     */
    /**
     * `[ \t]*`, NOT `\s*`, after the separator.
     *
     * With `\s*` the match crossed the newline, so an EMPTY `SESSION_SECRET=`
     * in `.env.production.example` swallowed the following line and reported
     * the next variable's name as its value. Found by running this against
     * the real repository rather than against an imagined one — a scanner
     * that cries wolf on a blank placeholder is a scanner somebody deletes.
     */
    const secretName =
      /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|ENCRYPTION_KEY|CREDENTIAL)[A-Z0-9_]*)[ \t]*[:=][ \t]*["']?([^\s"',;#}]{8,})/g;

    const offenders: string[] = [];
    for (const file of files) {
      /**
       * Test fixtures are excluded from THIS rule only.
       *
       * `correct-horse-battery-staple` and the RFC 6238 test vector are not
       * credentials, and a guard that flags them teaches people to ignore it.
       * The high-signal rules above — private keys, AWS ids, provider tokens,
       * connection strings — still run over tests, which is where a real
       * pasted secret would actually be caught.
       */
      if (/\.(test|itest)\.ts$/.test(file.path)) continue;
      for (const match of file.text.matchAll(secretName)) {
        const [, name, value] = match;
        if (!name || !value) continue;
        if (isAllowed(value)) continue;
        // A reference to another variable is not a value.
        if (/^\$|\$\{|process\.env|env\.|required\(|z\.|nonEmpty|base64Key|urlLike/.test(value)) continue;
        /**
         * Nor is a value COMPUTED at run time.
         *
         * `const TOTP_SECRET = base32Encode(randomBytes(20))` is the opposite
         * of a committed secret: it is the fix for one. The rule reads a name
         * and a value, and a call expression carries no secret into the
         * repository — what it produces exists only while the process runs.
         *
         * Narrow on purpose: this skips `name(`, not anything containing a
         * bracket. A quoted literal is still caught, which is what found the
         * real defect this file exists for.
         */
        if (/^[A-Za-z_$][\w$]*\(/.test(value)) continue;
        offenders.push(`${file.path}: ${name}`);
      }
    }
    expect(offenders, `real secret values committed: ${offenders.join(', ')}`).toEqual([]);
  });

  it('commits no connection string carrying a non-local password', () => {
    const pattern = /\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqp|smtps?):\/\/[^\s:/@"']+:([^\s@"']+)@([^\s/"']+)/g;
    const offenders: string[] = [];
    for (const file of files) {
      for (const match of file.text.matchAll(pattern)) {
        const [, password, host] = match;
        if (!password || !host) continue;
        if (isAllowed(password)) continue;
        if (/^(localhost|127\.0\.0\.1|db|postgres|mailhog|minio|host)(:\d+)?$/.test(host)) continue;
        // Documentation hosts: example.com, example.test, <النطاق>.
        if (/example\.|\.test(:|$)|<|>/.test(host)) continue;
        offenders.push(`${file.path}: ${host}`);
      }
    }
    expect(offenders, `connection string with a password in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps the environment files out of version control', () => {
    const leaked = tracked.filter((path) =>
      /(^|\/)\.env$|(^|\/)\.env\.local$|(^|\/)\.env\.production$/.test(path));
    expect(leaked, `environment files must never be tracked: ${leaked.join(', ')}`).toEqual([]);
  });

  it('keeps backups out of version control', () => {
    const leaked = tracked.filter((path) => /(^|\/)backups?\//.test(path) || /\.dump$/.test(path));
    expect(leaked, `a backup holds every customer and every sale: ${leaked.join(', ')}`).toEqual([]);
  });
});
