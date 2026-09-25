import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { withRawActorContext, type Transaction } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements, orders, paymentMethods,
  payments, productContributors, productFiles, productPrices, products, users,
} from '@/db/schema';
import {
  changeProductPrice, changeProductStatus, createProduct, setProductContributors,
} from './products';
import { adminProductDetail } from './admin-queries';
import { setCommissionAgreement } from '@/finance/commission-resolver';
import { saveCommissionAgreement } from '@/finance/commissions';
import { approvePayment, completeFreeOrder, createOrder, placeOrder } from '@/commerce/orders';
import { submitPaymentProof } from '@/commerce/proofs';
import { ingestProductFile } from '@/media/ingest';
import { NotFoundError, RuleViolationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * A PUBLISHED PRODUCT CAN BE SOLD (Stage 2 buyer audit, F2)
 * ===========================================================================
 * Found by operating the site: a paid product whose engineer had no
 * commission agreement could be published. The buyer ordered it, transferred
 * the money and uploaded the receipt — and only when the owner approved the
 * payment did `resolveTermsForSale` refuse the sale, leaving the order stuck
 * in PROOF_SUBMITTED with the money already sent.
 *
 * Now the same question is asked before the product can be offered: at
 * publication (and in the owner's checklist, with the same answer), and on
 * every change that could make a published product unsellable afterwards —
 * its credits, its price or currency, and an engineer's agreement.
 *
 * Free products need no agreement: nothing is paid and nothing is split.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '', customer: randomUUID(), discipline: randomUUID(), bank: randomUUID(),
  uOk: randomUUID(), uNone: randomUUID(), uEur: randomUUID(), uLegA: randomUUID(), uLegB: randomUUID(),
  eOk: randomUUID(), eNone: randomUUID(), eEur: randomUUID(), eLegA: randomUUID(), eLegB: randomUUID(),
  uRace: randomUUID(), eRace: randomUUID(), uRace2: randomUUID(), eRace2: randomUUID(),
  legacy: randomUUID(),
};
const PRICE = 2500n;

let OWNER_RAW: { actorId: string; actorRole: string };
const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true, totpEnabled: false } as const;
let owner: Actor;
const customer: Actor = { ...base, userId: ids.customer, role: 'CUSTOMER', contributorId: null, contributorActive: false };
const engineer: Actor = { ...base, userId: ids.uOk, role: 'CONTRIBUTOR', contributorId: ids.eOk, contributorActive: true };

const PNG_PROOF = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(512).fill(0x20)]);

const asOwner = <T,>(fn: (tx: Transaction) => Promise<T>) => withRawActorContext(OWNER_RAW, fn);
const created: string[] = [];

async function buildPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 6; i += 1) doc.addPage([595, 842]).drawText(`F2 ${i}`, { x: 50, y: 700, size: 24, font });
  return doc.save();
}

/** A product built the way the owner builds one, up to APPROVED — one step from the public. */
async function approvedProduct(
  tag: string,
  price: bigint,
  currency: string,
  credits: readonly string[],
): Promise<{ productId: string; slug: string }> {
  const product = await createProduct(owner, {
    slug: `f2-${tag}-${suffix}`, titleAr: `منتج ${tag}`, disciplineId: ids.discipline,
    fileType: 'PDF', currency,
  });
  created.push(product.productId);
  await setProductContributors(owner, product.productId, credits.map((contributorId) => ({
    contributorId, shareBp: 10_000 / credits.length,
  })));
  await changeProductPrice(owner, { productId: product.productId, newAmountMinor: price, currency, reason: 'F2 test' });
  await ingestProductFile(owner, {
    productId: product.productId, filename: `${tag}.pdf`, declaredType: 'PDF',
    body: await buildPdf(), contentType: 'application/pdf',
  });
  for (const to of ['SUBMITTED', 'IN_REVIEW', 'APPROVED'] as const) {
    await changeProductStatus(owner, { productId: product.productId, to });
  }
  return product;
}

async function refusal(attempt: Promise<unknown>): Promise<RuleViolationError> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof RuleViolationError) return error;
    throw error;
  }
  throw new Error('expected a refusal, got success');
}

const statusOf = async (productId: string) =>
  (await asOwner((tx) => tx.select({ s: products.status }).from(products).where(eq(products.id, productId))))[0]!.s;

const priceOf = async (productId: string) =>
  (await asOwner((tx) => tx.select({ amountMinor: productPrices.amountMinor, currency: productPrices.currency })
    .from(productPrices)
    .where(and(eq(productPrices.productId, productId), isNull(productPrices.effectiveTo)))))[0]!;

const creditsOf = async (productId: string) =>
  (await asOwner((tx) => tx.select({ c: productContributors.contributorId }).from(productContributors)
    .where(eq(productContributors.productId, productId)))).map((r) => r.c).sort();

const openAgreements = (contributorId: string) =>
  asOwner((tx) => tx.select().from(commissionAgreements)
    .where(and(eq(commissionAgreements.contributorId, contributorId), isNull(commissionAgreements.effectiveTo))));

let unagreed: { productId: string; slug: string };
let wrongCurrency: { productId: string; slug: string };
let sellable: { productId: string; slug: string };
let free: { productId: string; slug: string };

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  const engineers = [
    [ids.uOk, ids.eOk, 'ok'], [ids.uNone, ids.eNone, 'none'], [ids.uEur, ids.eEur, 'eur'],
    [ids.uLegA, ids.eLegA, 'lega'], [ids.uLegB, ids.eLegB, 'legb'],
    [ids.uRace, ids.eRace, 'race'], [ids.uRace2, ids.eRace2, 'racetwo'],
  ] as const;

  await asOwner(async (tx) => {
    await tx.insert(users).values([
      { id: ids.customer, email: `f2-c+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Customer' },
      ...engineers.map(([u, , tag]) => ({
        id: u, email: `f2-${tag}+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR' as const, status: 'ACTIVE' as const, displayName: tag,
      })),
    ]);
    await tx.insert(contributors).values(engineers.map(([u, c, tag]) => ({
      id: c, userId: u, publicSlug: `f2-${tag}-${suffix}`, settlementCode: `F2${tag.toUpperCase()}${suffix}`,
      displayName: `مهندس ${tag}`, isActive: true,
    })));
    await tx.insert(commissionAgreements).values([
      { contributorId: ids.eOk, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner },
      { contributorId: ids.eEur, productId: null, model: 'PERCENTAGE', engineerBp: 7000, currency: 'EUR', createdBy: ids.owner },
      { contributorId: ids.eRace, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner },
      { contributorId: ids.eRace2, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner },
    ]);
    await tx.insert(disciplines).values({ id: ids.discipline, slug: `f2-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 95 });
    await tx.insert(paymentMethods).values({
      id: ids.bank, code: `f2-bank-${suffix}`, type: 'MANUAL', displayNameAr: 'تحويل بنكي',
      instructionsAr: 'حوّل المبلغ', accountDetailsAr: 'IBAN SY00 TEST', requiresProof: true,
      countries: [], currencies: ['USD', 'EUR'], isActive: true, sortOrder: 1,
    });
  });

  unagreed = await approvedProduct('unagreed', PRICE, 'USD', [ids.eNone]);
  wrongCurrency = await approvedProduct('eurprice', PRICE, 'EUR', [ids.eOk]);
  sellable = await approvedProduct('sellable', PRICE, 'USD', [ids.eOk]);
  free = await approvedProduct('free', 0n, 'USD', [ids.eNone]);
}, 180_000);

afterAll(async () => {
  await asOwner(async (tx) => {
    const all = [...created, ids.legacy];
    const engineers = [ids.eOk, ids.eNone, ids.eEur, ids.eLegA, ids.eLegB, ids.eRace, ids.eRace2];
    await tx.delete(orders).where(eq(orders.customerId, ids.customer));
    await tx.delete(entitlements).where(eq(entitlements.customerId, ids.customer));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.bank));
    await tx.delete(commissionAgreements).where(inArray(commissionAgreements.contributorId, engineers));
    await tx.delete(productContributors).where(inArray(productContributors.productId, all));
    await tx.delete(productFiles).where(inArray(productFiles.productId, all));
    await tx.delete(productPrices).where(inArray(productPrices.productId, all));
    await tx.delete(products).where(inArray(products.id, all));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(inArray(contributors.id, engineers));
    await tx.delete(users).where(inArray(users.id, [
      ids.customer, ids.uOk, ids.uNone, ids.uEur, ids.uLegA, ids.uLegB, ids.uRace, ids.uRace2,
    ]));
  });
  await closeDb();
});

// ===========================================================================
describe('1. publication asks whether the product can be sold', () => {
  it('refuses a paid product whose engineer has no agreement', async () => {
    const error = await refusal(changeProductStatus(owner, { productId: unagreed.productId, to: 'PUBLISHED' }));
    expect(error.message).toBe('المنتج غير جاهز للنشر');
    expect(error.details.blockers).toEqual(['لا يوجد اتفاق عمولة سارٍ للمهندس مهندس none']);
    expect(await statusOf(unagreed.productId)).toBe('APPROVED');
  });

  it('refuses a paid product whose engineer’s agreement is in another currency', async () => {
    const error = await refusal(changeProductStatus(owner, { productId: wrongCurrency.productId, to: 'PUBLISHED' }));
    expect(error.details.blockers).toEqual(['اتفاق عمولة المهندس مهندس ok بعملة USD وسعر المنتج بعملة EUR']);
    expect(await statusOf(wrongCurrency.productId)).toBe('APPROVED');
  });

  it('publishes a paid product whose engineer has matching terms', async () => {
    await expect(changeProductStatus(owner, { productId: sellable.productId, to: 'PUBLISHED' }))
      .resolves.toBe('PUBLISHED');
  });

  it('publishes a FREE product with no agreement at all — there is nothing to split', async () => {
    await expect(changeProductStatus(owner, { productId: free.productId, to: 'PUBLISHED' }))
      .resolves.toBe('PUBLISHED');
  });
});

// ===========================================================================
describe('2. the original failure cannot happen', () => {
  /**
   * Before the fix: PUBLISHED → order → payment → receipt → approval refused →
   * stuck in PROOF_SUBMITTED. Now the product never reaches the public, so the
   * buyer cannot start the road that ended there.
   */
  it('the buyer cannot even open an order for the product that would be refused', async () => {
    await expect(createOrder(customer, { productSlugs: [unagreed.slug] })).rejects.toThrow();
    const rows = await asOwner((tx) => tx.select().from(orders).where(eq(orders.customerId, ids.customer)));
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
describe('3. the paths that already worked still work', () => {
  it('a paid purchase of a sellable product completes end to end', async () => {
    const order = await createOrder(customer, { productSlugs: [sellable.slug] });
    expect(order.totalMinor).toBe(PRICE);
    await placeOrder(customer, { orderId: order.orderId, paymentMethodId: ids.bank });
    const [payment] = await asOwner((tx) => tx.select().from(payments).where(eq(payments.orderId, order.orderId)));
    await submitPaymentProof(customer, { paymentId: payment!.id, filename: 'r.png', body: PNG_PROOF });

    const approved = await approvePayment(owner, { paymentId: payment!.id });
    expect(approved.entitlementsGranted).toBe(1);
    const [row] = await asOwner((tx) => tx.select({ s: orders.status }).from(orders).where(eq(orders.id, order.orderId)));
    expect(row!.s).toBe('COMPLETED');
  });

  it('a free product is still taken without payment (F1)', async () => {
    const order = await createOrder(customer, { productSlugs: [free.slug] });
    expect(order.totalMinor).toBe(0n);
    const done = await completeFreeOrder(customer, { orderId: order.orderId });
    expect(done.entitlementsGranted).toBe(1);
  });
});

// ===========================================================================
describe('4. a published product cannot be made unsellable afterwards', () => {
  it('refuses to put a price on a published FREE product whose engineer has no agreement', async () => {
    const error = await refusal(changeProductPrice(owner, {
      productId: free.productId, newAmountMinor: 500n, currency: 'USD',
    }));
    expect(error.message).toContain('لا يوجد اتفاق عمولة سارٍ للمهندس مهندس none');
    expect(await priceOf(free.productId)).toEqual({ amountMinor: 0n, currency: 'USD' });
  });

  it('refuses to credit an engineer with no agreement on a published paid product', async () => {
    const error = await refusal(setProductContributors(owner, sellable.productId, [
      { contributorId: ids.eOk, shareBp: 5000 },
      { contributorId: ids.eNone, shareBp: 5000 },
    ]));
    expect(error.message).toContain('لا يوجد اتفاق عمولة سارٍ للمهندس مهندس none');
    expect(await creditsOf(sellable.productId)).toEqual([ids.eOk]);
  });

  it('refuses to credit an engineer whose agreement is in another currency', async () => {
    await refusal(setProductContributors(owner, sellable.productId, [{ contributorId: ids.eEur, shareBp: 10_000 }]));
    expect(await creditsOf(sellable.productId)).toEqual([ids.eOk]);
  });

  it('refuses to move a published paid product to a currency its engineer has no terms in', async () => {
    const error = await refusal(changeProductPrice(owner, {
      productId: sellable.productId, newAmountMinor: PRICE, currency: 'EUR',
    }));
    expect(error.message).toContain('بعملة USD وسعر المنتج بعملة EUR');
    expect(await priceOf(sellable.productId)).toEqual({ amountMinor: PRICE, currency: 'USD' });
  });

  it('still allows a price change in the same currency', async () => {
    await changeProductPrice(owner, { productId: sellable.productId, newAmountMinor: 3000n, currency: 'USD' });
    expect(await priceOf(sellable.productId)).toEqual({ amountMinor: 3000n, currency: 'USD' });
  });

  it('still allows making a published product free', async () => {
    await changeProductPrice(owner, { productId: sellable.productId, newAmountMinor: 0n, currency: 'EUR' });
    await changeProductPrice(owner, { productId: sellable.productId, newAmountMinor: PRICE, currency: 'USD' });
    expect(await priceOf(sellable.productId)).toEqual({ amountMinor: PRICE, currency: 'USD' });
  });
});

// ===========================================================================
describe('5. an agreement change cannot strand a published product', () => {
  it('refuses to move an engineer’s default to a currency their published product is not priced in', async () => {
    const before = await openAgreements(ids.eOk);
    const error = await refusal(saveCommissionAgreement(owner, {
      contributorId: ids.eOk, productId: null,
      agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'EUR' },
    }));
    expect(error.message).toContain('بعملة EUR وسعر المنتج بعملة USD');
    expect(await openAgreements(ids.eOk)).toEqual(before);
  });

  it('refuses a product-scoped override in the wrong currency', async () => {
    await refusal(saveCommissionAgreement(owner, {
      contributorId: ids.eOk, productId: sellable.productId,
      agreement: { model: 'PERCENTAGE', engineerBp: 9000, currency: 'EUR' },
    }));
    const overrides = await asOwner((tx) => tx.select().from(commissionAgreements)
      .where(eq(commissionAgreements.productId, sellable.productId)));
    expect(overrides).toHaveLength(0);
  });

  it('refuses it through the low-level writer too, not only the owner screen', async () => {
    await refusal(asOwner((tx) => setCommissionAgreement(tx, {
      contributorId: ids.eOk, productId: null,
      agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'EUR' }, createdBy: ids.owner,
    })));
    expect((await openAgreements(ids.eOk))[0]!.currency).toBe('USD');
  });

  it('still allows changing the rate in the same currency', async () => {
    await saveCommissionAgreement(owner, {
      contributorId: ids.eOk, productId: null,
      agreement: { model: 'PERCENTAGE', engineerBp: 7500, currency: 'USD' },
    });
    const [open] = await openAgreements(ids.eOk);
    expect(open!.engineerBp).toBe(7500);
  });
});

// ===========================================================================
describe('6. a product published before this rule can be repaired, not frozen', () => {
  beforeAll(async () => {
    // Written directly, as older data and the seeds were: published, paid, and
    // neither engineer has terms. The rule does not rewrite existing rows.
    await asOwner(async (tx) => {
      await tx.insert(products).values({
        id: ids.legacy, slug: `f2-legacy-${suffix}`, titleAr: 'منتج قديم', disciplineId: ids.discipline,
        fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date(),
      });
      await tx.insert(productContributors).values([
        { productId: ids.legacy, contributorId: ids.eLegA, shareBp: 5000 },
        { productId: ids.legacy, contributorId: ids.eLegB, shareBp: 5000 },
      ]);
      await tx.insert(productPrices).values({ productId: ids.legacy, amountMinor: PRICE, currency: 'USD' });
    });
  });

  it('accepts terms for one engineer at a time — each step makes it no worse', async () => {
    await saveCommissionAgreement(owner, {
      contributorId: ids.eLegA, productId: null,
      agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD' },
    });
    // (It has no file either — written directly — so only its terms are read here.)
    const { blockers } = await adminProductDetail(owner, ids.legacy);
    expect(blockers).toContain('لا يوجد اتفاق عمولة سارٍ للمهندس مهندس legb');
    expect(blockers).not.toContain('لا يوجد اتفاق عمولة سارٍ للمهندس مهندس lega');
  });

  it('but still refuses a change that breaks it further', async () => {
    await refusal(changeProductPrice(owner, { productId: ids.legacy, newAmountMinor: PRICE, currency: 'EUR' }));
    expect(await priceOf(ids.legacy)).toEqual({ amountMinor: PRICE, currency: 'USD' });
  });
});

// ===========================================================================
describe('7. the owner’s checklist says exactly what the publish says', () => {
  it('lists the same blockers the refused publish reported', async () => {
    for (const product of [unagreed, wrongCurrency]) {
      const error = await refusal(changeProductStatus(owner, { productId: product.productId, to: 'PUBLISHED' }));
      const detail = await adminProductDetail(owner, product.productId);
      expect(detail.blockers).toEqual(error.details.blockers);
      expect(detail.blockers.length).toBeGreaterThan(0);
    }
  });

  it('shows nothing blocking a product that published', async () => {
    expect((await adminProductDetail(owner, sellable.productId)).blockers).toEqual([]);
    expect((await adminProductDetail(owner, free.productId)).blockers).toEqual([]);
  });
});

// ===========================================================================
describe('8. nothing here opened a door', () => {
  it('an engineer cannot publish, price, credit or set terms', async () => {
    await expect(changeProductStatus(engineer, { productId: sellable.productId, to: 'UNPUBLISHED' })).rejects.toThrow();
    await expect(changeProductPrice(engineer, { productId: sellable.productId, newAmountMinor: 1n, currency: 'USD' })).rejects.toThrow();
    await expect(setProductContributors(engineer, sellable.productId, [{ contributorId: ids.eOk, shareBp: 10_000 }]))
      .rejects.toThrow(RuleViolationError);
    await expect(saveCommissionAgreement(engineer, {
      contributorId: ids.eOk, productId: null, agreement: { model: 'PERCENTAGE', engineerBp: 10_000, currency: 'USD' },
    })).rejects.toThrow(RuleViolationError);
    expect(await statusOf(sellable.productId)).toBe('PUBLISHED');
    expect(await priceOf(sellable.productId)).toEqual({ amountMinor: PRICE, currency: 'USD' });
  });

  it('an engineer writing terms straight to the database is refused by RLS, not by this check', async () => {
    await expect(withRawActorContext(
      { actorId: ids.uOk, actorRole: 'CONTRIBUTOR', contributorId: ids.eOk },
      (tx) => setCommissionAgreement(tx, {
        contributorId: ids.eOk, productId: null,
        agreement: { model: 'PERCENTAGE', engineerBp: 10_000, currency: 'USD' }, createdBy: ids.uOk,
      }),
    )).rejects.toThrow();
    expect((await openAgreements(ids.eOk))[0]!.engineerBp).toBe(7500);
  });

  it('a price change for a product that does not exist is "not found"', async () => {
    await expect(changeProductPrice(owner, { productId: randomUUID(), newAmountMinor: 1n, currency: 'USD' }))
      .rejects.toThrow(NotFoundError);
  });
});

// ===========================================================================
describe('9. giving the engineer terms is what makes it publishable', () => {
  it('publishes once the missing agreement exists', async () => {
    await saveCommissionAgreement(owner, {
      contributorId: ids.eNone, productId: null,
      agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD' },
    });
    await expect(changeProductStatus(owner, { productId: unagreed.productId, to: 'PUBLISHED' }))
      .resolves.toBe('PUBLISHED');
  });
});

// ===========================================================================
/**
 * THE RACE THE CODE REVIEW FOUND. An agreement change reads which products
 * its engineer is credited on; a credit change checks the engineer's terms.
 * Run at the same moment, each could read the other's state from before it
 * committed — both would pass, and a published product would be left with an
 * engineer whose terms are in the wrong currency.
 *
 * Both now take the engineer's row first — the agreement change exclusively,
 * the credit change in share mode — so one always waits for the other and
 * then reads what it wrote. These tests do not rely on timing: each holds one
 * side open in a transaction, proves (from pg_stat_activity) that the other
 * side is BLOCKED on the expected lock, and only then lets the first commit.
 */
describe('10. an agreement change and a credit change cannot pass each other', () => {
  // Published by section 1 in a full run; published here when run on its own.
  beforeAll(async () => {
    if ((await statusOf(sellable.productId)) !== 'PUBLISHED') {
      await changeProductStatus(owner, { productId: sellable.productId, to: 'PUBLISHED' });
    }
  });

  /** Resolves once a backend of this database waits on a lock in a statement matching `pattern`. */
  async function blockedOn(pattern: string, pending: Promise<unknown>): Promise<void> {
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 400; i += 1) {
      if (settled) throw new Error(`the operation finished instead of waiting on a lock (${pattern})`);
      const [row] = await asOwner((tx) => tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`));
      if (row && Number(row.n) > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`nothing waited on a lock matching ${pattern}`);
  }

  function gate(): { opened: Promise<void>; open: () => void } {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { opened, open };
  }

  it('agreement change first: the credit waits, then reads the NEW terms and is refused', async () => {
    const release = gate();
    const reached = gate();

    // Engineer `race` is credited on nothing published, so moving their default
    // to EUR is allowed on its own. Held open: written, locked, not committed.
    const agreementChange = asOwner(async (tx) => {
      await setCommissionAgreement(tx, {
        contributorId: ids.eRace, productId: null,
        agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'EUR' }, createdBy: ids.owner,
      });
      reached.open();
      await release.opened;
    });
    try {
      await reached.opened;

      // Meanwhile: credit `race` on the published USD product.
      const credit = setProductContributors(owner, sellable.productId, [
        { contributorId: ids.eOk, shareBp: 5000 },
        { contributorId: ids.eRace, shareBp: 5000 },
      ]);
      await blockedOn('%"contributors"%for share%', credit);

      release.open();
      await agreementChange;

      const error = await refusal(credit);
      expect(error.message).toContain('اتفاق عمولة المهندس مهندس race بعملة EUR وسعر المنتج بعملة USD');
      expect(await creditsOf(sellable.productId)).toEqual([ids.eOk]);
      expect((await openAgreements(ids.eRace))[0]!.currency).toBe('EUR');
      expect((await adminProductDetail(owner, sellable.productId)).blockers).toEqual([]);
    } finally {
      // Never leave the held transaction open: it would block the teardown.
      release.open();
      await agreementChange.catch(() => undefined);
    }
  });

  it('credit change first: the agreement change waits, then sees the new product and is refused', async () => {
    const release = gate();
    const reached = gate();

    // Hold the product itself, so the credit change stops INSIDE its own
    // transaction — after it has taken the engineer's row, before it commits.
    const productHold = asOwner(async (tx) => {
      await tx.select({ id: products.id }).from(products)
        .where(eq(products.id, sellable.productId)).for('update');
      reached.open();
      await release.opened;
    });
    try {
      await reached.opened;

      const credit = setProductContributors(owner, sellable.productId, [
        { contributorId: ids.eOk, shareBp: 5000 },
        { contributorId: ids.eRace2, shareBp: 5000 },
      ]);
      await blockedOn('%"products"%for update%', credit);

      // Engineer `racetwo` is not yet credited on anything published.
      const agreementChange = saveCommissionAgreement(owner, {
        contributorId: ids.eRace2, productId: null,
        agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'EUR' },
      });
      await blockedOn('%"contributors"%for no key update%', agreementChange);

      release.open();
      await productHold;
      await credit;

      const error = await refusal(agreementChange);
      expect(error.message).toContain('اتفاق عمولة المهندس مهندس racetwo بعملة EUR وسعر المنتج بعملة USD');
      expect(await creditsOf(sellable.productId)).toEqual([ids.eOk, ids.eRace2].sort());
      expect((await openAgreements(ids.eRace2))[0]!.currency).toBe('USD');
      expect((await adminProductDetail(owner, sellable.productId)).blockers).toEqual([]);
    } finally {
      // Never leave the held transaction open: it would block the teardown.
      release.open();
      await productHold.catch(() => undefined);
    }
  });
});
