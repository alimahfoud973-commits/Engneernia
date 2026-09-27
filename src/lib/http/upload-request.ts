import 'server-only';

/**
 * ===========================================================================
 * FILE UPLOADS ARRIVE AS A BOUNDED STREAM, NOT AS A SERVER ACTION (S4-01)
 * ===========================================================================
 * A Server Action parses its whole body before any line of ours runs, and
 * Next refuses a body over 1 MB there — so every product file and every
 * payment receipt over 1 MB failed with a 500 before authorisation, the size
 * check or the scan could say anything. Raising that limit to the largest
 * file we accept (1 GB) would apply it to EVERY action on the site.
 *
 * Uploads therefore go to Route Handlers under /api, which read the body
 * themselves: the file is the raw request body, its name travels in a header,
 * and the stream is cut off the moment it passes the ceiling for its kind.
 * Authorisation, validation, the scan and storage stay exactly where they
 * were — in `ingestProductFile` and `submitPaymentProof`.
 * ===========================================================================
 */

export class UploadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`upload exceeds ${limitBytes} bytes`);
    this.name = 'UploadTooLargeError';
  }
}

/**
 * Read the request body, refusing past `limitBytes` WITHOUT buffering the rest.
 *
 * A declared Content-Length over the limit is refused before a byte is read;
 * an undeclared or understated one is caught while streaming.
 */
export async function readBoundedBody(request: Request, limitBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limitBytes) throw new UploadTooLargeError(limitBytes);
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UploadTooLargeError(limitBytes);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * The same-origin check a Server Action gets from Next, made explicit here.
 *
 * The session cookie is SameSite=Lax, so a cross-site POST carries no session
 * already; this refuses the request outright rather than lean on that alone.
 * A request with no Origin is refused too — every browser sends one on a
 * fetch POST, and these endpoints are called by our own page and nothing else.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    || request.headers.get('host');
  return host !== null && host !== '' && originHost === host;
}

/** The file name, sent URI-encoded in a header (a header cannot carry Arabic raw). */
export function uploadFilename(request: Request): string | null {
  const raw = request.headers.get('x-file-name');
  if (!raw) return null;
  try {
    const name = decodeURIComponent(raw).trim();
    return name === '' || name.length > 255 ? null : name;
  } catch {
    return null;
  }
}
