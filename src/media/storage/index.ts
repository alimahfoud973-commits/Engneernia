import 'server-only';
import { serverEnv } from '@/lib/config/env';
import { LocalFilesystemStorage } from './local';
import { S3Storage } from './s3';
import type { StoragePort } from './port';

export * from './port';
export * from './keys';

let cached: StoragePort | undefined;

/**
 * Chooses an adapter from configuration, never from a build flag.
 *
 * A `file:` storage endpoint selects the filesystem adapter for local work;
 * anything else is treated as an S3-compatible service. Production is refused
 * the filesystem adapter outright — a single-node disk cannot survive the
 * container being replaced, and losing a contributor's original file is not
 * an error the platform can recover from.
 */
export function getStorage(): StoragePort {
  if (cached) return cached;
  const env = serverEnv();

  if (env.STORAGE_ENDPOINT.startsWith('file:')) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'Filesystem storage is not permitted in production. Configure an S3-compatible STORAGE_ENDPOINT.',
      );
    }
    const root = env.STORAGE_ENDPOINT.replace(/^file:\/\//, '');
    cached = new LocalFilesystemStorage(root);
    return cached;
  }

  cached = new S3Storage({
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    bucketOriginals: env.STORAGE_BUCKET_ORIGINALS,
    bucketDerivatives: env.STORAGE_BUCKET_DERIVATIVES,
  });
  return cached;
}

/** Test seam: forget the memoised adapter. */
export function resetStorageForTests(): void {
  cached = undefined;
}
