/**
 * =============================================================================
 * BACKUP ENCRYPTION
 * =============================================================================
 * A backup leaves the server. That is the whole point of shipping it, and it
 * is also the reason it must be unreadable in transit and at rest: the dump
 * holds every customer's address, every sale, and the entire ledger.
 *
 * AES-256-GCM, authenticated. A tampered file fails to decrypt rather than
 * yielding plausible garbage — which matters more here than anywhere else in
 * the platform, because the one moment anybody reads a backup is the moment
 * they have already lost the original.
 *
 * FILE LAYOUT
 *   magic "ENGBK1" (6) | version (1) | iv (12) | ciphertext … | tag (16)
 *
 * The tag is written LAST because GCM does not produce it until the stream
 * ends. Decryption reads the file size, streams everything between the header
 * and the final 16 bytes, then supplies those 16 as the tag. Streaming
 * throughout: a dump is not read into memory, at either end.
 *
 * THE KEY IS NEVER IN THIS REPOSITORY. It comes from BACKUP_ENCRYPTION_KEY,
 * which belongs to the backup job and to the owner — not to the application
 * (see scripts/backup-ship.ts).
 * =============================================================================
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('ENGBK1', 'utf8');
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES;

/**
 * The key material is required to be at least 32 characters of real entropy
 * (`openssl rand -base64 36`), so a single SHA-256 is the right derivation —
 * the same choice, for the same reason, as `src/auth/crypto.ts`. A password
 * people invent would need scrypt instead; this one is generated.
 */
function keyFrom(secret: string): Buffer {
  if (secret.length < 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be at least 32 characters.');
  }
  if (secret.startsWith('replace-me')) {
    throw new Error('BACKUP_ENCRYPTION_KEY still holds the placeholder from .env.example.');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export async function encryptFile(
  source: string,
  destination: string,
  secret: string,
): Promise<void> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const out = createWriteStream(destination);

  out.write(Buffer.concat([MAGIC, Buffer.from([VERSION]), iv]));
  await pipeline(createReadStream(source), cipher, out, { end: false });

  await new Promise<void>((resolve, reject) => {
    out.end(cipher.getAuthTag(), (error?: Error | null) =>
      (error ? reject(error) : resolve()));
  });
}

export async function decryptFile(
  source: string,
  destination: string,
  secret: string,
): Promise<void> {
  const { size } = await stat(source);
  if (size < HEADER_BYTES + TAG_BYTES) {
    throw new Error(`${source} is too short to be an encrypted backup artefact.`);
  }

  const header = await read(source, 0, HEADER_BYTES - 1);
  if (!timingSafeEqual(header.subarray(0, MAGIC.length), MAGIC)) {
    throw new Error(`${source} is not an Enginora backup artefact.`);
  }
  const version = header[MAGIC.length];
  if (version !== VERSION) {
    throw new Error(`${source} uses backup format v${version}; this tool reads v${VERSION}.`);
  }

  const iv = header.subarray(MAGIC.length + 1);
  const tag = await read(source, size - TAG_BYTES, size - 1);

  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
  decipher.setAuthTag(tag);

  /**
   * An artefact whose plaintext was empty carries no ciphertext at all, and
   * `createReadStream` throws on a range whose start is past its end. Found by
   * testing it rather than by reading it — and worth handling rather than
   * declaring impossible, because the tag is still authenticated here: a
   * forged empty artefact is refused exactly like a forged full one.
   */
  if (size === HEADER_BYTES + TAG_BYTES) {
    await writeFile(destination, decipher.final());
    return;
  }

  // Throws on a bad tag at the end of the stream — which is the point: a
  // truncated or altered artefact must fail loudly, not restore quietly.
  await pipeline(
    createReadStream(source, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
    decipher,
    createWriteStream(destination),
  );
}

async function read(path: string, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path, { start, end })) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
