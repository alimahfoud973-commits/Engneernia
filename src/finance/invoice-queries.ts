import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { invoices, orders } from '@/db/schema';
import { withActor } from '@/db/actor-context';
import type { Actor } from '@/authz/actor';
import { toDate } from '@/db';
import type { InvoiceDocument, InvoiceLine } from './invoice-pdf';

/**
 * Reading invoices.
 *
 * AUTHORISATION IS THE DATABASE'S. Nothing here compares a customer id to
 * anything: the query runs under the caller's own actor and the row-level
 * policy on `invoices` decides whether a row resolves. A customer asking for
 * somebody else's invoice gets exactly what they get for one that does not
 * exist — nothing — which is the §36 rule about 404 over 403, enforced one
 * layer lower than the route.
 */

interface StoredLine {
  readonly title?: unknown;
  readonly listMinor?: unknown;
  readonly discountMinor?: unknown;
  readonly grossMinor?: unknown;
  readonly taxMinor?: unknown;
  readonly netMinor?: unknown;
}

/**
 * The lines are jsonb, and jsonb is whatever was written — so it is read
 * defensively rather than cast. A document that renders is better than a 500
 * for a customer whose invoice was written by an older version of this code.
 */
function toLines(value: unknown): InvoiceLine[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const line = raw as StoredLine;
    const big = (input: unknown) => {
      try {
        return BigInt(String(input ?? '0'));
      } catch {
        return 0n;
      }
    };
    const grossMinor = big(line.grossMinor);
    return {
      title: typeof line.title === 'string' ? line.title : '—',
      // An invoice written before OPEN-1 carries neither field, and for it
      // `list = gross` is not a fallback but the truth: no discount could
      // exist when it was issued.
      listMinor: line.listMinor === undefined ? grossMinor : big(line.listMinor),
      discountMinor: big(line.discountMinor),
      grossMinor,
      taxMinor: big(line.taxMinor),
      netMinor: big(line.netMinor),
    };
  });
}

export interface InvoiceSummary {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly issuedAt: Date;
  readonly currency: string;
  readonly grossMinor: bigint;
  readonly taxMinor: bigint;
}

/** The caller's own invoices; the owner's query returns everyone's. */
export async function myInvoices(actor: Actor): Promise<readonly InvoiceSummary[]> {
  if (actor.kind !== 'USER') return [];

  return withActor(actor, async (tx) => {
    const rows = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        issuedAt: invoices.issuedAt,
        currency: invoices.currency,
        grossMinor: invoices.grossMinor,
        taxMinor: invoices.taxMinor,
      })
      .from(invoices)
      .orderBy(desc(invoices.issuedAt))
      .limit(200);

    return rows.map((row) => ({ ...row, issuedAt: toDate(row.issuedAt) ?? new Date() }));
  });
}

export async function invoiceDocument(
  actor: Actor,
  invoiceId: string,
): Promise<InvoiceDocument | null> {
  if (actor.kind !== 'USER') return null;

  return withActor(actor, async (tx) => {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);

    if (!row) return null;

    // The order number is the customer-facing reference they already know. It
    // is the one field not frozen onto the invoice, because an order number
    // never changes — and if the order is gone, the invoice still renders.
    const [order] = await tx
      .select({ orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.id, row.orderId))
      .limit(1);

    return {
      invoiceNumber: row.invoiceNumber,
      issuedAt: toDate(row.issuedAt) ?? new Date(),
      currency: row.currency,
      listMinor: row.listMinor,
      discountMinor: row.discountMinor,
      grossMinor: row.grossMinor,
      taxMinor: row.taxMinor,
      netMinor: row.netMinor,
      taxBp: row.taxBp,
      taxNameAr: row.taxNameAr,
      taxRegistration: row.taxRegistration,
      sellerNameAr: row.sellerNameAr,
      sellerAddressAr: row.sellerAddressAr,
      buyerName: row.buyerName,
      buyerEmail: row.buyerEmail,
      orderNumber: order?.orderNumber ?? '—',
      lines: toLines(row.lines),
    };
  });
}
