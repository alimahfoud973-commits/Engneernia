import 'server-only';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NotFoundError } from '@/lib/errors';
import type { BucketName, DeliveryGrant, PutResult, StoragePort } from './port';
import { assertSafeKey, sha256Of } from './keys';

/**
 * S3-compatible private storage (Cloudflare R2, MinIO, AWS S3).
 *
 * Credentials come ONLY from the validated STORAGE_* environment variables.
 * The SDK's default provider chain is deliberately bypassed: this process may
 * carry unrelated AWS_* variables from its host, and silently authenticating
 * with whatever happens to be in the environment is how a service ends up
 * writing to the wrong account.
 */
export class S3Storage implements StoragePort {
  readonly name = 's3';
  private readonly client: S3Client;
  private readonly buckets: Record<BucketName, string>;

  constructor(config: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    bucketOriginals: string;
    bucketDerivatives: string;
  }) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.buckets = {
      originals: config.bucketOriginals,
      derivatives: config.bucketDerivatives,
    };
  }

  private bucketFor(bucket: BucketName): string {
    return this.buckets[bucket];
  }

  async put(
    bucket: BucketName,
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<PutResult> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketFor(bucket),
        Key: key,
        Body: body,
        ContentType: contentType,
        // Objects are private. No ACL is set, and the buckets themselves
        // must be created with public access blocked.
        ChecksumAlgorithm: 'SHA256',
      }),
    );
    return { key, byteSize: body.byteLength, sha256: sha256Of(body) };
  }

  async get(bucket: BucketName, key: string): Promise<Uint8Array> {
    assertSafeKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketFor(bucket), Key: key }),
      );
      const bytes = await response.Body?.transformToByteArray();
      if (!bytes) throw new Error('empty body');
      return bytes;
    } catch {
      throw new NotFoundError('الملف غير موجود في التخزين', { bucket });
    }
  }

  async exists(bucket: BucketName, key: string): Promise<boolean> {
    assertSafeKey(key);
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketFor(bucket), Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async remove(bucket: BucketName, key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucketFor(bucket), Key: key }),
    );
  }

  /**
   * A signed URL, minted only after the caller has authorised the request.
   *
   * `ResponseContentDisposition` forces a download rather than inline
   * rendering, so an original never opens in a browser tab where it could be
   * cached, shared or embedded.
   */
  async grantDelivery(
    bucket: BucketName,
    key: string,
    options: {
      ttlSeconds: number;
      disposition: 'attachment' | 'inline';
      downloadFilename?: string;
      contentType?: string;
    },
  ): Promise<DeliveryGrant> {
    assertSafeKey(key);

    const filename = options.downloadFilename ?? 'download';
    /**
     * `inline` carries no filename.
     *
     * A preview is rendered in an iframe and never saved, so a name serves no
     * purpose there — and the preview row's name is derived from the original's
     * (`preview-<original>`), which is not something to put in a URL that the
     * product page hands to every visitor.
     */
    const disposition =
      options.disposition === 'inline'
        ? 'inline'
        : `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;

    const command = new GetObjectCommand({
      Bucket: this.bucketFor(bucket),
      Key: key,
      ResponseContentDisposition: disposition,
      ...(options.contentType ? { ResponseContentType: options.contentType } : {}),
    });

    const url = await getSignedUrl(this.client, command, { expiresIn: options.ttlSeconds });
    return { kind: 'redirect', url, expiresInSeconds: options.ttlSeconds };
  }
}
