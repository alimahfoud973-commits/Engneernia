import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements, invoices, orderItems, orders,
  paymentMethods, payments, productContributors, productPrices, products, settings, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { GUEST, type Actor } from '@/authz/actor';
import { invoiceDocument, myInvoices } from './invoice-queries';
import { renderInvoicePdf } from './invoice-pdf';

/**
 * ===========================================================================
 * TAX AND LEGAL INVOICING, ON A REAL DATABASE (owner decision on OPEN-9)
 * ===========================================================================
 * Three decisions are under test, and each one is a number that has to come
 * out exactly right or somebody is owed money they did not get:
 *
 *   1. The displayed price INCLUDES the tax — so the customer pays what the
 *      page said, and the tax is found inside that figure.
 *   2. The engineer's share is computed on the NET — the state's portion comes
 *      out before anything is divided.
 *   3. It ships at rate ZERO, where every number must be exactly what it was
 *      before tax existed.
 * ===========================================================================
 */

const suffix = Date.now();
const PRICE = 11_500n; // $115.00 — contains exactly $15.00 at 15%.

const ids = {
  owner: '', customer: randomUUID(), engineerUser: randomUUID(),
  contributor: randomUUID(), discipline: randomUUID(),
  productZero: randomUUID(), productTaxed: randomUUID(), method: randomUUID(),
};
const slugZero = `tax-zero-${suffix}`;
const slugTaxed = `tax-real-${suffix}`;

let OWNER_RAW: { actorId: string; actorRole: string };
const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true, totpEnabled: false } as const;
let owner: Actor;
const customer: Actor = {
  ...base, userId: ids.customer, role: 'CUSTOMER', contributorId: null, contributorActive: false,
};

async function setTaxRate(bp: number): Promise<void> {
  await withRawActorContext(OWNER_RAW, (tx) =>
    tx.execute(sql`UPDATE settings SET value = ${String(bp)}::jsonb WHERE key = 'tax.rateBp'`),
  );
}

async function buy(slug: string): Promise<string> {
  const order = await createOrder(customer, { productSlugs: [slug], buyerCountry: 'SY' });
  await placeOrder(customer, { orderId: order.orderId, paymentMethodId: ids.method });
  const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(payments).where(eq(payments.orderId, order.orderId)),
  );
  await approvePayment(owner, { paymentId: payment!.id });
  return order.orderId;
}

const itemOf = async (orderId: string) => {
  const [item] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
  );
  return item!;
};

const invoiceOf = async (orderId: string) => {
  const [invoice] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(invoices).where(eq(invoices.orderId, orderId)),
  );
  return invoice!;
};

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.customer, email: `tax-cust+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'زبون الضريبة', countryCode: 'SY' },
      { id: ids.engineerUser, email: `tax-eng+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `tax-eng-${suffix}`,
      settlementCode: `TAX${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `tax-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 94,
    });

    for (const [id, slug] of [[ids.productZero, slugZero], [ids.productTaxed, slugTaxed]] as const) {
      await tx.insert(products).values({
        id, slug, titleAr: 'مورد هندسي', disciplineId: ids.discipline,
        fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date(),
      });
      await tx.insert(productContributors).values({
        productId: id, contributorId: ids.contributor, shareBp: 10000,
      });
      await tx.insert(productPrices).values({ productId: id, amountMinor: PRICE, currency: 'USD' });
    }

    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE',
      engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `tax-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل', instructionsAr: 'حوّل', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });
});

afterAll(async () => {
  await setTaxRate(0);
  await withRawActorContext(OWNER_RAW, async (tx) => {
    // Invoices are append-only and are NOT deleted — the same treatment the
    // ledger gets, and the reason they carry no foreign key to the order.
    await tx.delete(entitlements).where(eq(entitlements.customerId, ids.customer));
    await tx.delete(orders).where(eq(orders.customerId, ids.customer));
    await tx.delete(productPrices).where(sql`product_id IN (${ids.productZero}, ${ids.productTaxed})`);
    await tx.delete(productContributors).where(sql`product_id IN (${ids.productZero}, ${ids.productTaxed})`);
    await tx.delete(products).where(sql`id IN (${ids.productZero}, ${ids.productTaxed})`);
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(sql`id IN (${ids.customer}, ${ids.engineerUser})`);
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(settings).where(eq(settings.key, 'tax.rateBp__absent'));
  });
  await closeDb();
});

describe('the state the platform ships in: rate zero', () => {
  let orderId = '';

  it('sells at the displayed price and takes nothing', async () => {
    await setTaxRate(0);
    orderId = await buy(slugZero);

    const item = await itemOf(orderId);
    expect(item.unitPriceMinor).toBe(PRICE);
    expect(item.taxMinor).toBe(0n);
    expect(item.netMinor).toBe(PRICE);
    expect(item.taxBp).toBe(0);
  });

  it('splits 80/20 on the whole price, exactly as before tax existed', async () => {
    const item = await itemOf(orderId);
    expect(item.engineerAmountMinor).toBe(9_200n);   // 80% of 11500
    expect(item.platformAmountMinor).toBe(2_300n);
  });

  it('books no tax line at all', async () => {
    const lines = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT account_code FROM ledger_lines
         WHERE transaction_id = (
           SELECT id FROM ledger_transactions WHERE reference_id = ${orderId}::uuid LIMIT 1)
      `),
    );
    const accounts = (lines as unknown as Array<{ account_code: string }>).map((l) => l.account_code);
    expect(accounts).not.toContain('TAX_PAYABLE');
  });

  it('still issues an invoice, so every sale is documented from day one', async () => {
    const invoice = await invoiceOf(orderId);
    expect(invoice.invoiceNumber).toMatch(/^INV-\d{4}-\d{5}$/);
    expect(invoice.taxMinor).toBe(0n);
    expect(invoice.grossMinor).toBe(PRICE);
  });
});

describe('once the owner sets a rate', () => {
  let orderId = '';

  it('finds the tax INSIDE the displayed price, leaving it unchanged', async () => {
    await setTaxRate(1500);
    orderId = await buy(slugTaxed);

    const item = await itemOf(orderId);
    // The customer paid exactly what the page said. This is the decision.
    expect(item.unitPriceMinor).toBe(PRICE);
    expect(item.taxMinor).toBe(1_500n);
    expect(item.netMinor).toBe(10_000n);
    expect(item.taxBp).toBe(1500);
  });

  it('computes the engineer share on the net, not on the gross', async () => {
    const item = await itemOf(orderId);
    // 80% of 10000, NOT 80% of 11500. The difference — 1200 minor units —
    // is the state's money, and handing it to the engineer would be the
    // platform giving away what it is only holding.
    expect(item.engineerAmountMinor).toBe(8_000n);
    expect(item.platformAmountMinor).toBe(2_000n);
  });

  it('books the tax to its own liability account, and the entry balances', async () => {
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT account_code, amount_minor::text AS amount FROM ledger_lines
         WHERE transaction_id = (
           SELECT id FROM ledger_transactions WHERE reference_id = ${orderId}::uuid LIMIT 1)
         ORDER BY account_code
      `),
    );
    const lines = rows as unknown as Array<{ account_code: string; amount: string }>;
    const by = new Map(lines.map((l) => [l.account_code, BigInt(l.amount)]));

    expect(by.get('PLATFORM_CASH')).toBe(11_500n);
    expect(by.get('TAX_PAYABLE')).toBe(-1_500n);
    expect(by.get('ENGINEER_PAYABLE')).toBe(-8_000n);
    expect(by.get('PLATFORM_REVENUE')).toBe(-2_000n);
    expect(lines.reduce((t, l) => t + BigInt(l.amount), 0n)).toBe(0n);
  });

  it('does not count the tax as platform revenue', async () => {
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT COALESCE(SUM(-amount_minor), 0)::text AS revenue FROM ledger_lines
         WHERE account_code = 'PLATFORM_REVENUE'
           AND transaction_id = (
             SELECT id FROM ledger_transactions WHERE reference_id = ${orderId}::uuid LIMIT 1)
      `),
    );
    // Revenue is the commission alone. Tax collected is not earnings.
    expect(BigInt((rows as unknown as Array<{ revenue: string }>)[0]!.revenue)).toBe(2_000n);
  });

  it('freezes the rate onto the invoice, so changing it later rewrites nothing', async () => {
    const before = await invoiceOf(orderId);
    expect(before.taxBp).toBe(1500);
    expect(before.taxMinor).toBe(1_500n);

    await setTaxRate(2000);

    const after = await invoiceOf(orderId);
    expect(after.taxBp).toBe(1500);
    expect(after.taxMinor).toBe(1_500n);
    expect(after.taxNameAr).toBe(before.taxNameAr);
  });
});

describe('the document the customer receives', () => {
  it('renders as a real PDF carrying the split', async () => {
    const [invoice] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(invoices).where(sql`tax_bp > 0`).limit(1),
    );
    expect(invoice, 'a taxed invoice should exist by now').toBeDefined();

    const document = await invoiceDocument(owner, invoice!.id);
    expect(document).not.toBeNull();
    expect(document!.taxMinor).toBe(1_500n);
    expect(document!.netMinor).toBe(10_000n);
    expect(document!.grossMinor).toBe(11_500n);
    expect(document!.lines.length).toBeGreaterThan(0);

    const pdf = await renderInvoicePdf(document!);
    // A PDF, not a stack trace rendered to bytes.
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it('is refused to a customer who is not the buyer', async () => {
    const [invoice] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(invoices).limit(1),
    );
    const stranger: Actor = {
      ...base, userId: randomUUID(), role: 'CUSTOMER',
      contributorId: null, contributorActive: false,
    };
    // Not 403 and not an error: nothing at all, decided by the row policy
    // rather than by a comparison in the route (§36).
    expect(await invoiceDocument(stranger, invoice!.id)).toBeNull();
  });

  /**
   * `myInvoices` issues no WHERE clause at all — the scoping is entirely the
   * row policy's. That is the architecture working as designed, and it is also
   * the query where a policy mistake would be worst: it returns MANY rows, and
   * every one carries a buyer's name and email address. `invoiceDocument`
   * leaks one invoice to someone who guessed an id; this would hand over the
   * customer list.
   */
  it('lists the buyer their own invoices', async () => {
    const mine = await myInvoices(customer);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((row) => row.invoiceNumber.length > 0)).toBe(true);
  });

  it('lists a stranger nothing, with no filter in the query to help it', async () => {
    const stranger: Actor = {
      ...base, userId: randomUUID(), role: 'CUSTOMER',
      contributorId: null, contributorActive: false,
    };
    expect(await myInvoices(stranger)).toEqual([]);
  });

  it('lists a contributor nothing — selling is not buying', async () => {
    // The engineer whose product was sold has no claim on the buyer's invoice:
    // it carries the customer's name and address, and §12 keeps those apart.
    const engineer: Actor = {
      ...base, userId: ids.engineerUser, role: 'CONTRIBUTOR',
      contributorId: ids.contributor, contributorActive: true,
    };
    expect(await myInvoices(engineer)).toEqual([]);
  });

  it('lists a guest nothing, before any query runs', async () => {
    expect(await myInvoices(GUEST)).toEqual([]);
  });
});

describe('what the database refuses', () => {
  it('refuses to edit a frozen tax figure on a sold item', async () => {
    const [item] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orderItems).where(sql`snapshot_taken_at IS NOT NULL`).limit(1),
    );
    await expect(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.execute(sql`UPDATE order_items SET tax_minor = 1 WHERE id = ${item!.id}::uuid`),
      ),
    ).rejects.toThrow();
  });

  /**
   * TWO REFUSALS, AND THEY LOOK DIFFERENT.
   *
   * There is no UPDATE or DELETE policy on `invoices`, and RLS refuses a write
   * it has no policy for by MATCHING NO ROWS — not by raising. So these do not
   * throw; they change nothing, and the assertion has to be that the row is
   * still there and still says what it said. (CLAUDE.md: "RLS يرفض الكتابة
   * بإرجاع صفر صفوف، لا برمي خطأ".) Written the other way first, and the test
   * itself showed the difference.
   *
   * The append-only TRIGGER is the second layer, and it is the one that raises
   * — for a writer RLS lets through, such as the migration role.
   */
  it('refuses to edit an invoice: RLS matches no row, and the trigger stops anyone else', async () => {
    const [invoice] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(invoices).limit(1),
    );

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`UPDATE invoices SET buyer_name = 'tampered' WHERE id = ${invoice!.id}::uuid`),
    );

    const [after] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, invoice!.id)),
    );
    expect(after!.buyerName).toBe(invoice!.buyerName);
    expect(after!.buyerName).not.toBe('tampered');
  });

  it('refuses to delete an invoice, and the row survives', async () => {
    const before = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(invoices),
    );
    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`DELETE FROM invoices WHERE id = ${before[0]!.id}::uuid`),
    );
    const after = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(invoices),
    );
    expect(after.length).toBe(before.length);
  });

  it('issues each invoice number once, with no holes', async () => {
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT invoice_number FROM invoices ORDER BY invoice_number
      `),
    );
    const numbers = (rows as unknown as Array<{ invoice_number: string }>)
      .map((r) => Number(r.invoice_number.split('-')[2]));
    expect(new Set(numbers).size).toBe(numbers.length);
    // Gapless: the counter is a row taken FOR UPDATE, not a sequence.
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i]! - numbers[i - 1]!).toBe(1);
    }
  });
});
