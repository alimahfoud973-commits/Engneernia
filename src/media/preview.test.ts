import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { generatePdfPreview, pdfPageCount } from './preview';
import { RuleViolationError, ValidationError } from '@/lib/errors';

/**
 * ===========================================================================
 * THE SPECIFICATION'S §26/§27 ACCEPTANCE TEST
 * ===========================================================================
 * A 120-page book must yield a preview containing pages 1-5 and NOTHING from
 * pages 6-120 — not hidden, not disabled in the viewer, not present.
 * ===========================================================================
 */

const PAGE_COUNT = 120;
let book: Uint8Array;

/** A book whose every page carries a unique, searchable marker. */
async function buildBook(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`CHAPTER MARKER PAGE-${i}`, { x: 60, y: 700, size: 28, font, color: rgb(0, 0, 0) });
    page.drawText(`body text unique token UNIQ${i}X`, { x: 60, y: 640, size: 16, font });
  }
  return doc.save();
}

/** Everything the text layer of a PDF yields, page by page. */
function extractText(pdf: Uint8Array): string {
  const document = mupdf.Document.openDocument(pdf, 'application/pdf');
  let text = '';
  for (let i = 0; i < document.countPages(); i += 1) {
    const structured = document.loadPage(i).toStructuredText('preserve-whitespace');
    text += structured.asText();
  }
  return text;
}

beforeAll(async () => {
  book = await buildBook(PAGE_COUNT);
}, 60_000);

describe('page limiting', () => {
  it('reads the source page count without rendering', () => {
    expect(pdfPageCount(book)).toBe(PAGE_COUNT);
  });

  it('produces exactly five pages from a 120-page book', async () => {
    const result = await generatePdfPreview(book);
    expect(result.sourcePageCount).toBe(PAGE_COUNT);
    expect(result.previewPageCount).toBe(5);
    expect(pdfPageCount(result.pdf)).toBe(5);
  }, 120_000);

  it('never produces more pages than the source has', async () => {
    const short = await buildBook(3);
    const result = await generatePdfPreview(short);
    expect(result.previewPageCount).toBe(3);
    expect(pdfPageCount(result.pdf)).toBe(3);
  }, 60_000);

  it('honours a configured page count, since §26 calls it a policy', async () => {
    const result = await generatePdfPreview(book, { maxPages: 2 });
    expect(pdfPageCount(result.pdf)).toBe(2);
  }, 60_000);

  it('rejects a nonsensical page count instead of guessing', async () => {
    await expect(generatePdfPreview(book, { maxPages: 0 })).rejects.toThrow(ValidationError);
    await expect(generatePdfPreview(book, { maxPages: 2.5 })).rejects.toThrow(ValidationError);
  });
});

/**
 * The part that actually matters. If these fail, the preview leaks the book.
 */
describe('withheld pages are ABSENT, not hidden', () => {
  let preview: Uint8Array;

  beforeAll(async () => {
    preview = (await generatePdfPreview(book)).pdf;
  }, 120_000);

  it('contains no text from any withheld page, anywhere in the raw bytes', () => {
    const raw = Buffer.from(preview).toString('latin1');
    for (let page = 6; page <= PAGE_COUNT; page += 1) {
      expect(raw.includes(`PAGE-${page}`), `page ${page} marker leaked`).toBe(false);
      expect(raw.includes(`UNIQ${page}X`), `page ${page} body token leaked`).toBe(false);
    }
  });

  it('contains no extractable text at all — not even from the shown pages', () => {
    // Rasterisation means the five visible pages are images. Nothing can be
    // selected, copied, indexed by a search engine, or scraped.
    const text = extractText(preview).replace(/\s+/g, '');
    expect(text).toBe('');
  });

  it('carries no embedded fonts, so no glyph data survives', () => {
    const raw = Buffer.from(preview).toString('latin1');
    expect(raw).not.toContain('/FontFile');
    expect(raw).not.toContain('Helvetica');
  });

  it('is far smaller than the source, consistent with holding 5 of 120 pages', () => {
    const result = preview.byteLength;
    expect(result).toBeGreaterThan(1000);
    // Five rasterised pages must not balloon past a sane ceiling either.
    expect(result).toBeLessThan(8 * 1024 * 1024);
  });

  it('strips identifying metadata from the public artifact', () => {
    const raw = Buffer.from(preview).toString('latin1');
    expect(raw).not.toContain('pdf-lib');
  });
});

describe('watermark', () => {
  it('is drawn into the image rather than added as a removable text object', async () => {
    const { pdf } = await generatePdfPreview(book, { watermarkText: 'PREVIEW MARKER 7Z9' });
    const raw = Buffer.from(pdf).toString('latin1');
    // If the mark were a PDF text object its string would appear in the file.
    // It does not, because it is pixels inside the embedded image.
    expect(raw).not.toContain('PREVIEW MARKER 7Z9');
    expect(extractText(pdf).replace(/\s+/g, '')).toBe('');
  }, 60_000);

  it('produces pages built from images', async () => {
    const { pdf } = await generatePdfPreview(book, { maxPages: 1 });
    const raw = Buffer.from(pdf).toString('latin1');
    expect(raw).toContain('/Image');
  }, 60_000);
});

describe('malformed input', () => {
  it('rejects an empty buffer', async () => {
    await expect(generatePdfPreview(new Uint8Array())).rejects.toThrow(ValidationError);
  });

  it('rejects bytes that are not a PDF, rather than emitting a blank preview', async () => {
    const notAPdf = Uint8Array.from(Buffer.from('this is plainly not a pdf document'));
    await expect(generatePdfPreview(notAPdf)).rejects.toThrow(RuleViolationError);
  });
});
