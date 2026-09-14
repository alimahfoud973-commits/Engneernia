/**
 * =============================================================================
 * SHIP A BACKUP OFF THE SERVER  (owner decision on OPEN-10)
 * =============================================================================
 *   node --experimental-strip-types scripts/backup-ship.ts [backup-directory]
 *   npm run backup:ship
 *
 * `scripts/backup.sh` writes a backup to a folder ON THE SERVER. A copy that
 * lives on the machine it protects is not a backup — it dies with the disk it
 * is on. This takes that folder, encrypts every artefact, and puts it in
 * S3-compatible storage that the application cannot reach.
 *
 * FOUR PROPERTIES, EACH ONE A DECISION THE OWNER MADE
 *
 *   1. SEPARATE CREDENTIALS, STRUCTURALLY. Every variable here is BACKUP_*,
 *      and not one of them appears in `src/lib/config/env.ts`. The running
 *      site does not validate them, cannot read them, and has no client for
 *      this bucket. Backups are out of reach of the application by
 *      construction, not by policy — `src/lib/config/backup-isolation.test.ts`
 *      fails if that ever stops being true.
 *
 *   2. ENCRYPTED BEFORE IT LEAVES. AES-256-GCM, in `backup-crypto.ts`. The
 *      storage provider holds ciphertext and nothing else; a leaked bucket is
 *      not a leaked ledger.
 *
 *   3. NOTHING IS EVER DELETED FROM HERE. There is no delete call in this
 *      file and there must never be one. Deleting site data must not delete
 *      its history, so retention on the destination is the provider's object
 *      lock and lifecycle rules — set by the owner, in the provider's console,
 *      where this code cannot undo them.
 *
 *   4. S3-COMPATIBLE, SO THE PROVIDER CAN CHANGE. R2, MinIO, Backblaze B2,
 *      Wasabi, S3 itself: swapping is an endpoint and a key, not a rewrite.
 * =============================================================================
 */
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { encryptFile } from './backup-crypto.ts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`\n${name} is not set.`);
    console.error('The backup job has its own credentials, separate from the application.');
    console.error('See docs/BACKUP-AND-RESTORE.md §6.\n');
    process.exit(1);
  }
  return value;
}

const source = process.argv[2] ?? await newestBackup();
const prefix = process.env.BACKUP_PREFIX?.trim() || 'enginora';
const bucket = required('BACKUP_S3_BUCKET');
const secret = required('BACKUP_ENCRYPTION_KEY');

const client = new S3Client({
  endpoint: required('BACKUP_S3_ENDPOINT'),
  region: process.env.BACKUP_S3_REGION?.trim() || 'auto',
  forcePathStyle: (process.env.BACKUP_S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  // The default provider chain is bypassed deliberately, exactly as the
  // application's own S3 adapter does: this host may carry unrelated AWS_*
  // variables, and authenticating with whatever happens to be present is how
  // a backup ends up in somebody else's account.
  credentials: {
    accessKeyId: required('BACKUP_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('BACKUP_S3_SECRET_ACCESS_KEY'),
  },
});

async function newestBackup(): Promise<string> {
  const root = process.env.BACKUP_DIR?.trim() || './backups';
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const stamps = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const newest = stamps.at(-1);
  if (!newest) {
    console.error(`No backup found under ${root}. Run \`npm run backup\` first.`);
    process.exit(1);
  }
  return join(root, newest);
}

const stamp = basename(source);
const staging = await mkdtemp(join(tmpdir(), 'enginora-ship-'));

try {
  const files = (await readdir(source)).filter((name) => !name.endsWith('.enc')).sort();
  if (files.length === 0) {
    console.error(`${source} holds no artefacts.`);
    process.exit(1);
  }

  console.log(`==> shipping ${stamp} to ${bucket}/${prefix}/${stamp}`);
  let shipped = 0;

  for (const name of files) {
    const plain = join(source, name);
    const sealed = join(staging, `${name}.enc`);
    await encryptFile(plain, sealed, secret);

    const key = `${prefix}/${stamp}/${name}.enc`;
    const { size } = await stat(sealed);

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(sealed),
      ContentLength: size,
      ContentType: 'application/octet-stream',
    }));

    // Read it back. An upload that reported success and stored nothing is the
    // failure mode a backup cannot afford, and it costs one request to rule out.
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (head.ContentLength !== size) {
      throw new Error(`${key}: uploaded ${size} bytes, the bucket reports ${head.ContentLength}.`);
    }

    console.log(`    ${key}  ${(size / 1024).toFixed(0)} KiB  verified`);
    shipped += 1;
  }

  console.log(`==> ${shipped} artefact(s) shipped, encrypted, and read back.`);
  console.log('    Nothing was deleted: retention belongs to the bucket, not to this script.');
} finally {
  await rm(staging, { recursive: true, force: true });
}
