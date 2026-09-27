/**
 * Send one file to an upload Route Handler (S4-01).
 *
 * The file is the raw body and its name a URI-encoded header — no multipart
 * parser, so the server can cut the stream off at its ceiling. The answer is
 * always the `{ error }` envelope; anything else (a proxy's HTML error page, a
 * dropped connection) becomes a sentence rather than an exception in the page.
 */
export interface UploadAnswer {
  readonly error: string | null;
  readonly waiting?: number;
}

const UNREADABLE = 'تعذّر رفع الملف. حاول مرة أخرى.';
const NOT_FOUND = 'تعذّر رفع الملف: الطلب أو المنتج غير متاح.';

export async function uploadFile(
  url: string,
  file: File,
  extraHeaders: Record<string, string> = {},
): Promise<UploadAnswer> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      body: file,
      credentials: 'same-origin',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
        ...extraHeaders,
      },
    });
  } catch {
    return { error: UNREADABLE };
  }
  let answer: UploadAnswer;
  try {
    answer = (await response.json()) as UploadAnswer;
  } catch {
    return { error: response.status === 413 ? 'حجم الملف يتجاوز الحد المسموح' : UNREADABLE };
  }
  if (answer.error === 'NOT_FOUND') return { error: NOT_FOUND };
  if (!response.ok && !answer.error) return { error: UNREADABLE };
  return answer;
}
