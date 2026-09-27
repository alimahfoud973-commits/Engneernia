import { describe, it, expect } from 'vitest';
import { UploadTooLargeError, isSameOrigin, readBoundedBody, uploadFilename } from './upload-request';

/** A request whose body arrives in chunks, with no Content-Length — like a real stream. */
function streamed(chunks: number[], headers: Record<string, string> = {}): Request {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls >= chunks.length) return controller.close();
      controller.enqueue(new Uint8Array(chunks[pulls]!).fill(7));
      pulls += 1;
    },
  });
  return new Request('http://localhost/api/x', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
}

describe('readBoundedBody (S4-01)', () => {
  it('reads a small body whole', async () => {
    const body = await readBoundedBody(streamed([10, 20]), 100);
    expect(body.byteLength).toBe(30);
  });

  it('accepts a body of exactly the limit', async () => {
    expect((await readBoundedBody(streamed([60, 40]), 100)).byteLength).toBe(100);
  });

  it('accepts more than 1 MB — the Server Action ceiling this replaces', async () => {
    const mb = 1024 * 1024;
    expect((await readBoundedBody(streamed([mb, mb, 512]), 10 * mb)).byteLength).toBe(2 * mb + 512);
  });

  it('refuses a declared Content-Length over the limit before reading', async () => {
    const request = new Request('http://localhost/api/x', {
      method: 'POST', body: new Uint8Array(10), headers: { 'content-length': '1000' },
    });
    await expect(readBoundedBody(request, 100)).rejects.toBeInstanceOf(UploadTooLargeError);
  });

  it('refuses an undeclared body the moment it passes the limit, without buffering the rest', async () => {
    await expect(readBoundedBody(streamed([60, 60, 60]), 100)).rejects.toBeInstanceOf(UploadTooLargeError);
  });

  it('an empty request is an empty body', async () => {
    const request = new Request('http://localhost/api/x', { method: 'POST' });
    expect((await readBoundedBody(request, 100)).byteLength).toBe(0);
  });
});

describe('isSameOrigin', () => {
  const req = (headers: Record<string, string>) => new Request('http://localhost/api/x', { method: 'POST', headers });

  it('accepts our own origin', () => {
    expect(isSameOrigin(req({ origin: 'http://localhost:3000', host: 'localhost:3000' }))).toBe(true);
  });

  it('accepts our origin behind a proxy that sets x-forwarded-host', () => {
    expect(isSameOrigin(req({ origin: 'https://enginora.com', host: 'app:3000', 'x-forwarded-host': 'enginora.com' }))).toBe(true);
  });

  it('refuses another site, a missing Origin, and garbage', () => {
    expect(isSameOrigin(req({ origin: 'https://evil.example', host: 'localhost:3000' }))).toBe(false);
    expect(isSameOrigin(req({ host: 'localhost:3000' }))).toBe(false);
    expect(isSameOrigin(req({ origin: 'null', host: 'localhost:3000' }))).toBe(false);
  });
});

describe('uploadFilename', () => {
  const req = (name?: string) =>
    new Request('http://localhost/api/x', { method: 'POST', headers: name === undefined ? {} : { 'x-file-name': name } });

  it('decodes an Arabic name sent URI-encoded', () => {
    expect(uploadFilename(req(encodeURIComponent('دليل التصميم.pdf')))).toBe('دليل التصميم.pdf');
  });

  it('refuses a missing, blank, malformed or overlong name', () => {
    expect(uploadFilename(req())).toBeNull();
    expect(uploadFilename(req('%20%20'))).toBeNull();
    expect(uploadFilename(req('%E0%A4%A'))).toBeNull();
    expect(uploadFilename(req('a'.repeat(300)))).toBeNull();
  });
});
