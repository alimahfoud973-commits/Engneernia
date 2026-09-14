import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { stampPdfForBuyer } from './personalise';

/**
 * The owner's condition on OPEN-5: the personalisation goes on the copy handed
 * to the buyer, never on the stored original. These tests are that condition,
 * written down.
 */

const STAMP = {
  buyerName: 'محمد الأحمد',
  orderNumber: 'ORD-2026-000412',
  purchasedAt: new Date('2026-09-14T10:00:00Z'),
} as const;

async function makePdf(pages: Array<{ width: number; height: number }>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [index, size] of pages.entries()) {
    const page = doc.addPage([size.width, size.height]);
    page.drawText(`ORIGINAL CONTENT PAGE ${index + 1}`, { x: 60, y: size.height - 80, size: 14, font });
  }
  return doc.save();
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('stampPdfForBuyer', () => {
  it('does not modify the master it was given', async () => {
    // THE RULE. Whatever else this does, the bytes that came out of storage
    // must be the bytes that are still in storage.
    const master = await makePdf([{ width: 595, height: 842 }]);
    const before = sha(master);
    const copy = new Uint8Array(master); // a witness the call cannot reach

    await stampPdfForBuyer(master, STAMP);

    expect(sha(master)).toBe(before);
    expect(Buffer.from(master).equals(Buffer.from(copy))).toBe(true);
  });

  it('builds from a copy, so a view into a pooled buffer works the same', async () => {
    /**
     * The owner's condition, as a property of this code rather than of the PDF
     * library's current behaviour: the parser is handed bytes this function
     * owns, never the buffer the master was read into.
     *
     * A view is how that shows up in practice. Bytes arriving from storage are
     * frequently a Node Buffer pointing into a shared pool at a non-zero
     * offset — so anything that reached past the view, to `.buffer`, would
     * read a neighbour's memory into a customer's file. Stamping a view must
     * give exactly what stamping the standalone bytes gives.
     */
    const master = await makePdf([{ width: 595, height: 842 }]);

    const pool = Buffer.alloc(master.byteLength + 128, 0xab);
    pool.set(master, 64);
    const view = pool.subarray(64, 64 + master.byteLength);
    expect(view.byteOffset).toBe(64);

    const fromView = await stampPdfForBuyer(view, STAMP);
    const fromStandalone = await stampPdfForBuyer(master, STAMP);

    // Same page count and same extractable content: the view was read as the
    // document it is, and nothing around it came along.
    const a = await PDFDocument.load(fromView);
    expect(a.getPageCount()).toBe(1);
    expect(mupdf.Document.openDocument(fromView, 'application/pdf')
      .loadPage(0).toStructuredText('preserve-whitespace').asText())
      .toContain('ORIGINAL CONTENT PAGE 1');

    expect(Buffer.from(pool.subarray(0, 64)).every((b) => b === 0xab)).toBe(true);
    expect(fromStandalone.byteLength).toBeGreaterThan(0);
  });

  it('returns different bytes from the master', async () => {
    const master = await makePdf([{ width: 595, height: 842 }]);
    const stamped = await stampPdfForBuyer(master, STAMP);
    expect(sha(stamped)).not.toBe(sha(master));
  });

  it('keeps every page, and every page size', async () => {
    /**
     * A mixed-size drawing set is ordinary here — an A4 cover in front of A1
     * sheets. Losing or resizing a page would be the engineer's drawing
     * damaged by the platform, which is worse than no stamp at all.
     */
    const sizes = [
      { width: 595, height: 842 },
      { width: 1684, height: 2384 },
      { width: 595, height: 842 },
    ];
    const stamped = await stampPdfForBuyer(await makePdf(sizes), STAMP);

    const reopened = await PDFDocument.load(stamped);
    expect(reopened.getPageCount()).toBe(sizes.length);
    reopened.getPages().forEach((page, index) => {
      expect(Math.trunc(page.getSize().width)).toBe(sizes[index]!.width);
      expect(Math.trunc(page.getSize().height)).toBe(sizes[index]!.height);
    });
  });

  it('leaves the document content as the engineer drew it, still as text', async () => {
    /**
     * The preview is rasterised on purpose; this is the opposite. The buyer
     * paid for the real file, so its text has to stay text — searchable,
     * selectable, copyable into a calculation.
     *
     * Read through mupdf rather than by scanning the raw bytes: pdf-lib
     * compresses streams on save, so the first version of this test failed on
     * a file that was perfectly correct.
     */
    const stamped = await stampPdfForBuyer(await makePdf([{ width: 595, height: 842 }]), STAMP);

    const document = mupdf.Document.openDocument(stamped, 'application/pdf');
    const extracted = document.loadPage(0).toStructuredText('preserve-whitespace').asText();
    expect(extracted).toContain('ORIGINAL CONTENT PAGE 1');
  });

  it('produces a different copy for a different buyer', async () => {
    // Tracing a leak back to one purchase is the entire purpose.
    const master = await makePdf([{ width: 595, height: 842 }]);
    const a = await stampPdfForBuyer(master, STAMP);
    const b = await stampPdfForBuyer(master, { ...STAMP, buyerName: 'سارة خليل', orderNumber: 'ORD-2026-000999' });
    expect(sha(a)).not.toBe(sha(b));
  });

  it('refuses rather than returning an unstamped file', async () => {
    /**
     * An unstamped copy that everyone believes is stamped is worse than a
     * failed download: it is the one case where the platform would be unable
     * to say which purchase a leaked file came from, while reporting success.
     */
    await expect(stampPdfForBuyer(Buffer.from('not a pdf at all'), STAMP)).rejects.toThrow();
    await expect(stampPdfForBuyer(new Uint8Array(0), STAMP)).rejects.toThrow();
  });
});
