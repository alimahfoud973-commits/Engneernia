import 'server-only';
import * as mupdf from 'mupdf';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { RuleViolationError, ValidationError } from '@/lib/errors';

/**
 * ===========================================================================
 * PUBLIC PREVIEW GENERATION (specification §26, §27)
 * ===========================================================================
 * For a 120-page book the public gets pages 1–5 and nothing else.
 *
 * The protection is STRUCTURAL, not cosmetic. Each preview page is:
 *   1. RASTERISED — the output holds pixels, so there is no text layer to
 *      copy, no vector geometry to extract and no embedded font to lift;
 *   2. WATERMARKED INTO THOSE PIXELS — the mark is part of the image, not an
 *      overlay object a PDF editor can select and delete;
 *   3. ASSEMBLED FROM SCRATCH — the preview is a NEW document containing only
 *      those five images. Pages 6 onward are not hidden in it. They are not
 *      in it at all.
 *
 * Nothing here depends on the browser. A reader who downloads the preview and
 * opens it offline still has five low-resolution pages.
 * ===========================================================================
 */

export interface PreviewOptions {
  /** Specification §26: five pages. A Settings value, not a constant. */
  readonly maxPages?: number;
  /** Resolution of the rasterised pages. Legible, not reusable as a substitute. */
  readonly dpi?: number;
  /**
   * ASCII by default: the watermark is drawn by a canvas that has no Arabic
   * font registered, and unrendered glyphs would produce boxes across every
   * preview. Bundling an Arabic face and switching this is P8 polish.
   */
  readonly watermarkText?: string;
}

export interface PreviewResult {
  readonly pdf: Uint8Array;
  readonly sourcePageCount: number;
  readonly previewPageCount: number;
  readonly dpi: number;
}

const DEFAULTS = {
  maxPages: 5,
  dpi: 110,
  watermarkText: 'PREVIEW - ENGINEERING PLATFORM',
} as const;

/** Reads the page count without rendering anything. */
export function pdfPageCount(source: Uint8Array): number {
  const document = openPdf(source);
  try {
    return document.countPages();
  } finally {
    document.destroy?.();
  }
}

function openPdf(source: Uint8Array) {
  if (source.byteLength === 0) {
    throw new ValidationError('ملف PDF فارغ');
  }
  try {
    return mupdf.Document.openDocument(source, 'application/pdf');
  } catch {
    // A corrupt or password-protected file must fail here, loudly, rather
    // than produce an empty preview that looks like a successful run.
    throw new RuleViolationError('تعذّر فتح ملف PDF — قد يكون تالفاً أو محمياً بكلمة مرور');
  }
}

/**
 * Burns the watermark into the pixels of one rasterised page.
 *
 * Drawn twice — a wide diagonal band across the middle and a footer line — so
 * that cropping the image does not remove every trace of it.
 */
async function watermarkPage(pngBytes: Uint8Array, text: string): Promise<Buffer> {
  const image = await loadImage(Buffer.from(pngBytes));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(image, 0, 0);

  // eslint-disable-next-line no-restricted-properties -- pixel geometry.
  const diagonalSize = Math.max(18, Math.round(image.width / 16));
  ctx.save();
  ctx.translate(image.width / 2, image.height / 2);
  ctx.rotate(-Math.atan2(image.height, image.width));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${diagonalSize}px sans-serif`;
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#12655c';
  ctx.fillText(text, 0, 0);
  // A thin outline keeps the mark legible over dark drawings as well as
  // over white book pages.
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = Math.max(1, diagonalSize / 22);
  ctx.strokeStyle = '#ffffff';
  ctx.strokeText(text, 0, 0);
  ctx.restore();

  // eslint-disable-next-line no-restricted-properties -- pixel geometry.
  const footerSize = Math.max(11, Math.round(image.width / 55));
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#12655c';
  ctx.font = `600 ${footerSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(text, image.width / 2, image.height - footerSize);
  ctx.restore();

  return canvas.toBuffer('image/png');
}

/**
 * Build the public preview for a PDF.
 *
 * Only ever called for products whose file type is PDF — the owner's decision
 * is that Excel, DWG, Revit and archives have no preview at all, so there is
 * no silent fallback here that would produce a misleading empty document.
 */
export async function generatePdfPreview(
  source: Uint8Array,
  options: PreviewOptions = {},
): Promise<PreviewResult> {
  const maxPages = options.maxPages ?? DEFAULTS.maxPages;
  const dpi = options.dpi ?? DEFAULTS.dpi;
  const watermarkText = options.watermarkText ?? DEFAULTS.watermarkText;

  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new ValidationError('عدد صفحات المعاينة يجب أن يكون عدداً صحيحاً موجباً', { maxPages });
  }

  const document = openPdf(source);
  const sourcePageCount = document.countPages();
  if (sourcePageCount === 0) {
    throw new RuleViolationError('ملف PDF لا يحتوي أي صفحات');
  }

  const previewPageCount = Math.min(maxPages, sourcePageCount);
  const scale = mupdf.Matrix.scale(dpi / 72, dpi / 72);
  const output = await PDFDocument.create();

  try {
    for (let index = 0; index < previewPageCount; index += 1) {
      const page = document.loadPage(index);
      const pixmap = page.toPixmap(scale, mupdf.ColorSpace.DeviceRGB, false, true);
      const marked = await watermarkPage(pixmap.asPNG(), watermarkText);

      const embedded = await output.embedPng(marked);
      const pdfPage = output.addPage([embedded.width, embedded.height]);
      pdfPage.drawImage(embedded, {
        x: 0,
        y: 0,
        width: embedded.width,
        height: embedded.height,
      });
    }
  } finally {
    document.destroy?.();
  }

  // Strip identifying metadata: the preview is a public artifact and should
  // not carry the producer's name, the source path or a creation trail.
  output.setTitle('Preview');
  output.setProducer('');
  output.setCreator('');
  output.setAuthor('');
  output.setSubject('');

  return {
    pdf: await output.save(),
    sourcePageCount,
    previewPageCount,
    dpi,
  };
}
