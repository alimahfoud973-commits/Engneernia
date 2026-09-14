import 'server-only';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { NotFoundError, ValidationError } from '@/lib/errors';
import type { BucketName, DeliveryGrant, PutResult, StoragePort } from './port';
import { assertSafeKey, sha256Of } from './keys';

/**
 * Filesystem-backed storage for development and tests.
 *
 * It has no signing capability, so it always returns a `stream` grant — the
 * bytes go out through the application's authorised route and never through
 * a web server that could be pointed at the directory. That is the same
 * security posture as the S3 adapter, reached by a different means.
 */
export class LocalFilesystemStorage implements StoragePort {
  readonly name = 'local-filesystem';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(bucket: BucketName, key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, bucket, key));
    // Defence in depth: even with a validated key, never resolve outside root.
    if (!full.startsWith(this.root + sep)) {
      throw new ValidationError('مسار تخزين خارج الجذر المسموح');
    }
    return full;
  }

  async put(
    bucket: BucketName,
    key: string,
    body: Uint8Array,
    // Part of the StoragePort contract; a filesystem has nowhere to record it.
    // The content type is persisted on the product_files row instead.
    contentType: string,
  ): Promise<PutResult> {
    void contentType;
    const path = this.pathFor(bucket, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { key, byteSize: body.byteLength, sha256: sha256Of(body) };
  }

  async get(bucket: BucketName, key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.pathFor(bucket, key)));
    } catch {
      throw new NotFoundError('الملف غير موجود في التخزين', { bucket });
    }
  }

  async exists(bucket: BucketName, key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(bucket, key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(bucket: BucketName, key: string): Promise<void> {
    await rm(this.pathFor(bucket, key), { force: true });
  }

  async grantDelivery(
    bucket: BucketName,
    key: string,
    // `disposition` is accepted and unused: this adapter always streams, so the
    // route sets the header on the response it builds. Kept in the signature so
    // both adapters satisfy one port and a caller cannot forget to decide.
    options: { ttlSeconds: number; disposition: 'attachment' | 'inline'; contentType?: string },
  ): Promise<DeliveryGrant> {
    return {
      kind: 'stream',
      body: await this.get(bucket, key),
      contentType: options.contentType ?? 'application/octet-stream',
    };
  }
}
