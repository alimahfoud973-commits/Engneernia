import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptFile, encryptFile, HEADER_BYTES } from './backup-crypto.ts';

/**
 * The backup is read exactly once: on the day the original is already gone.
 * These tests are the only chance to find out that it does not open.
 */

const KEY = 'a'.repeat(48);
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'backup-crypto-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function roundTrip(content: Buffer, key = KEY): Promise<Buffer> {
  const stamp = randomBytes(6).toString('hex');
  const plain = join(dir, `${stamp}.bin`);
  const sealed = join(dir, `${stamp}.enc`);
  const back = join(dir, `${stamp}.out`);
  await writeFile(plain, content);
  await encryptFile(plain, sealed, key);
  await decryptFile(sealed, back, key);
  return readFile(back);
}

describe('the round trip', () => {
  it('returns exactly what went in', async () => {
    const content = randomBytes(64 * 1024);
    expect(Buffer.compare(await roundTrip(content), content)).toBe(0);
  });

  it('handles an empty file', async () => {
    expect((await roundTrip(Buffer.alloc(0))).length).toBe(0);
  });

  it('streams a file larger than any single buffer it allocates', async () => {
    // 8 MiB: enough to cross the stream chunk boundary many times over, which
    // is where a tag-at-the-end format goes wrong if anything is buffered.
    const content = randomBytes(8 * 1024 * 1024);
    expect(Buffer.compare(await roundTrip(content), content)).toBe(0);
  });
});

describe('what it refuses', () => {
  it('refuses the wrong key rather than producing plausible rubbish', async () => {
    const plain = join(dir, 'wrong-key.bin');
    const sealed = join(dir, 'wrong-key.enc');
    await writeFile(plain, randomBytes(4096));
    await encryptFile(plain, sealed, KEY);

    await expect(
      decryptFile(sealed, join(dir, 'wrong-key.out'), 'b'.repeat(48)),
    ).rejects.toThrow();
  });

  it('refuses a single flipped byte in the ciphertext', async () => {
    const plain = join(dir, 'tampered.bin');
    const sealed = join(dir, 'tampered.enc');
    await writeFile(plain, randomBytes(4096));
    await encryptFile(plain, sealed, KEY);

    // Flip one bit well inside the ciphertext. This is the case that matters:
    // without authentication it would decrypt to almost-correct data, and a
    // restore would load a ledger that is quietly wrong.
    const handle = await open(sealed, 'r+');
    try {
      const at = HEADER_BYTES + 100;
      const byte = Buffer.alloc(1);
      await handle.read(byte, 0, 1, at);
      byte[0] = (byte[0] ?? 0) ^ 0x01;
      await handle.write(byte, 0, 1, at);
    } finally {
      await handle.close();
    }

    await expect(
      decryptFile(sealed, join(dir, 'tampered.out'), KEY),
    ).rejects.toThrow();
  });

  it('refuses a truncated artefact', async () => {
    const plain = join(dir, 'short.bin');
    const sealed = join(dir, 'short.enc');
    await writeFile(plain, randomBytes(4096));
    await encryptFile(plain, sealed, KEY);

    const { size } = await stat(sealed);
    const whole = await readFile(sealed);
    await writeFile(sealed, whole.subarray(0, size - 40));

    await expect(
      decryptFile(sealed, join(dir, 'short.out'), KEY),
    ).rejects.toThrow();
  });

  it('refuses a file that is not a backup artefact at all', async () => {
    const notOurs = join(dir, 'foreign.enc');
    await writeFile(notOurs, randomBytes(512));
    await expect(
      decryptFile(notOurs, join(dir, 'foreign.out'), KEY),
    ).rejects.toThrow(/not an Enginora backup artefact/);
  });

  it('refuses a key too weak to be one we generated', async () => {
    const plain = join(dir, 'weak.bin');
    await writeFile(plain, randomBytes(16));
    await expect(
      encryptFile(plain, join(dir, 'weak.enc'), 'short'),
    ).rejects.toThrow(/at least 32 characters/);
  });

  it('refuses the placeholder from .env.example', async () => {
    const plain = join(dir, 'placeholder.bin');
    await writeFile(plain, randomBytes(16));
    await expect(
      encryptFile(plain, join(dir, 'placeholder.enc'), 'replace-me-with-32-bytes-of-base64-randomness'),
    ).rejects.toThrow(/placeholder/);
  });
});

describe('the ciphertext itself', () => {
  it('does not contain the plaintext', async () => {
    const marker = 'ledger-entry-hash-0deadbeef';
    const plain = join(dir, 'marker.bin');
    const sealed = join(dir, 'marker.enc');
    await writeFile(plain, `x${marker}x`.repeat(100));
    await encryptFile(plain, sealed, KEY);
    expect((await readFile(sealed)).includes(marker)).toBe(false);
  });

  it('produces a different ciphertext each time, from a fresh IV', async () => {
    const plain = join(dir, 'iv.bin');
    await writeFile(plain, Buffer.from('the same bytes every time'));
    const a = join(dir, 'iv-a.enc');
    const b = join(dir, 'iv-b.enc');
    await encryptFile(plain, a, KEY);
    await encryptFile(plain, b, KEY);
    expect(Buffer.compare(await readFile(a), await readFile(b))).not.toBe(0);
  });
});
