import 'server-only';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import {
  ARABIC_FONT, ARABIC_FONT_BOLD, assertArabicFonts, ltr,
} from '@/lib/typography/arabic';
import { minorDigitsOf, type CurrencyCode } from '@/lib/money/currency';
import type { SettlementSummary, StatementLine } from './queries';

/**
 * ===========================================================================
 * THE MONTHLY STATEMENT AS A PDF (specification §16, §18 — owner decision)
 * ===========================================================================
 *
 * The owner's instruction: a settlement statement the engineer can be sent,
 * MONTHLY — not per sale. A sale produces a notification; the month produces
 * this document.
 *
 * It is generated ON DEMAND from the frozen settlement record, and stored
 * nowhere. That is deliberate:
 *
 *   - the settlement is immutable once paid, so the same request always
 *     produces the same document; there is nothing to keep in sync;
 *   - a stored PDF is a second copy of financial data to protect, back up and
 *     eventually contradict the record it was made from;
 *   - authorisation is the same row-level policy that guards the settlement
 *     itself, so a document cannot be reachable by anyone the record is not.
 *
 * Rendered on a canvas rather than typeset with pdf-lib, because pdf-lib has
 * no text shaping and would produce disconnected Arabic — see
 * `src/lib/typography/arabic.ts`. The consequence is that the statement has
 * no selectable text layer, which for a one-page summary an engineer reads or
 * prints is a trade worth making.
 * ===========================================================================
 */

/** A4 at 150 DPI — crisp when printed, small enough to email. */
const PAGE = { width: 1240, height: 1754, dpi: 150 } as const;
const MARGIN = 90;

const INK = '#14181d';
const INK_SOFT = '#5b6673';
const INK_FAINT = '#8a94a1';
const LINE = '#d8dde3';
const ACCENT = '#0f5d52';
const DANGER = '#9a2c2c';

export interface StatementDocument {
  readonly settlement: SettlementSummary;
  readonly lines: readonly StatementLine[];
  readonly contributorName: string | null;
  readonly platformName: string;
}

/** Money for print. Never fed back into a calculation (CLAUDE.md rule 2). */
function money(amountMinor: bigint, currency: string): string {
  const digits = minorDigitsOf(currency as CurrencyCode);
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;
  const scale = 10n ** BigInt(digits);
  const whole = (absolute / scale).toString();
  const fraction = (absolute % scale).toString().padStart(digits, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = digits === 0 ? grouped : `${grouped}.${fraction}`;
  return `${negative ? '−' : ''}${body} ${currency}`;
}

function formatDate(value: Date): string {
  // ISO-like and unambiguous. A statement crosses borders and mail clients;
  // a localised long date is prettier and easier to misread.
  return value.toISOString().slice(0, 10);
}

/** Right-aligned Arabic text. */
function rtl(ctx: SKRSContext2D, text: string, x: number, y: number): void {
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.fillText(text, x, y);
}

/** Left-aligned Latin text — references, amounts, dates. */
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

const STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'بانتظار الاعتماد',
  APPROVED: 'معتمد — بانتظار التحويل',
  PAID: 'مصروف',
  CARRIED_FORWARD: 'مُرحَّل إلى الشهر التالي',
  CANCELLED: 'ملغى',
};

const LINE_KIND_LABELS: Readonly<Record<string, string>> = {
  SALE: 'بيع',
  /** Only on statements issued before refunds were removed from the platform. */
  REFUND: 'استرجاع',
  ADJUSTMENT: 'تسوية',
};

/**
 * Draw the statement and wrap it in a PDF.
 *
 * Returns a single-page document. A month with more sales than fit on one
 * page is truncated in the DETAIL only, with the count of what was omitted
 * printed — the totals above it always describe the whole month, so the
 * document never shows a total its own lines contradict.
 */
export async function renderStatementPdf(doc: StatementDocument): Promise<Uint8Array> {
  assertArabicFonts();

  const canvas = createCanvas(PAGE.width, PAGE.height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE.width, PAGE.height);

  const right = PAGE.width - MARGIN;
  const left = MARGIN;
  let y = MARGIN + 20;

  const { settlement: s } = doc;
  const currency = s.currency;

  // --- header ---------------------------------------------------------------
  ctx.fillStyle = INK;
  ctx.font = `36px ${ARABIC_FONT_BOLD}`;
  rtl(ctx, 'كشف التسوية الشهري', right, y);

  ctx.fillStyle = INK_SOFT;
  ctx.font = `22px ${ARABIC_FONT}`;
  latin(ctx, doc.platformName, left, y);

  y += 46;
  ctx.fillStyle = INK_FAINT;
  ctx.font = `20px ${ARABIC_FONT}`;
  rtl(ctx, `المهندس: ${doc.contributorName ?? '—'}`, right, y);
  ctx.fillStyle = INK_SOFT;
  ctx.font = `22px ${ARABIC_FONT_BOLD}`;
  latin(ctx, s.reference, left, y);

  y += 34;
  ctx.fillStyle = INK_FAINT;
  ctx.font = `20px ${ARABIC_FONT}`;
  rtl(ctx, `الفترة ${ltr(s.periodKey)} — ${STATUS_LABELS[s.status] ?? s.status}`, right, y);
  ctx.font = `18px ${ARABIC_FONT}`;
  latin(ctx, `${formatDate(s.generatedAt)}`, left, y);

  y += 28;
  rule(ctx, y);
  y += 54;

  // --- the headline figure --------------------------------------------------
  const headlineIsDebt = s.status !== 'PAID' && s.balanceMinor < 0n;
  const headlineAmount = s.status === 'PAID' || s.netDueMinor > 0n
    ? s.netDueMinor
    : s.balanceMinor;

  ctx.fillStyle = INK_SOFT;
  ctx.font = `22px ${ARABIC_FONT}`;
  rtl(
    ctx,
    s.status === 'PAID'
      ? 'المبلغ المصروف'
      : s.netDueMinor > 0n
        ? 'المستحق للصرف'
        : 'الرصيد المُرحَّل',
    right,
    y,
  );

  y += 56;
  ctx.fillStyle = headlineIsDebt ? DANGER : ACCENT;
  ctx.font = `46px ${ARABIC_FONT_BOLD}`;
  latin(ctx, money(headlineAmount, currency), left, y);

  y += 22;
  rule(ctx, y);
  y += 50;

  // --- the month's figures (decisions §9) -----------------------------------
  ctx.fillStyle = INK;
  ctx.font = `24px ${ARABIC_FONT_BOLD}`;
  rtl(ctx, 'تفصيل الشهر', right, y);
  y += 40;

  const rows: Array<[string, string, boolean?]> = [
    ['مبيعات الشهر (حصتي)', money(s.periodSalesMinor, currency)],
    /*
     * The refund row appears only if there IS one. The platform issues no
     * refunds, so on every statement from now on this is zero — and a line
     * reading "refunds: 0.00" on every statement implies a process that does
     * not exist. Statements issued before that decision still print it.
     */
    ...(s.periodRefundsMinor !== 0n
      ? ([['استرجاعات الشهر', money(-s.periodRefundsMinor, currency)]] as Array<[string, string]>)
      : []),
    ['رصيد مُرحَّل من قبل', money(s.carriedForwardMinor, currency)],
    ['الرصيد عند إقفال الشهر', money(s.balanceMinor, currency), true],
  ];

  ctx.font = `21px ${ARABIC_FONT}`;
  for (const [label, value, emphasise] of rows) {
    ctx.fillStyle = emphasise ? INK : INK_SOFT;
    ctx.font = `21px ${emphasise ? ARABIC_FONT_BOLD : ARABIC_FONT}`;
    rtl(ctx, label, right, y);
    ctx.fillStyle = emphasise ? INK : INK_SOFT;
    latin(ctx, value, left, y);
    y += 38;
  }

  y += 6;
  ctx.fillStyle = INK_FAINT;
  ctx.font = `18px ${ARABIC_FONT}`;
  /*
   * WHOSE VALUE THIS IS (migration 0052).
   *
   * `periodGrossSalesMinor` is the sum of the PRODUCTS' prices. On a product
   * with two authors most of that number is the colleague's, so printing it
   * beside this engineer's earnings both overstates their sales and makes
   * their own commission rate look wrong. `periodSliceSalesMinor` is their
   * own share of the same sales, and is preferred whenever the sales it
   * covers were frozen with one.
   *
   * The fallback is not a cosmetic default: on a statement issued before
   * 0052 the slice is genuinely unknown, and the old wording is what that
   * document said. Reprinting an old statement must reprint the old statement.
   */
  rtl(
    ctx,
    s.periodSliceSalesMinor === null
      ? `عدد المبيعات ${ltr(String(s.periodUnitsSold))} · إجمالي قيمتها `
        + `${ltr(money(s.periodGrossSalesMinor, currency))}`
      : `عدد المبيعات ${ltr(String(s.periodUnitsSold))} · قيمة حصتي منها `
        + `${ltr(money(s.periodSliceSalesMinor, currency))}`,
    right,
    y,
  );

  y += 40;
  rule(ctx, y);
  y += 48;

  // --- the detail -----------------------------------------------------------
  ctx.fillStyle = INK;
  ctx.font = `24px ${ARABIC_FONT_BOLD}`;
  rtl(ctx, 'الحركات', right, y);
  y += 38;

  ctx.fillStyle = INK_FAINT;
  ctx.font = `17px ${ARABIC_FONT}`;
  rtl(ctx, 'المنتج', right, y);
  latin(ctx, 'حصتي', left, y);
  latin(ctx, 'التاريخ', left + 210, y);
  y += 12;
  rule(ctx, y);
  y += 32;

  const bottomLimit = PAGE.height - MARGIN - 120;
  let shown = 0;

  for (const line of doc.lines) {
    if (y > bottomLimit) break;

    ctx.fillStyle = line.kind === 'REFUND' ? DANGER : INK;
    ctx.font = `19px ${ARABIC_FONT}`;

    const title = line.productTitle.length > 44
      ? `${line.productTitle.slice(0, 43)}…`
      : line.productTitle;
    rtl(ctx, `${LINE_KIND_LABELS[line.kind] ?? line.kind} — ${title}`, right, y);

    ctx.font = `19px ${ARABIC_FONT}`;
    latin(ctx, money(line.engineerMinor, line.currency), left, y);
    ctx.fillStyle = INK_FAINT;
    ctx.font = `17px ${ARABIC_FONT}`;
    latin(ctx, formatDate(line.occurredAt), left + 210, y);

    y += 32;
    shown += 1;
  }

  if (shown === 0) {
    ctx.fillStyle = INK_FAINT;
    ctx.font = `19px ${ARABIC_FONT}`;
    rtl(ctx, 'لا حركات في هذا الشهر.', right, y);
    y += 32;
  }

  const omitted = doc.lines.length - shown;
  if (omitted > 0) {
    ctx.fillStyle = INK_FAINT;
    ctx.font = `18px ${ARABIC_FONT}`;
    rtl(
      ctx,
      `و${ltr(String(omitted))} حركة أخرى غير معروضة هنا — المجاميع أعلاه تشمل الشهر كاملاً.`,
      right,
      y,
    );
  }

  // --- footer ---------------------------------------------------------------
  const footerY = PAGE.height - MARGIN - 40;
  rule(ctx, footerY - 34);

  ctx.fillStyle = INK_FAINT;
  ctx.font = `16px ${ARABIC_FONT}`;
  rtl(
    ctx,
    s.status === 'PAID'
      ? `حُوِّل بتاريخ ${ltr(s.paidAt ? formatDate(s.paidAt) : '—')}`
        + (s.payoutReference ? ` — مرجع ${ltr(s.payoutReference)}` : '')
      : s.balanceMinor < 0n
        ? 'رصيد سالب بسبب استرجاع اعتُمد بعد تسوية شهره، ويُخصم من الشهر التالي.'
        : s.netDueMinor > 0n
          ? 'قيد المراجعة والصرف.'
          : 'يُرحَّل هذا الرصيد إلى كشف الشهر التالي.',
    right,
    footerY,
  );

  ctx.font = `15px ${ARABIC_FONT}`;
  latin(ctx, `${s.reference} · ${formatDate(new Date())}`, left, footerY);

  // --- wrap the page in a PDF ----------------------------------------------
  const pdf = await PDFDocument.create();
  // No author, producer or creation metadata: the document is handed to a
  // third party and carries only what the statement itself says.
  pdf.setTitle(`Settlement ${s.reference}`);
  pdf.setProducer('');
  pdf.setCreator('');

  const png = await pdf.embedPng(canvas.toBuffer('image/png'));
  // 72 points per inch: the page comes out exactly A4, not A4-at-150-DPI.
  const scale = 72 / PAGE.dpi;
  const page = pdf.addPage([PAGE.width * scale, PAGE.height * scale]);
  page.drawImage(png, {
    x: 0, y: 0, width: PAGE.width * scale, height: PAGE.height * scale,
  });

  return pdf.save();
}
