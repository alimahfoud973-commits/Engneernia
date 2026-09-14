import 'server-only';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import {
  ARABIC_FONT, ARABIC_FONT_BOLD, assertArabicFonts, ltr,
} from '@/lib/typography/arabic';
import { RuleViolationError } from '@/lib/errors';

/**
 * ===========================================================================
 * THE BUYER'S COPY (OPEN-5 — owner decision: name, order number, date)
 * ===========================================================================
 * THE STORED ORIGINAL IS NEVER TOUCHED.
 *
 * This reads the master bytes and returns NEW bytes. It does not write to
 * storage, does not re-upload, and holds no reference to the key it came
 * from — so there is no version of this function that could overwrite the
 * master by accident. The copy exists for the length of one response.
 *
 * WHY A STAMP AND NOT A RASTER. The preview is rasterised deliberately: its
 * job is to be unusable. This file is the opposite — the customer paid for it,
 * and it has to stay exactly as the engineer drew it: selectable text, real
 * vectors, layers intact. So the document's own content is left alone and the
 * stamp is drawn on top, page by page.
 *
 * WHY CANVAS. `pdf-lib` has no text shaping, so Arabic written through it
 * comes out as disconnected letters in reverse. Every Arabic page this
 * platform generates is drawn on a canvas and embedded as an image; this is
 * the same rule, applied to a strip instead of a page.
 *
 * NO EMAIL ADDRESS, by the owner's decision. The name, the order number and
 * the date identify the copy for tracing a leak. An address would make a
 * shared file carry a working contact for its buyer.
 * ===========================================================================
 */

export interface BuyerStamp {
  readonly buyerName: string;
  /**
   * Null when the entitlement has no order behind it — a manual grant, or an
   * order row since removed (`order_item_id` is ON DELETE SET NULL). The
   * segment is then left out rather than filled with a made-up reference: a
   * stamp that cites an order number nobody can look up is worse for tracing
   * a leak than one that cites none.
   */
  readonly orderNumber: string | null;
  readonly purchasedAt: Date;
}

/** Height of the strip drawn at the foot of every page, in PDF points. */
const STRIP_HEIGHT = 26;
/** Rendered at 3× and drawn down, so the text is sharp when printed. */
const SCALE = 3;

const INK = '#1a1a1a';
const INK_SOFT = '#6b6b6b';
const BAND = '#f4f1ea';
const LINE = '#d8d2c4';

function stampLine(stamp: BuyerStamp): string {
  const date = stamp.purchasedAt.toISOString().slice(0, 10);
  // The order number and the date stay in Latin digits inside directional
  // isolates: both are references a person may have to quote back, and an
  // isolate keeps "2026-09-14" from being reordered next to Arabic.
  const parts = [
    `نسخة مخصّصة — ${stamp.buyerName}`,
    stamp.orderNumber ? `طلب ${ltr(stamp.orderNumber)}` : null,
    ltr(date),
  ].filter((part): part is string => part !== null);

  return parts.join(' · ');
}

/**
 * Draws the strip once, at the width of one page.
 *
 * Pages in one document can differ in size, so the caller renders per distinct
 * width rather than assuming A4 throughout — a mixed-size drawing set is
 * completely ordinary in this catalogue.
 */
function renderStrip(text: string, widthPt: number): Uint8Array {
  assertArabicFonts();

  // Math.trunc, not Math.round: the repository bans Math.round outright so
  // that no money is ever rounded by it. This is a canvas width in pixels.
  const canvas = createCanvas(Math.max(1, Math.trunc(widthPt * SCALE)), STRIP_HEIGHT * SCALE);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BAND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = LINE;
  ctx.lineWidth = SCALE;
  ctx.beginPath();
  ctx.moveTo(0, SCALE / 2);
  ctx.lineTo(canvas.width, SCALE / 2);
  ctx.stroke();

  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.font = `${11 * SCALE}px ${ARABIC_FONT_BOLD}`;
  ctx.fillText(text, canvas.width - 10 * SCALE, canvas.height / 2);

  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.fillStyle = INK_SOFT;
  ctx.font = `${9 * SCALE}px ${ARABIC_FONT}`;
  ctx.fillText('Enginora', 10 * SCALE, canvas.height / 2);

  return canvas.toBuffer('image/png');
}

/**
 * Returns a personalised copy, built from a COPY of the master's bytes.
 *
 * Throws rather than falling back to the plain master: an unstamped copy that
 * looks stamped is worse than a failed download, because the whole point is
 * being able to say which purchase a leaked file came from. A published PDF is
 * openable by construction — the publication gate refuses a PDF with no
 * generated preview — so reaching the failure here means something is wrong
 * that the owner needs to see in the log.
 */
export async function stampPdfForBuyer(
  master: Uint8Array,
  stamp: BuyerStamp,
): Promise<Uint8Array> {
  /**
   * THE PARSER IS NEVER GIVEN THE MASTER'S OWN BUFFER.
   *
   * `master` is what came back from storage. Copying it here means the PDF
   * library, and everything it calls, operates on bytes that belong to this
   * function and to nothing else — so no future version of it, and no library
   * upgrade that decides to parse in place, can reach the buffer the original
   * was read into.
   *
   * The copy costs one allocation on a path that is already rewriting the
   * whole document, and it turns "we checked that it does not modify the
   * input" into "it is not holding the input" — the first is a property of
   * today's dependency, the second is a property of this code.
   *
   * BE HONEST ABOUT WHAT IT BUYS: no test fails if this line is removed, and
   * none can, because `pdf-lib` does not parse in place. It is insurance
   * against a future version or a replacement library that does, on the one
   * path where the cost of being wrong is a corrupted master. Kept for that
   * reason alone, and written down so nobody deletes it as dead weight or
   * trusts it as a tested guarantee.
   *
   * `new Uint8Array(view)` copies the VIEW, not its pool — which matters: the
   * bytes arriving here are routinely a Node Buffer pointing into a shared
   * pool at a non-zero offset, and reaching past the view would read a
   * neighbour's memory into a customer's file. That part IS tested.
   */
  const working = new Uint8Array(master);

  let document: PDFDocument;
  try {
    document = await PDFDocument.load(working, { ignoreEncryption: false });
  } catch {
    throw new RuleViolationError('تعذّر تخصيص نسخة من هذا الملف', {
      reason: 'the master PDF could not be opened for stamping',
    });
  }

  const pages = document.getPages();
  if (pages.length === 0) {
    throw new RuleViolationError('تعذّر تخصيص نسخة من هذا الملف', { reason: 'no pages' });
  }

  const text = stampLine(stamp);
  // One render per distinct page width, not one per page: a 300-page drawing
  // set is one image, embedded once and drawn 300 times.
  const strips = new Map<number, Awaited<ReturnType<typeof document.embedPng>>>();

  for (const page of pages) {
    const { width } = page.getSize();
    // Grouping key for the strip cache — a page width in points, truncated.
    const key = Math.trunc(width);

    let image = strips.get(key);
    if (!image) {
      image = await document.embedPng(renderStrip(text, width));
      strips.set(key, image);
    }

    page.drawImage(image, { x: 0, y: 0, width, height: STRIP_HEIGHT });
  }

  return document.save();
}
