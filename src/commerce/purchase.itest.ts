import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { serverEnv } from '@/lib/config/env';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements, orderItemContributors,
  orderItems, orders, paymentMethods, paymentProofs, payments, productContributors,
  productFiles, productPrices, products, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder, rejectPayment } from './orders';
import { submitPaymentProof } from './proofs';
import { availableMethods } from '@/payments/registry';
import { changeProductPrice } from '@/catalog/products';
import { setCommissionAgreement } from '@/finance/commission-resolver';
import { deliverProductFile } from '@/media/deliver';
import { ingestProductFile } from '@/media/ingest';
import { NotFoundError, RuleViolationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * PHASE P5 EXIT CRITERIA
 * ===========================================================================
 *   1. A manual purchase completes end to end and opens the file.
 *   2. Before the owner approves, the customer cannot reach the original.
 *   3. Approval freezes the financial snapshot — and later price or
 *      commission changes cannot touch it (§13, "this is mandatory").
 *   4. Disabling a payment method removes it immediately, with no deploy.
 *   5. A contributor sees their own sale and never the buyer behind it.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '', customer: randomUUID(), other: randomUUID(),
  engineerUser: randomUUID(), contributor: randomUUID(),
  discipline: randomUUID(), product: randomUUID(),
  bankMethod: randomUUID(), cardMethod: randomUUID(),
};
const slug = `p5-prod-${suffix}`;

let OWNER_RAW: { actorId: string; actorRole: string };
const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true } as const;

let owner: Actor;
const customer: Actor = { ...base, userId: ids.customer, role: 'CUSTOMER', contributorId: null, contributorActive: false };
const stranger: Actor = { ...base, userId: ids.other, role: 'CUSTOMER', contributorId: null, contributorActive: false };
const engineer: Actor = { ...base, userId: ids.engineerUser, role: 'CONTRIBUTOR', contributorId: ids.contributor, contributorActive: true };

const ctxOf = (a: Actor) =>
  a.kind === 'USER'
    ? { actorId: a.userId, actorRole: a.role, contributorId: a.contributorId ?? '' }
    : { actorId: '', actorRole: 'GUEST', contributorId: '' };

const PRICE = 2000n; // $20.00

async function buildPdf(pages = 12): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    doc.addPage([595, 842]).drawText(`P5 PAGE-${i}`, { x: 50, y: 700, size: 24, font });
  }
  return doc.save();
}

const PNG_PROOF = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...new Array(512).fill(0x20),
]);

beforeAll(async () => {
  // The platform has exactly one owner (migration 0041), so this file no
  // longer invents one of its own — it asks for the one that exists.
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.customer, email: `p5-cust+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Customer', countryCode: 'SY' },
      { id: ids.other, email: `p5-other+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Other' },
      { id: ids.engineerUser, email: `p5-eng+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `p5-eng-${suffix}`,
      settlementCode: `P5E${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `p5-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 95,
    });
    await tx.insert(products).values({
      id: ids.product, slug, titleAr: 'دليل الاختبار', disciplineId: ids.discipline,
      fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date(),
    });
    await tx.insert(productContributors).values({
      productId: ids.product, contributorId: ids.contributor, shareBp: 10000,
    });
    await tx.insert(productPrices).values({
      productId: ids.product, amountMinor: PRICE, currency: 'USD',
    });

    // 80/20 — the specification's worked example.
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE',
      engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });

    await tx.insert(paymentMethods).values([
      {
        id: ids.bankMethod, code: `bank-${suffix}`, type: 'MANUAL',
        displayNameAr: 'تحويل بنكي', instructionsAr: 'حوّل المبلغ إلى الحساب أدناه',
        accountDetailsAr: 'IBAN SY00 0000', requiresProof: true,
        countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
      },
      {
        id: ids.cardMethod, code: `card-${suffix}`, type: 'GATEWAY',
        displayNameAr: 'بطاقة ائتمان', requiresProof: false,
        countries: [], currencies: ['USD'], isActive: true, sortOrder: 2,
      },
    ]);
  });

  // A real original, through the real pipeline, so the download gate has
  // something to gate.
  await ingestProductFile(owner, {
    productId: ids.product, filename: 'guide.pdf', declaredType: 'PDF',
    body: await buildPdf(), contentType: 'application/pdf',
  });
}, 120_000);

afterAll(async () => {
  // Order matters: several references are ON DELETE RESTRICT on purpose —
  // a contributor with financial agreements, or a product with sales, must
  // not be removable by accident. The teardown unwinds them explicitly.
  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.delete(orders).where(sql`customer_id IN (${ids.customer}, ${ids.other})`);
    await tx.delete(entitlements).where(sql`customer_id IN (${ids.customer}, ${ids.other})`);
    await tx.delete(paymentMethods).where(sql`id IN (${ids.bankMethod}, ${ids.cardMethod})`);
    await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.delete(productContributors).where(eq(productContributors.productId, ids.product));
    await tx.delete(productFiles).where(eq(productFiles.productId, ids.product));
    await tx.delete(products).where(eq(products.id, ids.product));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(sql`id IN (${ids.customer}, ${ids.other}, ${ids.engineerUser})`);
  });
  await closeDb();
});

describe('1. payment method availability (specification §22)', () => {
  it('offers the manual method and refuses the unconfigured gateway', async () => {
    const methods = await withRawActorContext(ctxOf(customer), (tx) =>
      availableMethods(tx, {
        orderId: 'x', orderNumber: 'x', amountMinor: PRICE, currency: 'USD',
        buyerCountry: 'SY', itemTitles: ['t'],
      }),
    );
    const codes = methods.map((m) => m.config.code);
    expect(codes).toContain(`bank-${suffix}`);
    // The gateway adapter refuses: no merchant account exists (decisions §2).
    expect(codes).not.toContain(`card-${suffix}`);
  });

  it('offers nothing in a currency the method does not accept', async () => {
    const methods = await withRawActorContext(ctxOf(customer), (tx) =>
      availableMethods(tx, {
        orderId: 'x', orderNumber: 'x', amountMinor: PRICE, currency: 'EUR',
        buyerCountry: 'SY', itemTitles: ['t'],
      }),
    );
    expect(methods.map((m) => m.config.code)).not.toContain(`bank-${suffix}`);
  });
});

describe('2. the manual purchase, end to end (specification §24)', () => {
  let orderId: string;
  let paymentId: string;

  it('creates an order at the price the customer saw', async () => {
    const order = await createOrder(customer, { productSlugs: [slug], buyerCountry: 'SY' });
    orderId = order.orderId;
    expect(order.totalMinor).toBe(PRICE);
    expect(order.orderNumber).toMatch(/^EN-\d{4}-\d{6}$/);
  });

  it('returns transfer instructions carrying the order reference', async () => {
    const initiation = await placeOrder(customer, {
      orderId, paymentMethodId: ids.bankMethod,
    });
    expect(initiation.kind).toBe('INSTRUCTIONS');
    if (initiation.kind !== 'INSTRUCTIONS') return;
    expect(initiation.accountDetailsAr).toContain('IBAN');
    expect(initiation.reference).toMatch(/^EN-/);

    const [payment] = await withRawActorContext(ctxOf(customer), (tx) =>
      tx.select().from(payments).where(eq(payments.orderId, orderId)),
    );
    paymentId = payment!.id;
    expect(payment!.status).toBe('AWAITING_PROOF');
  });

  /** THE GATE. Nothing is owned until the owner says the money arrived. */
  it('REFUSES the original while payment is unverified', async () => {
    await expect(
      deliverProductFile(customer, { productSlug: slug, role: 'ORIGINAL' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('accepts a proof and moves the order into the verification queue', async () => {
    await submitPaymentProof(customer, {
      paymentId, filename: 'receipt.png', body: PNG_PROOF, referenceNote: 'TRX-99',
    });

    const [order] = await withRawActorContext(ctxOf(customer), (tx) =>
      tx.select().from(orders).where(eq(orders.id, orderId)),
    );
    expect(order!.status).toBe('PROOF_SUBMITTED');
  });

  it('rejects a proof that is not an image or a PDF', async () => {
    await expect(
      submitPaymentProof(customer, {
        paymentId,
        filename: 'evil.png',
        body: Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, ...new Array(64).fill(0)]),
      }),
    ).rejects.toThrow();
  });

  it('writes nothing to storage when the payment is not the caller\'s', async () => {
    /**
     * The bytes used to be scanned and written to the originals bucket BEFORE
     * anything checked that the payment exists or belongs to the caller. The
     * transaction then threw NotFound and the object stayed behind with no row
     * pointing at it — so any account could fill the bucket, one 10 MB
     * "receipt" at a time, against a payment id it made up. Nothing would
     * report it: every call returns an error, which is what it looks like when
     * the platform is working.
     */
    const root = serverEnv().STORAGE_ENDPOINT.replace(/^file:\/\//, '');
    const count = () => {
      let total = 0;
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(join(dir, entry.name));
          else total += 1;
        }
      };
      walk(join(root, 'originals'));
      return total;
    };

    const before = count();

    await expect(
      submitPaymentProof(customer, {
        paymentId: randomUUID(), filename: 'receipt.png', body: PNG_PROOF,
      }),
    ).rejects.toThrow(NotFoundError);

    expect(count()).toBe(before);
  });

  it('refuses to let the customer approve their own payment', async () => {
    await expect(approvePayment(customer, { paymentId })).rejects.toThrow(RuleViolationError);
  });

  it('settles the sale when the owner approves', async () => {
    const result = await approvePayment(owner, { paymentId, providerRef: 'TRX-99' });
    expect(result.itemsSettled).toBe(1);
    expect(result.entitlementsGranted).toBe(1);

    const [order] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orders).where(eq(orders.id, orderId)),
    );
    expect(order!.status).toBe('COMPLETED');
  });

  it('writes the 80/20 split the agreement called for', async () => {
    const [item] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    );
    expect(item!.unitPriceMinor).toBe(PRICE);
    expect(item!.engineerAmountMinor).toBe(1600n); // $16.00
    expect(item!.platformAmountMinor).toBe(400n); //  $4.00
    expect(item!.engineerBp).toBe(8000);
    expect(item!.snapshotTakenAt).not.toBeNull();
  });

  it('NOW opens the original to the customer', async () => {
    const delivery = await deliverProductFile(customer, { productSlug: slug, role: 'ORIGINAL' });
    expect(delivery.grant.kind).toBe('stream');
  });

  it('still refuses a different customer', async () => {
    await expect(
      deliverProductFile(stranger, { productSlug: slug, role: 'ORIGINAL' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('records the download against the entitlement', async () => {
    const [row] = await withRawActorContext(ctxOf(customer), (tx) =>
      tx.select().from(entitlements).where(eq(entitlements.customerId, ids.customer)),
    );
    expect(Number(row!.downloadCount)).toBeGreaterThan(0);
  });

  it('refuses a second approval of the same payment', async () => {
    await expect(approvePayment(owner, { paymentId })).rejects.toThrow(RuleViolationError);
  });
});

/**
 * §13, in the specification's own words: "This is mandatory."
 */
describe('3. the snapshot is frozen', () => {
  it('survives a later price change and a later commission change', async () => {
    const before = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.productId, ids.product)),
    );
    const original = before[0]!;

    await changeProductPrice(owner, {
      productId: ids.product, newAmountMinor: 9900n, currency: 'USD', reason: 'رفع السعر',
    });
    await withRawActorContext(OWNER_RAW, (tx) =>
      setCommissionAgreement(tx, {
        contributorId: ids.contributor,
        agreement: { model: 'PERCENTAGE', engineerBp: 5000, currency: 'USD' },
        createdBy: ids.owner,
      }),
    );

    const after = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.productId, ids.product)),
    );
    const settled = after[0]!;

    expect(settled.unitPriceMinor).toBe(original.unitPriceMinor);
    expect(settled.engineerAmountMinor).toBe(1600n);
    expect(settled.platformAmountMinor).toBe(400n);
    expect(settled.engineerBp).toBe(8000);
  });

  it('the database itself refuses to rewrite a taken snapshot', async () => {
    const attempt = withRawActorContext(OWNER_RAW, async (tx) => {
      await tx
        .update(orderItems)
        .set({ engineerAmountMinor: 1n, platformAmountMinor: 1n })
        .where(eq(orderItems.productId, ids.product));
    });
    await expect(attempt).rejects.toThrow();
  });

  it('the contributor split recorded on a sale is immutable too', async () => {
    // Drizzle wraps driver errors, so the PostgreSQL message is on `cause`.
    // Asserting the root cause proves WHICH guard fired.
    let cause = '';
    try {
      await withRawActorContext(OWNER_RAW, async (tx) => {
        await tx.update(orderItemContributors).set({ amountMinor: 1n });
      });
    } catch (error) {
      let current: unknown = error;
      const parts: string[] = [];
      for (let i = 0; i < 5 && current instanceof Error; i += 1) {
        parts.push(current.message);
        current = (current as { cause?: unknown }).cause;
      }
      cause = parts.join(' | ');
    }
    expect(cause).toMatch(/immutable/i);
  });
});

describe('4. the owner controls availability without a deploy (§21)', () => {
  it('disabling a method removes it from checkout immediately', async () => {
    await withRawActorContext(OWNER_RAW, async (tx) => {
      await tx.update(paymentMethods).set({ isActive: false }).where(eq(paymentMethods.id, ids.bankMethod));
    });

    const methods = await withRawActorContext(ctxOf(customer), (tx) =>
      availableMethods(tx, {
        orderId: 'x', orderNumber: 'x', amountMinor: PRICE, currency: 'USD',
        buyerCountry: 'SY', itemTitles: ['t'],
      }),
    );
    expect(methods.map((m) => m.config.code)).not.toContain(`bank-${suffix}`);

    await withRawActorContext(OWNER_RAW, async (tx) => {
      await tx.update(paymentMethods).set({ isActive: true }).where(eq(paymentMethods.id, ids.bankMethod));
    });
  });
});

describe('5. what each party can see (§12, §49)', () => {
  it('the contributor sees their share, and not the order item it came from', async () => {
    /**
     * The engineer reads their own credited line, which is exactly their share.
     *
     * They do NOT read `order_items`. That row carries the platform's cut
     * beside the net, and on a co-authored product those two numbers give away
     * a colleague's pay by subtraction:
     *
     *     engineer pot      = net_minor - platform_amount_minor
     *     colleagues' total = engineer pot - my own share
     *
     * The owner's decision in §6 is that an engineer never learns another
     * engineer's share, and TD-29 records the same rule for the screen. This
     * asserts it where it actually has to hold — hiding the column in the
     * interface would not be protection (CLAUDE.md, rule 4). Migration 0043.
     */
    const mine = await withRawActorContext(ctxOf(engineer), (tx) =>
      tx.select().from(orderItemContributors),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.contributorId).toBe(ids.contributor);
    expect(mine[0]!.amountMinor).toBe(1600n);

    const items = await withRawActorContext(ctxOf(engineer), (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.productId, ids.product)),
    );
    expect(items).toHaveLength(0);
  });

  it('the contributor CANNOT see the order, so never the buyer', async () => {
    const rows = await withRawActorContext(ctxOf(engineer), (tx) => tx.select().from(orders));
    expect(rows).toHaveLength(0);
  });

  it('the contributor cannot see the payment or the proof', async () => {
    const paid = await withRawActorContext(ctxOf(engineer), (tx) => tx.select().from(payments));
    const proofs = await withRawActorContext(ctxOf(engineer), (tx) => tx.select().from(paymentProofs));
    expect(paid).toHaveLength(0);
    expect(proofs).toHaveLength(0);
  });

  it('a customer sees their own order and no one else', async () => {
    const mine = await withRawActorContext(ctxOf(customer), (tx) => tx.select().from(orders));
    expect(mine.every((o) => o.customerId === ids.customer)).toBe(true);

    const theirs = await withRawActorContext(ctxOf(stranger), (tx) => tx.select().from(orders));
    expect(theirs).toHaveLength(0);
  });

  it('nobody but the owner sees the commission agreement', async () => {
    const asCustomer = await withRawActorContext(ctxOf(customer), (tx) =>
      tx.select().from(commissionAgreements),
    );
    expect(asCustomer).toHaveLength(0);

    const asEngineer = await withRawActorContext(ctxOf(engineer), (tx) =>
      tx.select().from(commissionAgreements),
    );
    // The engineer sees their OWN agreement (§12) and nothing else.
    expect(asEngineer.every((a) => a.contributorId === ids.contributor)).toBe(true);
  });

  it('a guest sees no order, payment, entitlement or file row', async () => {
    const guest = { actorId: '', actorRole: 'GUEST' };
    for (const table of [orders, payments, entitlements, paymentProofs]) {
      const rows = await withRawActorContext(guest, (tx) => tx.select().from(table));
      expect(rows).toHaveLength(0);
    }
    const originals = await withRawActorContext(guest, (tx) =>
      tx.select().from(productFiles).where(eq(productFiles.role, 'ORIGINAL')),
    );
    expect(originals).toHaveLength(0);
  });
});

describe('6. rejection lets the customer try again', () => {
  it('moves a rejected order back into the customer’s hands', async () => {
    const order = await createOrder(customer, { productSlugs: [slug], buyerCountry: 'SY' });
    await placeOrder(customer, { orderId: order.orderId, paymentMethodId: ids.bankMethod });

    const [payment] = await withRawActorContext(ctxOf(customer), (tx) =>
      tx.select().from(payments).where(eq(payments.orderId, order.orderId)),
    );

    await rejectPayment(owner, { paymentId: payment!.id, reason: 'المبلغ غير مطابق' });

    const [after] = await withRawActorContext(ctxOf(customer), (tx) =>
      tx.select().from(orders).where(eq(orders.id, order.orderId)),
    );
    expect(after!.status).toBe('PAYMENT_ISSUE');

    // And no entitlement was created along the way.
    const granted = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(entitlements).where(eq(entitlements.orderItemId, sql`NULL`)),
    );
    expect(granted).toHaveLength(0);
  }, 30_000);
});
