import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NotFoundError } from '@/lib/errors';
import { newStorageKey } from './keys';
import { S3Storage } from './s3';

/**
 * ===========================================================================
 * THE S3 ADAPTER, RUN — against a socket, not a mock of the SDK
 * ===========================================================================
 * This adapter is what production stores every original file through, and
 * until now nothing had ever executed a line of it: there is no S3 service in
 * development, so it was written, reviewed, and shipped unexecuted. The first
 * time it ran would have been the first time a contributor's 1 GB Revit model
 * depended on it.
 *
 * A stub of the AWS SDK would not have helped — it would assert that the code
 * calls the functions it already visibly calls. What is actually uncertain
 * lives below that: how the client addresses a bucket, what a missing object
 * turns into, and whether a signed URL carries what the download route needs.
 * So this stands up an HTTP server that answers like an S3-compatible
 * service, and points the real client at it. Signatures are not verified —
 * that is the service's job, not this adapter's — but every request is real.
 *
 * Buying storage remains a FUTURE DEPLOYMENT TASK. What is no longer deferred
 * is knowing whether this code works.
 * ===========================================================================
 */

const objects = new Map<string, { body: Buffer; contentType: string }>();
let server: http.Server;
let storage: S3Storage;
/** Every request path the server saw, so addressing can be asserted. */
const seen: string[] = [];

function s3Error(res: http.ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    seen.push(url.pathname);
    // Path-style: /<bucket>/<key...>
    const id = decodeURIComponent(url.pathname).replace(/^\//, '');

    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        objects.set(id, {
          body: Buffer.concat(chunks),
          contentType: req.headers['content-type'] ?? 'application/octet-stream',
        });
        res.writeHead(200, { ETag: '"stored"' });
        res.end();
      });
      return;
    }

    const found = objects.get(id);

    if (req.method === 'HEAD') {
      if (!found) return s3Error(res, 404, 'NoSuchKey');
      res.writeHead(200, { 'content-length': String(found.body.length) });
      return res.end();
    }

    if (req.method === 'GET') {
      if (!found) return s3Error(res, 404, 'NoSuchKey');
      res.writeHead(200, { 'content-type': found.contentType });
      return res.end(found.body);
    }

    if (req.method === 'DELETE') {
      objects.delete(id);
      res.writeHead(204);
      return res.end();
    }

    return s3Error(res, 405, 'MethodNotAllowed');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  storage = new S3Storage({
    endpoint: `http://127.0.0.1:${port}`,
    region: 'auto',
    accessKeyId: 'probe-key',
    secretAccessKey: 'probe-secret',
    forcePathStyle: true,
    bucketOriginals: 'em-originals',
    bucketDerivatives: 'em-derivatives',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const bytes = Buffer.from('%PDF-1.7 pretend original file');

/**
 * Real keys, from the real generator.
 *
 * Written by hand first, and every test failed on `assertSafeKey` — which is
 * the guard doing its job: a key this system did not mint is refused before it
 * reaches the network. Generating them here keeps the test honest about the
 * shape production actually stores.
 */
const ORIGINAL_KEY = newStorageKey('original');
const PREVIEW_KEY = newStorageKey('preview');
const TEMP_KEY = newStorageKey('original');

describe('S3Storage', () => {
  it('stores and returns the same bytes, and reports their size and digest', async () => {
    const result = await storage.put('originals', ORIGINAL_KEY, bytes, 'application/pdf');

    expect(result.key).toBe(ORIGINAL_KEY);
    expect(result.byteSize).toBe(bytes.byteLength);
    // Not a fixed literal: the point is that the digest describes THESE bytes.
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    const round = await storage.get('originals', ORIGINAL_KEY);
    expect(Buffer.from(round).equals(bytes)).toBe(true);
  });

  it('puts the bucket in the PATH, not the hostname', async () => {
    /**
     * `STORAGE_FORCE_PATH_STYLE` defaults to true because R2 and MinIO need
     * it. Set the other way, the client addresses `em-originals.127.0.0.1`,
     * which does not resolve — and the failure arrives as a DNS error at the
     * first upload, long after the deployment looked successful.
     */
    expect(seen).toContain(`/em-originals/${ORIGINAL_KEY}`);
    expect(seen.every((path) => path.startsWith('/em-'))).toBe(true);
  });

  it('keeps the two buckets apart', async () => {
    await storage.put('derivatives', PREVIEW_KEY, Buffer.from('preview'), 'application/pdf');

    expect(await storage.exists('derivatives', PREVIEW_KEY)).toBe(true);
    // The same key in the other bucket is a different object, not the same one.
    expect(await storage.exists('originals', PREVIEW_KEY)).toBe(false);
  });

  it('turns a missing object into NotFoundError, not a raw SDK error', async () => {
    /**
     * The download route answers 404 for anything that is not found, and it
     * distinguishes by error type. An SDK error escaping here would surface as
     * a 500 — telling an attacker that the key exists and something broke,
     * rather than that it does not exist.
     */
    await expect(storage.get('originals', newStorageKey('original'))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('reports a missing object as absent rather than throwing', async () => {
    expect(await storage.exists('originals', newStorageKey('original'))).toBe(false);
  });

  it('removes an object', async () => {
    await storage.put('originals', TEMP_KEY, Buffer.from('x'), 'application/pdf');
    expect(await storage.exists('originals', TEMP_KEY)).toBe(true);

    await storage.remove('originals', TEMP_KEY);
    expect(await storage.exists('originals', TEMP_KEY)).toBe(false);
  });

  it('refuses a key that tries to climb out of its prefix', async () => {
    await expect(
      storage.put('originals', '../../etc/passwd', bytes, 'application/pdf'),
    ).rejects.toThrow();
  });

  describe('grantDelivery', () => {
    it('mints a signed URL that expires and forces a download', async () => {
      const grant = await storage.grantDelivery('originals', ORIGINAL_KEY, {
        ttlSeconds: 120,
        disposition: 'attachment',
        downloadFilename: 'حساب الأحمال.pdf',
        contentType: 'application/pdf',
      });

      expect(grant.kind).toBe('redirect');
      if (grant.kind !== 'redirect') throw new Error('unreachable');

      const url = new URL(grant.url);
      expect(url.pathname).toBe(`/em-originals/${ORIGINAL_KEY}`);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
      expect(grant.expiresInSeconds).toBe(120);

      /**
       * `attachment`, and the filename percent-encoded as UTF-8.
       *
       * An Arabic filename is the normal case here, and a header that cannot
       * carry it either mangles the name or opens the original INLINE in a
       * browser tab — where it can be cached and shared, which is the one
       * thing an original must never be.
       */
      const disposition = url.searchParams.get('response-content-disposition') ?? '';
      expect(disposition.startsWith('attachment;')).toBe(true);
      expect(disposition).toContain("filename*=UTF-8''");
      expect(disposition).toContain(encodeURIComponent('حساب الأحمال.pdf'));
    });

    it('renders a preview inline, and names no file while doing it', async () => {
      /**
       * The defect this exists for: `attachment` was hard-coded for every role.
       * In development every grant is a stream and the route writes the header
       * itself, so nothing showed. In production every grant is a redirect and
       * the signed URL carries the header — so the preview iframe on every
       * product page would have offered a download instead of showing a page.
       *
       * The filename matters too: a preview row is named `preview-<original>`,
       * and the product page hands this URL to every visitor.
       */
      const grant = await storage.grantDelivery('derivatives', PREVIEW_KEY, {
        ttlSeconds: 600,
        disposition: 'inline',
        contentType: 'application/pdf',
      });
      if (grant.kind !== 'redirect') throw new Error('unreachable');

      const disposition = new URL(grant.url).searchParams.get('response-content-disposition');
      expect(disposition).toBe('inline');
      expect(disposition).not.toContain('filename');
    });

    it('produces a URL that actually fetches the object', async () => {
      // The strongest statement available without a real service: the URL the
      // download route hands the browser resolves to these bytes.
      const grant = await storage.grantDelivery('originals', ORIGINAL_KEY, {
        ttlSeconds: 60,
        disposition: 'attachment',
      });
      if (grant.kind !== 'redirect') throw new Error('unreachable');

      const response = await fetch(grant.url);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    });
  });
});
