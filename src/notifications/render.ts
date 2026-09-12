import { minorDigitsOf, type CurrencyCode } from '@/lib/money/currency';

/**
 * ===========================================================================
 * TURNING A NOTIFICATION ROW INTO A SENTENCE
 * ===========================================================================
 * The database stores a TYPE and a PAYLOAD, never a rendered message. That is
 * what lets the same row read correctly in Arabic today and in another
 * language later without a migration — and what stops a message written at
 * send time from going stale when a product is renamed.
 *
 * Pure, so the whole catalogue is unit-testable without a database, and so an
 * unknown type degrades to something readable rather than throwing on a page
 * the user just wanted to glance at.
 * ===========================================================================
 */

export interface RenderedNotification {
  readonly title: string;
  readonly detail: string | null;
  /** Where the message leads, when there is somewhere useful to go. */
  readonly href: string | null;
  readonly tone: 'neutral' | 'good' | 'warn';
}

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Amounts travel as strings — see the ledger posting rules. */
function money(payload: Record<string, unknown>, key: string): string | null {
  const raw = payload[key];
  const currency = text(payload, 'currency') ?? 'USD';
  if (typeof raw !== 'string') return null;

  let amount: bigint;
  try {
    amount = BigInt(raw);
  } catch {
    return null;
  }

  let digits: number;
  try {
    digits = minorDigitsOf(currency as CurrencyCode);
  } catch {
    return null;
  }

  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const scale = 10n ** BigInt(digits);
  const whole = (absolute / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (absolute % scale).toString().padStart(digits, '0');
  const body = digits === 0 ? whole : `${whole}.${fraction}`;
  return `${negative ? '−' : ''}${body} ${currency}`;
}

export function renderNotification(
  type: string,
  payload: Record<string, unknown>,
): RenderedNotification {
  const product = text(payload, 'productTitle');
  const reference = text(payload, 'reference');
  const orderNumber = text(payload, 'orderNumber');
  const periodKey = text(payload, 'periodKey');

  switch (type) {
    // --- the engineer's sale message (owner decision) ---------------------
    case 'PRODUCT_SOLD': {
      const share = money(payload, 'engineerMinor');
      return {
        title: product ? `بيعت نسخة من «${product}»` : 'بيعت نسخة من أحد منتجاتك',
        detail: share ? `حصتك من هذه العملية ${share}. تُصرف ضمن تسوية الشهر.` : null,
        href: '/account/earnings',
        tone: 'good',
      };
    }

    /** Historical: no sale is reversed any more. */
    case 'BALANCE_ADJUSTED': {
      const amount = money(payload, 'amountMinor');
      const increase = payload.direction === 'INCREASE';
      return {
        title: increase ? 'أُضيف مبلغ إلى رصيدك' : 'خُصم مبلغ من رصيدك',
        detail: [amount, text(payload, 'note')].filter(Boolean).join(' — ') || null,
        href: '/account/earnings',
        tone: increase ? 'good' : 'warn',
      };
    }

    case 'SALE_REVERSED':
      return {
        title: product ? `استُرجعت عملية بيع «${product}»` : 'استُرجعت إحدى عمليات البيع',
        detail: reference
          ? `مرجع الاسترجاع ${reference}. تُخصم الحصة من رصيدك.`
          : 'تُخصم الحصة من رصيدك.',
        href: '/account/earnings',
        tone: 'warn',
      };

    // --- the monthly statement --------------------------------------------
    case 'MONTHLY_STATEMENT_AVAILABLE':
      return {
        title: 'صدر كشف التسوية الشهري',
        detail: [reference, periodKey ? `فترة ${periodKey}` : null]
          .filter(Boolean).join(' — ') || null,
        href: '/account/earnings',
        tone: 'neutral',
      };

    case 'SETTLEMENT_APPROVED':
      return {
        title: 'اعتُمد كشف تسويتك',
        detail: reference ? `${reference} — بانتظار التحويل.` : 'بانتظار التحويل.',
        href: '/account/earnings',
        tone: 'neutral',
      };

    case 'SETTLEMENT_PAID':
      return {
        title: 'حُوِّلت مستحقاتك',
        detail: reference ?? null,
        href: '/account/earnings',
        tone: 'good',
      };

    // --- the buyer's messages ----------------------------------------------
    case 'ORDER_PAID':
      return {
        title: 'اكتمل طلبك وفُتح الوصول إلى الملف',
        detail: orderNumber ? `الطلب ${orderNumber}` : null,
        href: '/account',
        tone: 'good',
      };

    case 'PAYMENT_REJECTED':
      return {
        title: 'لم يُعتمد إثبات الدفع',
        detail: text(payload, 'reason'),
        href: '/account',
        tone: 'warn',
      };

    /*
     * The four refund messages below are HISTORICAL. The platform issues no
     * refunds, so nothing produces them any more — but rows written before
     * that decision still exist and must still render as sentences rather
     * than as raw enum values.
     */
    case 'REFUND_APPROVED':
      return {
        title: 'وُوفق على طلب الاسترجاع',
        detail: reference ? `${reference} — سيُحوَّل المبلغ إليك.` : null,
        href: '/account',
        tone: 'good',
      };

    case 'REFUND_REJECTED':
      return {
        title: 'لم يُقبل طلب الاسترجاع',
        detail: text(payload, 'reason'),
        href: '/account',
        tone: 'warn',
      };

    case 'REFUND_PAID':
      return {
        title: 'حُوِّل مبلغ الاسترجاع',
        detail: reference ?? null,
        href: '/account',
        tone: 'good',
      };

    case 'REFUND_REQUESTED':
      return {
        title: 'وصل طلب استرجاع',
        detail: reference ?? null,
        href: '/admin/refunds',
        tone: 'neutral',
      };

    // --- the contributor's catalogue messages -------------------------------
    case 'PRODUCT_SUBMITTED':
      return { title: 'أُرسل منتج للمراجعة', detail: product, href: '/account', tone: 'neutral' };
    case 'PRODUCT_APPROVED':
      return { title: 'قُبل منتجك', detail: product, href: '/account', tone: 'good' };
    case 'PRODUCT_REVISION_REQUESTED':
      return { title: 'طُلبت تعديلات على منتجك', detail: product, href: '/account', tone: 'warn' };
    case 'PRODUCT_PUBLISHED':
      return { title: 'نُشر منتجك', detail: product, href: '/account', tone: 'good' };
    case 'PRODUCT_UNPUBLISHED':
      return { title: 'أُوقف نشر منتجك', detail: product, href: '/account', tone: 'warn' };
    case 'PRODUCT_PRICE_CHANGED':
      return { title: 'تغيّر سعر أحد منتجاتك', detail: product, href: '/account', tone: 'neutral' };
    case 'COMMISSION_CHANGED':
      return {
        title: 'تغيّرت شروط العمولة الخاصة بك',
        detail: 'لا يؤثر ذلك على أي عملية بيع سابقة.',
        href: '/account/earnings',
        tone: 'neutral',
      };

    default:
      // An unknown type means a producer shipped ahead of this catalogue.
      // Showing the raw type is better than hiding the message entirely.
      return { title: type, detail: null, href: null, tone: 'neutral' };
  }
}
