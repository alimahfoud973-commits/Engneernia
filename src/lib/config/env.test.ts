import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCacheForTests, serverEnv } from './env';

/**
 * The cross-field rules, which exist to turn a class of misconfiguration from
 * "boots fine, fails hours later on one specific action" into "refuses to
 * start, naming the variable".
 */

const BASE: Record<string, string> = {
  APP_URL: 'https://example.test',
  DATABASE_URL: 'postgresql://u:p@db:5432/app',
  SESSION_SECRET: 'x'.repeat(48),
  CONFIG_ENCRYPTION_KEY: 'y'.repeat(48),
  STORAGE_ENDPOINT: 'https://s3.example.test',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY_ID: 'a',
  STORAGE_SECRET_ACCESS_KEY: 'b',
  STORAGE_BUCKET_ORIGINALS: 'originals',
  STORAGE_BUCKET_DERIVATIVES: 'derivatives',
  MAIL_TRANSPORT_URL: 'smtps://u:p@smtp.example.test:465',
  MAIL_FROM: 'Enginora <no-reply@example.test>',
};

const saved = { ...process.env };

function withEnv<T>(overrides: Record<string, string>, run: () => T): T {
  for (const key of Object.keys(process.env)) {
    if (key in BASE || key === 'NODE_ENV' || key === 'SEO_INDEXABLE') delete process.env[key];
  }
  Object.assign(process.env, BASE, overrides);
  resetEnvCacheForTests();
  return run();
}

afterEach(() => {
  process.env = { ...saved };
  resetEnvCacheForTests();
});

describe('serverEnv', () => {
  it('accepts a well-formed production configuration', () => {
    withEnv({ NODE_ENV: 'production' }, () => {
      expect(serverEnv().STORAGE_ENDPOINT).toBe('https://s3.example.test');
    });
  });

  it('refuses filesystem storage in production, at startup', () => {
    withEnv({ NODE_ENV: 'production', STORAGE_ENDPOINT: 'file:///var/data' }, () => {
      expect(() => serverEnv()).toThrow(/STORAGE_ENDPOINT/);
    });
  });

  it('still allows filesystem storage outside production', () => {
    withEnv({ NODE_ENV: 'development', STORAGE_ENDPOINT: 'file:///var/data' }, () => {
      expect(serverEnv().STORAGE_ENDPOINT).toBe('file:///var/data');
    });
  });

  it('refuses the log mail transport in production, at startup', () => {
    withEnv({ NODE_ENV: 'production', MAIL_TRANSPORT_URL: 'log://local' }, () => {
      expect(() => serverEnv()).toThrow(/MAIL_TRANSPORT_URL/);
    });
  });

  it('still allows the log mail transport outside production', () => {
    withEnv({ NODE_ENV: 'development', MAIL_TRANSPORT_URL: 'log://local' }, () => {
      expect(serverEnv().MAIL_TRANSPORT_URL).toBe('log://local');
    });
  });

  it('refuses an indexable deployment that points at localhost', () => {
    withEnv({ SEO_INDEXABLE: 'true', APP_URL: 'http://localhost:3000' }, () => {
      expect(() => serverEnv()).toThrow(/APP_URL/);
    });
  });

  it('allows localhost while indexing is off — which is the development case', () => {
    withEnv({ APP_URL: 'http://localhost:3000' }, () => {
      expect(serverEnv().SEO_INDEXABLE).toBe(false);
    });
  });

  it('allows a real host with indexing on', () => {
    withEnv({ SEO_INDEXABLE: 'true', APP_URL: 'https://engineernia.example' }, () => {
      expect(serverEnv().SEO_INDEXABLE).toBe(true);
    });
  });

  it('names every missing variable at once rather than one per restart', () => {
    withEnv({}, () => {
      delete process.env.SESSION_SECRET;
      delete process.env.DATABASE_URL;
      resetEnvCacheForTests();
      expect(() => serverEnv()).toThrow(/SESSION_SECRET[\s\S]*DATABASE_URL|DATABASE_URL[\s\S]*SESSION_SECRET/);
    });
  });
});
