import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE APPLICATION CANNOT REACH THE BACKUPS (owner decision on OPEN-10).
 *
 * The owner's rule was that managing and restoring backups, and the
 * credentials for them, belong to the owner alone. That could have been a
 * sentence in a runbook. It is instead a property of how the system is put
 * together: the BACKUP_* variables are never validated, read or held by the
 * running site, so a compromised web process has no client, no key and no
 * credential for that bucket — it cannot read a backup, cannot overwrite one,
 * and cannot delete one.
 *
 * These tests fail the moment that stops being true, which is the only reason
 * the property is worth anything a year from now.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(rel);
  }
  return out;
}

describe('the backup credentials are not application configuration', () => {
  it('names no BACKUP_ variable in the validated environment schema', () => {
    // If one is ever added here, `serverEnv()` starts requiring it, the web
    // process starts holding it, and the separation is gone.
    expect(read('src/lib/config/env.ts')).not.toMatch(/BACKUP_/);
  });

  it('is read by no file under src/, in any form', () => {
    const offenders = walk('src')
      .filter((file) => !file.endsWith('backup-isolation.test.ts'))
      .filter((file) => /BACKUP_S3_|BACKUP_ENCRYPTION_KEY/.test(read(file)));

    expect(offenders, `src/ must not read backup credentials: ${offenders.join(', ')}`)
      .toEqual([]);
  });

  it('lives only in the backup scripts, which the application never imports', () => {
    const importers = walk('src').filter((file) =>
      /from '.*scripts\/backup/.test(read(file)));

    expect(importers, `nothing in src/ may import the backup scripts: ${importers.join(', ')}`)
      .toEqual([]);
  });
});

describe('shipping a backup can never remove one', () => {
  /**
   * The owner's rule: deleting or changing site data must not delete the
   * historical backups. The enforcement is that the code which can reach the
   * bucket has no delete in it at all — retention is the provider's object
   * lock and lifecycle, set in a console this repository cannot touch.
   */
  it('has no delete operation in the shipping script', () => {
    const ship = read('scripts/backup-ship.ts');
    expect(ship).not.toMatch(/DeleteObjectsCommand|DeleteObjectCommand|deleteObject/);
  });

  it('has no delete operation in the fetch script either', () => {
    const fetch = read('scripts/backup-fetch.ts');
    expect(fetch).not.toMatch(/DeleteObjectsCommand|DeleteObjectCommand|deleteObject/);
  });

  it('prunes only local staging copies, never the bucket', () => {
    const hourly = read('scripts/backup-hourly.sh');
    // The only rm in the hourly job is the local staging prune. A remote
    // delete would have to go through the AWS client, which is covered above.
    const removals = hourly.match(/rm -rf [^\n]*/g) ?? [];
    for (const line of removals) {
      expect(line).toMatch(/\$old/);
    }
  });
});

describe('the object store the application does hold is a different one', () => {
  it('serves product files from STORAGE_*, which is not the backup bucket', () => {
    // The owner asked that product files live in separate secure object
    // storage rather than on the application server. They already do — this
    // asserts the two sets of credentials stay distinct rather than drifting
    // into one bucket with one key.
    const env = read('src/lib/config/env.ts');
    expect(env).toMatch(/STORAGE_BUCKET_ORIGINALS/);
    expect(env).toMatch(/STORAGE_BUCKET_DERIVATIVES/);
    expect(env).not.toMatch(/BACKUP_S3_BUCKET/);
  });
});
