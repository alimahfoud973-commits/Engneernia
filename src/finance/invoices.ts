import 'server-only';
import { sql } from 'drizzle-orm';
import { invoices } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';
import { RuleViolationError } from '@/lib/errors';
import type { InvoiceIdentity, TaxPolicy } from './tax-policy';

/**
 * ===========================================================================
 * ISSUING AN INVOICE (owner decision on OPEN-9)
 * ===========================================================================
 * One invoice per order, issued INSIDE the transaction that marks the order
 * paid. Not afterwards, and not from a queue.
 *
 * That placement is the whole design. It gives three things at once:
 *
 *   - A sale cannot exist without its document. If the invoice fails to
 *     issue, the sale rolls back with it.
 *   - The number series has no holes. `app_next_invoice_number` takes the
 *     counter row FOR UPDATE, so a rolled-back sale returns its number
 *     instead of burning it — unlike the order sequence, where a gap is
 *     harmless and a sequence is therefore fine.
 *   - What the invoice says and what the books say cannot drift, because
 *     neither can be written without the other.
 *
 * EVERYTHING IS COPIED, NOTHING IS REFERENCED. The rate, the tax's legal
 * name, the seller's details, the product titles: all frozen onto the row. A
 * settings edit next month, or a product renamed next year, must not change a
 * document that has already been given to a customer.
 * ===========================================================================
 */

export interface InvoiceLineInput {
  readonly title: string;
  /** The catalogue price, before any discount. */
  readonly listMinor: bigint;
  readonly discountMinor: bigint;
  /** `listMinor - discountMinor`: what this line was charged at. */
  readonly grossMinor: bigint;
  readonly taxMinor: bigint;
  readonly netMinor: bigint;
}

export interface IssueInvoiceInput {
  readonly orderId: string;
  readonly customerId: string;
  readonly buyerName: string;
  readonly buyerEmail: string;
  readonly currency: string;
  /** Sum of the lines' list prices, before any discount (OPEN-1). */
  readonly listMinor: bigint;
  readonly discountMinor: bigint;
  /** What the customer paid: `listMinor - discountMinor`. */
  readonly grossMinor: bigint;
  readonly taxMinor: bigint;
  readonly netMinor: bigint;
  readonly tax: TaxPolicy;
  readonly identity: InvoiceIdentity;
  readonly lines: readonly InvoiceLineInput[];
}

export interface IssuedInvoice {
  readonly id: string;
  readonly invoiceNumber: string;
}

export async function issueInvoice(
  tx: Transaction,
  input: IssueInvoiceInput,
): Promise<IssuedInvoice> {
  if (input.taxMinor + input.netMinor !== input.grossMinor) {
    // The database CHECK would refuse this too. Refusing here as well names
    // the problem while the numbers are still in hand.
    throw new RuleViolationError('مبالغ الفاتورة لا تساوي المبلغ المدفوع', {
      orderId: input.orderId,
      grossMinor: input.grossMinor.toString(),
      taxMinor: input.taxMinor.toString(),
      netMinor: input.netMinor.toString(),
    });
  }

  /**
   * The discount has to reconcile too (OPEN-1).
   *
   * An invoice whose stated discount does not bridge its own list price and
   * its own total is a document that contradicts itself — and it is the
   * document a customer keeps and a tax authority reads. A zero discount makes
   * this the identity `list = paid`, which is every invoice issued so far.
   */
  if (input.discountMinor < 0n) {
    throw new RuleViolationError('خصم الفاتورة لا يمكن أن يكون سالباً', {
      orderId: input.orderId,
      discountMinor: input.discountMinor.toString(),
    });
  }
  if (input.listMinor - input.discountMinor !== input.grossMinor) {
    throw new RuleViolationError('خصم الفاتورة لا يطابق الفرق بين السعر والمدفوع', {
      orderId: input.orderId,
      listMinor: input.listMinor.toString(),
      discountMinor: input.discountMinor.toString(),
      grossMinor: input.grossMinor.toString(),
    });
  }

  const numbered = await tx.execute(sql`
    SELECT app_next_invoice_number(${input.identity.prefix}) AS invoice_number
  `);
  const invoiceNumber = (numbered as unknown as Array<{ invoice_number: string }>)[0]
    ?.invoice_number;
  if (!invoiceNumber) {
    throw new RuleViolationError('تعذّر توليد رقم الفاتورة', { orderId: input.orderId });
  }

  const [row] = await tx
    .insert(invoices)
    .values({
      invoiceNumber,
      orderId: input.orderId,
      customerId: input.customerId,
      currency: input.currency,
      listMinor: input.listMinor,
      discountMinor: input.discountMinor,
      grossMinor: input.grossMinor,
      taxMinor: input.taxMinor,
      netMinor: input.netMinor,
      taxBp: input.tax.rateBp,
      taxNameAr: input.tax.nameAr,
      taxRegistration: input.tax.registration || null,
      sellerNameAr: input.identity.sellerNameAr,
      sellerAddressAr: input.identity.sellerAddressAr || null,
      buyerName: input.buyerName,
      buyerEmail: input.buyerEmail,
      lines: input.lines.map((line) => ({
        title: line.title,
        // Serialised as strings: these are bigint minor units, and JSON
        // numbers are IEEE doubles. A price that survives the database
        // faithfully must not lose precision on the way into a jsonb column.
        listMinor: line.listMinor.toString(),
        discountMinor: line.discountMinor.toString(),
        grossMinor: line.grossMinor.toString(),
        taxMinor: line.taxMinor.toString(),
        netMinor: line.netMinor.toString(),
      })),
    })
    .returning({ id: invoices.id, invoiceNumber: invoices.invoiceNumber });

  if (!row) {
    // RLS refuses a write by returning no rows rather than raising, so an
    // unchecked insert would look like success. (CLAUDE.md, database rules.)
    throw new RuleViolationError('رُفض إصدار الفاتورة', { orderId: input.orderId });
  }

  return { id: row.id, invoiceNumber: row.invoiceNumber };
}
