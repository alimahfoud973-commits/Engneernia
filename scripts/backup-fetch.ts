/**
 * =============================================================================
 * BRING A SHIPPED BACKUP BACK  (owner decision on OPEN-10)
 * =============================================================================
 *   node --experimental-strip-types scripts/backup-fetch.ts <stamp> [destination]
 *   npm run backup:fetch -- 20260913T220308Z
 *
 * The counterpart to backup-ship.ts, and not an optional one: an encrypted
 * backup with no exercised way back is not a backup, it is a ritual. This
 * downloads a shipped backup, decrypts it, and verifies SHA256SUMS — which
 * proves the round trip, because those checksums were computed over the
 * plaintext before it was ever encrypted.
 *
 * Its output is an ordinary backup folder, so `npm run restore-drill -- <dir>`
 * takes it exactly as if it had never left the server.
 * =============================================================================
 */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { decryptFile } from './backup-crypto.ts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set. See docs/BACKUP-AND-RESTORE.md §6.`);
    process.exit(1);
  }
  return value;
}

const stamp = process.argv[2];
if (!stamp) {
  console.error('Usage: backup-fetch.ts <stamp> [destination]');
  console.error('The stamp is the folder name, e.g. 20260913T220308Z.');
  process.exit(1);
}

const destination = process.argv[3] ?? join('./restored', stamp);
const prefix = process.env.BACKUP_PREFIX?.trim() || 'enginora';
const bucket = required('BACKUP_S3_BUCKET');
const secret = required('BACKUP_ENCRYPTION_KEY');

const client = new S3Client({
  endpoint: required('BACKUP_S3_ENDPOINT'),
  region: process.env.BACKUP_S3_REGION?.trim() || 'auto',
  forcePathStyle: (process.env.BACKUP_S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  credentials: {
    accessKeyId: required('BACKUP_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('BACKUP_S3_SECRET_ACCESS_KEY'),
  },
});

const listed = await client.send(new ListObjectsV2Command({
  Bucket: bucket,
  Prefix: `${prefix}/${stamp}/`,
}));

const keys = (listed.Contents ?? []).map((o) => o.Key!).filter(Boolean).sort();
if (keys.length === 0) {
  console.error(`Nothing stored under ${bucket}/${prefix}/${stamp}/.`);
  process.exit(1);
}

await mkdir(destination, { recursive: true });
console.log(`==> fetching ${keys.length} artefact(s) into ${destination}`);

for (const key of keys) {
  const name = key.slice(key.lastIndexOf('/') + 1).replace(/\.enc$/, '');
  const sealed = join(destination, `${name}.enc`);

  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(object.Body as Readable, createWriteStream(sealed));

  try {
    // Fails on a tampered or truncated artefact rather than writing plausible
    // rubbish: the tag is checked as the stream ends.
    await decryptFile(sealed, join(destination, name), secret);
  } catch (error) {
    /**
     * Caught and explained rather than thrown.
     *
     * The first time anyone runs this, the original is already gone. A Node
     * stack trace ending in `endReadableNT` says nothing about the one thing
     * that is almost always wrong — the key — and the person reading it is
     * having the worst day of the platform's life. This was found by running
     * it with the wrong key and reading what came out.
     */
    console.error(`\n    ${name}: could not be decrypted.\n`);
    console.error('    Authentication failed. In order of likelihood:');
    console.error('      1. BACKUP_ENCRYPTION_KEY is not the key this backup was sealed with.');
    console.error('         Keys are not recoverable — the right key is the only way in.');
    console.error('      2. The stored object is damaged or was altered.');
    console.error('');
    console.error(`    (${error instanceof Error ? error.message : String(error)})\n`);
    process.exit(1);
  }

  await rm(sealed, { force: true });
  console.log(`    ${name}  decrypted`);
}

// The checksums were taken over the plaintext before encryption, so agreeing
// with them here proves encrypt, upload, download and decrypt were all lossless.
const sums = await readFile(join(destination, 'SHA256SUMS'), 'utf8').catch(() => null);
if (!sums) {
  console.log('==> no SHA256SUMS in this backup; nothing to verify against.');
} else {
  let bad = 0;
  for (const line of sums.trim().split('\n')) {
    const [expected, name] = line.trim().split(/\s+/);
    if (!expected || !name) continue;
    const hash = createHash('sha256');
    await pipeline(createReadStream(join(destination, name)), hash);
    const actual = hash.digest('hex');
    const ok = actual === expected;
    if (!ok) bad += 1;
    console.log(`    ${ok ? 'ok  ' : 'BAD '} ${name}`);
  }
  if (bad > 0) {
    console.error(`\n${bad} artefact(s) do not match their checksum. Do not restore this backup.`);
    process.exit(1);
  }
  console.log('==> every artefact matches the checksum taken before encryption.');
}

console.log(`\nNow prove it restores:\n  npm run restore-drill -- ${destination}`);
