/**
 * ===========================================================================
 * PRIVATE OBJECT STORAGE (specification §27, §36 — decisions §11)
 * ===========================================================================
 * One port, two adapters. Nothing above this interface knows whether bytes
 * live on a disk or in an S3 bucket, which is what lets the platform move
 * hosting without touching the catalogue or the entitlement logic.
 *
 * The invariant every adapter must uphold: THERE IS NO PUBLIC URL. An object
 * becomes reachable only after the application has authorised the request —
 * either by streaming it through an authorised route, or by minting a
 * short-lived signed URL at that moment.
 * ===========================================================================
 */

export type BucketName = 'originals' | 'derivatives';

export interface PutResult {
  readonly key: string;
  readonly byteSize: number;
  readonly sha256: string;
}

/**
 * How the caller should deliver an object it has already authorised.
 * `redirect` is an optimisation for large files in production; `stream` is
 * always correct and is what the local adapter uses.
 */
export type DeliveryGrant =
  | { readonly kind: 'redirect'; readonly url: string; readonly expiresInSeconds: number }
  | { readonly kind: 'stream'; readonly body: Uint8Array; readonly contentType: string };

export interface StoragePort {
  readonly name: string;
  put(bucket: BucketName, key: string, body: Uint8Array, contentType: string): Promise<PutResult>;
  get(bucket: BucketName, key: string): Promise<Uint8Array>;
  exists(bucket: BucketName, key: string): Promise<boolean>;
  remove(bucket: BucketName, key: string): Promise<void>;
  /**
   * Produce a delivery grant for an ALREADY AUTHORISED request.
   *
   * Adapters must never be called before the caller has checked entitlement:
   * this method deliberately takes no actor, so it cannot be mistaken for an
   * authorisation boundary.
   */
  grantDelivery(
    bucket: BucketName,
    key: string,
    options: { readonly ttlSeconds: number; readonly downloadFilename?: string; readonly contentType?: string },
  ): Promise<DeliveryGrant>;
}
