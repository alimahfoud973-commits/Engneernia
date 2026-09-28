import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('server-only', () => ({}));

/**
 * ===========================================================================
 * NOTHING TYPED INTO A SIGN-IN FORM REACHES A LOG (Stage 6)
 * ===========================================================================
 * The auth path handles a password (the owner's) and two personal
 * identifiers (a subscriber's phone and email). None may be written to the
 * application log or the audit trail. Three layers, each checked here:
 *   1. the auth code passes the logger an error object and nothing else;
 *   2. the logger redacts the field names anyway;
 *   3. the audit writer strips them anyway.
 * ===========================================================================
 */

const AUTH_DIR = join(process.cwd(), 'src/auth');
const sources = readdirSync(AUTH_DIR)
  .filter((f) => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('.itest.'))
  .map((f) => ({ file: f, text: readFileSync(join(AUTH_DIR, f), 'utf8') }));

describe('the auth code', () => {
  it('passes the logger only the error object', () => {
    const calls = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/logger\.\w+\(([^)]*)\)/g)].map((m) => ({ file, args: m[1] ?? '' })));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args, call.file).toMatch(/^\{ err: error \}, '[^']*'$/);
    }
  });

  it('never interpolates a credential into a log message or console output', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/console\.(log|error|warn|info)/);
      expect(text, file).not.toMatch(/logger\.\w+\([^)]*(password|phone|email|username)/i);
    }
  });
});

describe('the logger', () => {
  it('redacts passwords, hashes and phones even if someone logs them', async () => {
    const { REDACTED_PATHS } = await import('@/lib/logger');
    for (const path of ['password', '*.password', 'passwordHash', 'password_hash', 'phone', '*.phone']) {
      expect(REDACTED_PATHS, path).toContain(path);
    }
  });
});

describe('the audit writer', () => {
  it('strips a password, its hash and a phone at any depth', async () => {
    const { scrubForAudit } = await import('@/audit/log');
    const scrubbed = scrubForAudit({
      password: 'hunter2-hunter2', password_hash: '$argon2id$x', phone: '+963933123456',
      nested: { passwordHash: '$argon2id$y', phone: '+963933000000' },
    });
    const text = JSON.stringify(scrubbed);
    for (const secret of ['hunter2', 'argon2id', '+963933']) expect(text).not.toContain(secret);
  });
});
