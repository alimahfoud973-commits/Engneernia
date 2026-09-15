import 'server-only';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import {
  ARABIC_FONT, ARABIC_FONT_BOLD, assertArabicFonts, ltr,
} from '@/lib/typography/arabic';
import { minorDigitsOf, type CurrencyCode } from '@/lib/money/currency';

/**
 * ===========================================================================
 * THE TAX INVOICE AS A PDF (owner decision on OPEN-9)
 * ===========================================================================
 * Rendered ON DEMAND from the frozen `invoices` row, and stored nowhere — the
 * same decision as the settlement statement, for the same three reasons: the
 * record is immutable so the document is reproducible, a stored PDF is a
 * second copy of financial data to protect and eventually contradict, and
 * authorisation stays the row-level policy that guards the record itself.
 *
 * Drawn on a canvas rather than typeset, because pdf-lib has no text shaping
 * and would render Arabic as disconnected, reversed letters. See
 * `src/lib/typography/arabic.ts`; this is a project rule, not a preference.
 *
 * WHAT IT MUST SAY, AND WHY EACH LINE IS THERE
 *   the number        a numbered series is what makes it an invoice
 *   the date          the period it belongs to
 *   seller and buyer  who owes whom
 *   net, tax, total   the split, spelled out — a total alone is not a tax
 *                     invoice, and the rate has to be visible
 *   the tax number    when the platform has one
 * ===========================================================================
 */

const PAGE = { width: 1240, height: 1754, dpi: 150 } as const;
const MARGIN = 90;

const INK = '#14181d';
const INK_SOFT = '#5b6673';
const INK_FAINT = '#8a94a1';
const LINE = '#d8dde3';

export interface InvoiceLine {
  readonly title: string;
  /** The catalogue price before any discount (OPEN-1). */
  readonly listMinor: bigint;
  readonly discountMinor: bigint;
  readonly grossMinor: bigint;
  readonly taxMinor: bigint;
  readonly netMinor: bigint;
}

export interface InvoiceDocument {
  readonly invoiceNumber: string;
  readonly issuedAt: Date;
  readonly currency: string;
  /** Sum of the lines' list prices, before any discount (OPEN-1). */
  readonly listMinor: bigint;
  readonly discountMinor: bigint;
  readonly grossMinor: bigint;
  readonly taxMinor: bigint;
  readonly netMinor: bigint;
  readonly taxBp: number;
  readonly taxNameAr: string;
  readonly taxRegistration: string | null;
  readonly sellerNameAr: string;
  readonly sellerAddressAr: string | null;
  readonly buyerName: string;
  readonly buyerEmail: string;
  readonly orderNumber: string;
  readonly lines: readonly InvoiceLine[];
}

/** Money for print. Never fed back into a calculation (CLAUDE.md rule 2). */
function money(amountMinor: bigint, currency: string): string {
  const digits = minorDigitsOf(currency as CurrencyCode);
  const scale = 10n ** BigInt(digits);
  const whole = (amountMinor / scale).toString();
  const fraction = (amountMinor % scale).toString().padStart(digits, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${digits === 0 ? grouped : `${grouped}.${fraction}`} ${currency}`;
}

const formatDate = (value: Date) => value.toISOString().slice(0, 10);

/** The rate as a percentage, for the one place a human reads it. */
function ratePercent(bp: number): string {
  const whole = Math.floor(bp / 100);
  const fraction = bp % 100;
  return fraction === 0 ? `${whole}%` : `${whole}.${String(fraction).padStart(2, '0')}%`;
}

function rtl(ctx: SKRSContext2D, text: string, x: number, y: number): void {
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.fillText(text, x, y);
}

function latin(ctx: SKRSContext2D, text: string, x: number, y: number): void {
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.fillText(text, x, y);
}

function rule(ctx: SKRSContext2D, y: number, colour = LINE): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y);
  ctx.lineTo(PAGE.width - MARGIN, y);
  ctx.stroke();
}

export async function renderInvoicePdf(doc: InvoiceDocument): Promise<Uint8Array> {
  assertArabicFonts();

  const canvas = createCanvas(PAGE.width, PAGE.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE.width, PAGE.height);

  const right = PAGE.width - MARGIN;
  const left = MARGIN;
  let y = MARGIN + 20;

  // --- header ---------------------------------------------------------------
  ctx.fillStyle = INK;
  ctx.font = `36px ${ARABIC_FONT_BOLD}`;
  // "فاتورة" alone is a receipt. A tax invoice says so, because that is the
  // document an authority recognises.
  rtl(ctx, doc.taxBp > 0 ? 'فاتورة ضريبية' : 'فاتورة', right, y);

  ctx.fillStyle = INK_SOFT;
  ctx.font = `22px ${ARABIC_FONT}`;
  latin(ctx, doc.invoiceNumber, left, y);

  y += 46;
  ctx.fillStyle = INK_FAINT;
  ctx.font = `18px ${ARABIC_FONT}`;
  rtl(ctx, doc.sellerNameAr, right, y);
  latin(ctx, formatDate(doc.issuedAt), left, y);

  y += 28;
  if (doc.sellerAddressAr) {
    rtl(ctx, doc.sellerAddressAr, right, y);
    y += 26;
  }
  if (doc.taxRegistration) {
    rtl(ctx, `الرقم الضريبي: ${ltr(doc.taxRegistration)}`, right, y);
    y += 26;
  }

  y += 16;
  rule(ctx, y);
  y += 44;

  // --- buyer ----------------------------------------------------------------
  ctx.fillStyle = INK_SOFT;
  ctx.font = `18px ${ARABIC_FONT}`;
  rtl(ctx, 'المشتري', right, y);
  y += 30;
  ctx.fillStyle = INK;
  ctx.font = `22px ${ARABIC_FONT}`;
  rtl(ctx, doc.buyerName, right, y);
  ctx.font = `18px ${ARABIC_FONT}`;
  ctx.fillStyle = INK_SOFT;
  latin(ctx, doc.buyerEmail, left, y);

  y += 30;
  ctx.fillStyle = INK_FAINT;
  ctx.font = `16px ${ARABIC_FONT}`;
  rtl(ctx, `مرجع الطلب: ${ltr(doc.orderNumber)}`, right, y);

  y += 40;
  rule(ctx, y);
  y += 44;

  // --- lines ----------------------------------------------------------------
  ctx.fillStyle = INK_FAINT;
  ctx.font = `16px ${ARABIC_FONT}`;
  rtl(ctx, 'البند', right, y);
  latin(ctx, 'المبلغ', left, y);
  y += 12;
  rule(ctx, y);
  y += 34;

  const MAX_LINES = 22;
  const shown = Math.min(doc.lines.length, MAX_LINES);
  for (let index = 0; index < shown; index += 1) {
    const line = doc.lines[index]!;
    ctx.fillStyle = INK;
    ctx.font = `20px ${ARABIC_FONT}`;
    rtl(ctx, line.title, right, y);
    ctx.fillStyle = INK_SOFT;
    ctx.font = `18px ${ARABIC_FONT}`;
    latin(ctx, money(line.grossMinor, doc.currency), left, y);
    y += 34;

    /*
     * The line's own discount, under the line it belongs to. A customer
     * checking a total against the prices they remember needs to see where the
     * difference came from on the line that carries it — an aggregate at the
     * foot of a multi-line invoice does not tell them that.
     */
    if (line.discountMinor > 0n) {
      ctx.fillStyle = INK_FAINT;
      ctx.font = `15px ${ARABIC_FONT}`;
      rtl(ctx, `السعر ${ltr(money(line.listMinor, doc.currency))} — بعد الخصم`, right, y);
      latin(ctx, `−${money(line.discountMinor, doc.currency)}`, left, y);
      y += 28;
    }
  }

  const omitted = doc.lines.length - shown;
  if (omitted > 0) {
    ctx.fillStyle = INK_FAINT;
    ctx.font = `16px ${ARABIC_FONT}`;
    // The totals below always describe the whole invoice, so the document
    // never shows a total its own lines contradict.
    rtl(ctx, `و${ltr(String(omitted))} بنداً آخر — المجاميع أدناه تشمل الفاتورة كاملة.`, right, y);
    y += 34;
  }

  y += 10;
  rule(ctx, y);
  y += 44;

  // --- the split ------------------------------------------------------------
  // Spelled out, because a total alone is not a tax invoice: the base, the
  // rate and the tax have to be readable separately.
  const rows: Array<[string, string, boolean]> = [
    /*
     * The list total and the discount appear only when there IS one (OPEN-1).
     * On every invoice this platform has issued so far the discount is zero,
     * and a row reading "الخصم — 0.00" on each of them would be noise that
     * makes the document look like it is hiding a promotion.
     */
    ...(doc.discountMinor > 0n
      ? ([
          ['المجموع قبل الخصم', money(doc.listMinor, doc.currency), false],
          ['الخصم', `−${money(doc.discountMinor, doc.currency)}`, false],
        ] as Array<[string, string, boolean]>)
      : []),
    ['المجموع قبل الضريبة', money(doc.netMinor, doc.currency), false],
    [
      doc.taxBp > 0
        ? `${doc.taxNameAr} (${ltr(ratePercent(doc.taxBp))})`
        : `${doc.taxNameAr} — غير مطبَّقة`,
      money(doc.taxMinor, doc.currency),
      false,
    ],
    ['الإجمالي المدفوع', money(doc.grossMinor, doc.currency), true],
  ];

  for (const [label, value, emphasised] of rows) {
    ctx.fillStyle = emphasised ? INK : INK_SOFT;
    ctx.font = `${emphasised ? 26 : 20}px ${emphasised ? ARABIC_FONT_BOLD : ARABIC_FONT}`;
    rtl(ctx, label, right, y);
    latin(ctx, value, left, y);
    y += emphasised ? 42 : 34;
  }

  // --- footer ---------------------------------------------------------------
  const footerY = PAGE.height - MARGIN - 40;
  rule(ctx, footerY - 34);
  ctx.fillStyle = INK_FAINT;
  ctx.font = `16px ${ARABIC_FONT}`;
  rtl(
    ctx,
    doc.taxBp > 0
      ? 'السعر المعروض يشمل الضريبة، وهي مستخرَجة منه أعلاه.'
      : 'لا ضريبة مطبَّقة على هذه الفاتورة.',
    right,
    footerY,
  );
  ctx.font = `15px ${ARABIC_FONT}`;
  latin(ctx, `${doc.invoiceNumber} · ${formatDate(doc.issuedAt)}`, left, footerY);

  // --- wrap the page in a PDF ----------------------------------------------
  const pdf = await PDFDocument.create();
  // No author or producer metadata: the document goes to a third party and
  // carries only what the invoice itself says.
  pdf.setTitle(`Invoice ${doc.invoiceNumber}`);
  pdf.setProducer('');
  pdf.setCreator('');

  const png = await pdf.embedPng(canvas.toBuffer('image/png'));
  const scale = 72 / PAGE.dpi;
  const page = pdf.addPage([PAGE.width * scale, PAGE.height * scale]);
  page.drawImage(png, { x: 0, y: 0, width: PAGE.width * scale, height: PAGE.height * scale });

  return pdf.save();
}
