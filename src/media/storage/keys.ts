import { randomUUID, createHash } from 'node:crypto';
import { ValidationError } from '@/lib/errors';

/**
 * Storage keys are RANDOM, never derived from a title or filename.
 *
 * A key derived from "حساب الأحمال الكهربائية.pdf" would be guessable, and
 * guessable keys are how private buckets leak. The original filename is kept
 * as metadata on the database row for display, and plays no part in the path.
 */
export function newStorageKey(prefix: 'original' | 'preview' | 'thumb' | 'proof'): string {
  const id = randomUUID();
  // Shard by the first two characters so no single directory or prefix grows
  // unbounded — matters for the local adapter and for S3 listing performance.
  return `${prefix}/${id.slice(0, 2)}/${id}`;
}

const SAFE_KEY = /^(original|preview|thumb|proof)\/[0-9a-f]{2}\/[0-9a-f-]{36}$/;

/**
 * Reject anything that is not a key this system generated.
 *
 * The guard exists because a key eventually arrives from a database row, and
 * a path-traversal value in that row must not be able to read an arbitrary
 * file from the host.
 */
export function assertSafeKey(key: string): string {
  if (!SAFE_KEY.test(key)) {
    throw new ValidationError('مفتاح تخزين غير صالح', { key });
  }
  return key;
}

export function sha256Of(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}
