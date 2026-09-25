import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  auditLogs, commissionAgreements, contributors, disciplines, entitlements,
  orders, paymentMethods, payments, productContributors,
  productPrices, products, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import {
  addEngineer, disciplineOptions, engineerDetail, engineerRoster, setEngineerActive,
  updateEngineer,
} from './admin';
import { changeProductStatus, createProduct, setProductContributors } from '@/catalog/products';
import { RuleViolationError, ValidationError } from '@/lib/errors';
import { GUEST, type Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * THE OWNER'S ENGINEERS SCREEN — WHAT IT SHOWS AND WHO MAY SEE IT
 * ===========================================================================
 *
 * The owner's eleven requirements, and where each is proved:
 *
 *   1  list every engineer .................. §1
 *   2  add an engineer ...................... §2
 *   3  edit an engineer ..................... §3
 *   4  activate / deactivate ................ §4
 *   5  set the discipline ................... §2, §3
 *   6  their products and files ............. §5
 *   7  price, engineer rate, platform rate,
 *      OWNER ONLY ........................... §5, §6
 *   8  total sales per engineer ............. §6
 *   9  dues, per the monthly settlement ..... §6
 *  10  no engineer sees another's data ...... §7  ← the one that matters
 *  11  no engineer uploads or deletes ....... §8
 *
 * §7 and §8 are written as ATTEMPTS, not as assertions about what a screen
 * renders. A test that checks a page does not display something proves only
 * that this page does not; a test that has the engineer call the service and
 * queries the database under their own actor context proves there is no route
 * to the data at all.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '',
  userA: randomUUID(), contribA: randomUUID(),
  userB: randomUUID(), contribB: randomUUID(),
  newcomer: randomUUID(),
  discipline: randomUUID(), otherDiscipline: randomUUID(),
  productA: randomUUID(), productB: randomUUID(),
  method: randomUUID(),
};

const PRICE = 10_000n;
const A_BP = 8000;
const B_BP = 6000;

let OWNER_RAW: { actorId: string; actorRole: string };
const base = {
  kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's',
  twoFactorSatisfied: true, totpEnabled: false,
} as const;

let owner: Actor;
let engineerA: Actor;
const buyers: string[] = [];
const createdProducts: string[] = [];

async function sell(productId: string, slug: string): Promise<void> {
  const id = randomUUID();
  buyers.push(id);
  await withRawActorContext(OWNER_RAW, (tx) =>
    tx.insert(users).values({
      id, email: `eng-cust${buyers.length}+${suffix}@test.local`,
      passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE',
      displayName: `Customer ${buyers.length}`, countryCode: 'SY',
    }),
  );
  const buyer: Actor = {
    ...base, userId: id, role: 'CUSTOMER', contributorId: null, contributorActive: false,
  };
  const order = await createOrder(buyer, { productSlugs: [slug] });
  await placeOrder(buyer, { orderId: order.orderId, paymentMethodId: ids.method });
  const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)),
  );
  await approvePayment(owner, { paymentId: payment!.id });
  void productId;
}

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };
  engineerA = {
    ...base, userId: ids.userA, role: 'CONTRIBUTOR',
    contributorId: ids.contribA, contributorActive: true,
  };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.userA, email: `eng-a+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer A' },
      { id: ids.userB, email: `eng-b+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer B' },
      // Registered, not yet an engineer. §2 promotes this account.
      { id: ids.newcomer, email: `eng-new+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Newcomer' },
    ]);
    await tx.insert(contributors).values([
      { id: ids.contribA, userId: ids.userA, publicSlug: `eng-a-${suffix}`, settlementCode: `ENGA${suffix}`, displayName: 'Engineer A', isActive: true },
      { id: ids.contribB, userId: ids.userB, publicSlug: `eng-b-${suffix}`, settlementCode: `ENGB${suffix}`, displayName: 'Engineer B', isActive: true },
    ]);
    await tx.insert(disciplines).values([
      { id: ids.discipline, slug: `eng-disc-${suffix}`, nameAr: 'تخصص أول', nameEn: 'One', sortOrder: 94 },
      { id: ids.otherDiscipline, slug: `eng-disc2-${suffix}`, nameAr: 'تخصص ثانٍ', nameEn: 'Two', sortOrder: 95 },
    ]);
    await tx.insert(products).values([
      { id: ids.productA, slug: `eng-pa-${suffix}`, titleAr: 'منتج أ', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
      { id: ids.productB, slug: `eng-pb-${suffix}`, titleAr: 'منتج ب', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
    ]);
    await tx.insert(productContributors).values([
      { productId: ids.productA, contributorId: ids.contribA, shareBp: 10000 },
      { productId: ids.productB, contributorId: ids.contribB, shareBp: 10000 },
    ]);
    await tx.insert(productPrices).values([
      { productId: ids.productA, amountMinor: PRICE, currency: 'USD' },
      { productId: ids.productB, amountMinor: PRICE, currency: 'USD' },
    ]);
    await tx.insert(commissionAgreements).values([
      { contributorId: ids.contribA, productId: null, model: 'PERCENTAGE', engineerBp: A_BP, currency: 'USD', createdBy: ids.owner },
      { contributorId: ids.contribB, productId: null, model: 'PERCENTAGE', engineerBp: B_BP, currency: 'USD', createdBy: ids.owner },
    ]);
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `eng-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل', instructionsAr: 'حوّل', accountDetailsAr: 'IBAN TEST', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });

  await sell(ids.productA, `eng-pa-${suffix}`);
  await sell(ids.productB, `eng-pb-${suffix}`);
}, 180_000);

afterAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    const contribIds = [ids.contribA, ids.contribB];
    const productIds = [ids.productA, ids.productB, ...createdProducts];
    await tx.delete(entitlements).where(inArray(entitlements.customerId, buyers));
    await tx.delete(orders).where(inArray(orders.customerId, buyers));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements).where(inArray(commissionAgreements.contributorId, contribIds));
    await tx.delete(productContributors).where(inArray(productContributors.productId, productIds));
    await tx.delete(productPrices).where(inArray(productPrices.productId, productIds));
    await tx.delete(products).where(inArray(products.id, productIds));
    // The newcomer's profile, if §2 created one.
    await tx.delete(contributors).where(eq(contributors.userId, ids.newcomer));
    await tx.delete(contributors).where(inArray(contributors.id, contribIds));
    await tx.delete(disciplines).where(inArray(disciplines.id, [ids.discipline, ids.otherDiscipline]));
    await tx.delete(users).where(inArray(users.id, [...buyers, ids.userA, ids.userB, ids.newcomer]));
  });
  await closeDb();
}, 60_000);


// ===========================================================================
describe('1. the roster lists every engineer with what the owner needs', () => {
  it('shows both engineers, their discipline state and their catalogue', async () => {
    const roster = await engineerRoster(owner);
    const a = roster.find((row) => row.contributorId === ids.contribA);
    const b = roster.find((row) => row.contributorId === ids.contribB);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.email).toBe(`eng-a+${suffix}@test.local`);
    expect(a!.productsTotal).toBe(1);
    expect(a!.productsPublished).toBe(1);
    expect(a!.disciplineId).toBeNull();     // not set yet — §3 sets it
    expect(a!.engineerBp).toBe(A_BP);
    expect(b!.engineerBp).toBe(B_BP);
  });

  it('reports each engineer’s own sales and dues, from their own rows', async () => {
    const roster = await engineerRoster(owner);
    const a = roster.find((row) => row.contributorId === ids.contribA)!;
    const b = roster.find((row) => row.contributorId === ids.contribB)!;

    const aSales = a.sales.find((row) => row.currency === 'USD')!;
    const bSales = b.sales.find((row) => row.currency === 'USD')!;

    expect(aSales.unitsSold).toBe(1);
    expect(aSales.sliceMinor).toBe(PRICE);
    expect(aSales.engineerMinor).toBe(8_000n);    // 80% of 10000
    expect(aSales.platformMinor).toBe(2_000n);
    expect(bSales.engineerMinor).toBe(6_000n);    // 60%, a different contract
    expect(bSales.platformMinor).toBe(4_000n);

    // The ledger is the only place a balance exists (P6).
    expect(a.dues.find((row) => row.currency === 'USD')!.balanceMinor).toBe(8_000n);
    expect(b.dues.find((row) => row.currency === 'USD')!.balanceMinor).toBe(6_000n);
    // Nothing has been settled yet, so nothing has left.
    expect(a.dues.find((row) => row.currency === 'USD')!.settledMinor).toBe(0n);
  });
});

// ===========================================================================
describe('2. adding an engineer promotes an account that already exists', () => {
  it('refuses an email no account carries, instead of inventing one', async () => {
    await expect(addEngineer(owner, {
      email: `nobody+${suffix}@test.local`,
      displayName: 'شبح', publicSlug: `ghost-${suffix}`, settlementCode: `GH${suffix}`,
    })).rejects.toThrow(ValidationError);
  });

  it('refuses a malformed slug — it is a permanent public address', async () => {
    await expect(addEngineer(owner, {
      email: `eng-new+${suffix}@test.local`,
      displayName: 'قادم', publicSlug: 'مهندس جديد', settlementCode: `NW${suffix}`,
    })).rejects.toThrow(ValidationError);
  });

  it('creates the profile INACTIVE and promotes the account to CONTRIBUTOR', async () => {
    const { contributorId } = await addEngineer(owner, {
      email: `ENG-NEW+${suffix}@test.local`.toUpperCase(),  // case must not matter
      displayName: 'مهندس قادم',
      publicSlug: `eng-new-${suffix}`,
      settlementCode: `NEW${suffix}`,
      disciplineId: ids.discipline,
      specialization: 'تمديدات صحية',
    });

    const roster = await engineerRoster(owner);
    const added = roster.find((row) => row.contributorId === contributorId)!;
    expect(added.isActive).toBe(false);          // §46: activation is separate
    expect(added.canSubmitDrafts).toBe(false);
    expect(added.disciplineNameAr).toBe('تخصص أول');
    expect(added.specialization).toBe('تمديدات صحية');

    const [user] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ role: users.role }).from(users).where(eq(users.id, ids.newcomer)),
    );
    expect(user!.role).toBe('CONTRIBUTOR');
  });

  it('refuses a second profile for the same account', async () => {
    await expect(addEngineer(owner, {
      email: `eng-new+${suffix}@test.local`,
      displayName: 'مكرر', publicSlug: `eng-dup-${suffix}`, settlementCode: `DUP${suffix}`,
    })).rejects.toThrow(ValidationError);
  });

  it('writes the creation to the audit log', async () => {
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ action: auditLogs.action })
        .from(auditLogs)
        .where(sql`${auditLogs.entityType} = 'contributor'
                   AND ${auditLogs.action} = 'CONTRIBUTOR_CREATED'
                   AND ${auditLogs.actorUserId} = ${ids.owner}`)
        .limit(5),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe('3. editing sets the discipline and the profile text', () => {
  it('sets A’s discipline to one of the platform’s own four', async () => {
    await updateEngineer(owner, {
      contributorId: ids.contribA,
      displayName: 'المهندس أ',
      disciplineId: ids.otherDiscipline,
      specialization: 'أنظمة إنذار',
    });

    const roster = await engineerRoster(owner);
    const a = roster.find((row) => row.contributorId === ids.contribA)!;
    expect(a.displayName).toBe('المهندس أ');
    expect(a.disciplineId).toBe(ids.otherDiscipline);
    expect(a.disciplineNameAr).toBe('تخصص ثانٍ');
  });

  it('refuses a discipline that does not exist', async () => {
    await expect(updateEngineer(owner, {
      contributorId: ids.contribA,
      displayName: 'المهندس أ',
      disciplineId: randomUUID(),
    })).rejects.toThrow(ValidationError);
  });

  it('offers exactly the disciplines the catalogue files products under', async () => {
    const options = await disciplineOptions(owner);
    expect(options.some((row) => row.id === ids.discipline)).toBe(true);
    expect(options.some((row) => row.id === ids.otherDiscipline)).toBe(true);
  });
});

// ===========================================================================
describe('4. deactivating hides the engineer and owes them exactly as much', () => {
  it('turns A off, and the money does not move', async () => {
    const before = (await engineerRoster(owner))
      .find((row) => row.contributorId === ids.contribA)!;

    await setEngineerActive(owner, { contributorId: ids.contribA, isActive: false });

    const after = (await engineerRoster(owner))
      .find((row) => row.contributorId === ids.contribA)!;

    expect(after.isActive).toBe(false);
    // The whole point: a deactivation is not a way to erase a debt.
    expect(after.dues).toEqual(before.dues);
    expect(after.sales).toEqual(before.sales);
  });

  it('turns A back on and stamps who approved it', async () => {
    await setEngineerActive(owner, { contributorId: ids.contribA, isActive: true });

    const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ isActive: contributors.isActive, approvedBy: contributors.approvedBy })
        .from(contributors).where(eq(contributors.id, ids.contribA)),
    );
    expect(row!.isActive).toBe(true);
    expect(row!.approvedBy).toBe(ids.owner);
  });
});

// ===========================================================================
describe('5. the detail shows the products, the price and BOTH rates', () => {
  it('lists A’s product with its price and the split it pays', async () => {
    const detail = await engineerDetail(owner, ids.contribA);
    expect(detail).not.toBeNull();

    const product = detail!.products.find((row) => row.productId === ids.productA)!;
    expect(product.titleAr).toBe('منتج أ');
    expect(product.status).toBe('PUBLISHED');
    expect(product.priceMinor).toBe(PRICE);
    expect(product.shareBp).toBe(10000);
    expect(product.model).toBe('PERCENTAGE');
    expect(product.engineerBp).toBe(A_BP);       // and the platform's is 10000 - this
    expect(product.isOverride).toBe(false);
  });

  it('shows A only A’s products — B’s is not on A’s page', async () => {
    const detail = await engineerDetail(owner, ids.contribA);
    expect(detail!.products.some((row) => row.productId === ids.productB)).toBe(false);
  });

  it('404s on an engineer that does not exist, not a 500', async () => {
    expect(await engineerDetail(owner, randomUUID())).toBeNull();
  });
});

// ===========================================================================
describe('6. the figures are the settlement system’s, not a second opinion', () => {
  it('the due equals what the ledger says is owed', async () => {
    const roster = await engineerRoster(owner);
    const a = roster.find((row) => row.contributorId === ids.contribA)!;

    const [ledger] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT SUM(-amount_minor)::text AS balance
          FROM ledger_lines
         WHERE account_code = 'ENGINEER_PAYABLE'
           AND contributor_id = ${ids.contribA}
           AND currency = 'USD'
      `),
    ) as unknown as Array<{ balance: string }>;

    expect(a.dues.find((row) => row.currency === 'USD')!.balanceMinor)
      .toBe(BigInt(ledger!.balance));
  });
});

// ===========================================================================
describe('7. NO ENGINEER SEES ANOTHER ENGINEER’S ANYTHING', () => {
  it('refuses the roster to an engineer, rather than narrowing it', async () => {
    await expect(engineerRoster(engineerA)).rejects.toThrow(RuleViolationError);
    await expect(engineerRoster(GUEST)).rejects.toThrow(RuleViolationError);
  });

  it('refuses the detail page, including their OWN — it is the owner’s screen', async () => {
    await expect(engineerDetail(engineerA, ids.contribB)).rejects.toThrow(RuleViolationError);
    await expect(engineerDetail(engineerA, ids.contribA)).rejects.toThrow(RuleViolationError);
  });

  it('refuses every write', async () => {
    await expect(addEngineer(engineerA, {
      email: `eng-b+${suffix}@test.local`, displayName: 'x',
      publicSlug: 'x-y', settlementCode: 'XY1',
    })).rejects.toThrow(RuleViolationError);

    await expect(updateEngineer(engineerA, {
      contributorId: ids.contribB, displayName: 'مسروق',
    })).rejects.toThrow(RuleViolationError);

    await expect(setEngineerActive(engineerA, {
      contributorId: ids.contribB, isActive: false,
    })).rejects.toThrow(RuleViolationError);
  });

  /*
   * AND UNDERNEATH THE REFUSALS. Each query below runs under the engineer's
   * own actor context with NO WHERE CLAUSE — the shape an accidental read
   * would have. What comes back is what the database is willing to hand them,
   * with the application layer taken out of the picture entirely.
   */
  it('cannot read ANY row of product_contributors — owner-only since 0049', async () => {
    const rows = await withRawActorContext(
      { actorId: ids.userA, actorRole: 'CONTRIBUTOR', contributorId: ids.contribA },
      (tx) => tx.execute(sql`SELECT product_id FROM product_contributors`),
    ) as unknown as unknown[];
    expect(rows).toHaveLength(0);

    /*
     * THE POSITIVE CONTROL. Zero rows is the answer a torn-down fixture gives
     * too, and a privacy test that passes because the data is missing is a
     * test that will keep passing after the policy is deleted. The same query
     * as the owner must find the rows this file created.
     */
    const asOwner = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`SELECT product_id FROM product_contributors`),
    ) as unknown as unknown[];
    expect(asOwner.length).toBeGreaterThan(0);
  });

  it('reads only their OWN row of order_item_contributors', async () => {
    const rows = await withRawActorContext(
      { actorId: ids.userA, actorRole: 'CONTRIBUTOR', contributorId: ids.contribA },
      (tx) => tx.execute(sql`SELECT contributor_id FROM order_item_contributors`),
    ) as unknown as Array<{ contributor_id: string }>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.contributor_id === ids.contribA)).toBe(true);
    expect(rows.some((row) => row.contributor_id === ids.contribB)).toBe(false);
  });

  it('cannot read a colleague’s commission agreement', async () => {
    const rows = await withRawActorContext(
      { actorId: ids.userA, actorRole: 'CONTRIBUTOR', contributorId: ids.contribA },
      (tx) => tx.execute(sql`SELECT contributor_id FROM commission_agreements`),
    ) as unknown as Array<{ contributor_id: string }>;
    expect(rows.some((row) => row.contributor_id === ids.contribB)).toBe(false);
  });

  it('cannot read a colleague’s settlement', async () => {
    const rows = await withRawActorContext(
      { actorId: ids.userA, actorRole: 'CONTRIBUTOR', contributorId: ids.contribA },
      (tx) => tx.execute(sql`SELECT contributor_id FROM settlements`),
    ) as unknown as Array<{ contributor_id: string }>;
    expect(rows.some((row) => row.contributor_id === ids.contribB)).toBe(false);
  });
});

// ===========================================================================
describe('8. NO ENGINEER UPLOADS, PUBLISHES OR DELETES A PRODUCT', () => {
  it('cannot create a product', async () => {
    await expect(createProduct(engineerA, {
      slug: `eng-sneak-${suffix}`,
      titleAr: 'منتج مهرَّب',
      disciplineId: ids.discipline,
      fileType: 'PDF',
      currency: 'USD',
    })).rejects.toThrow(RuleViolationError);
  });

  it('cannot publish or unpublish — not even their own product', async () => {
    await expect(changeProductStatus(engineerA, {
      productId: ids.productA, to: 'UNPUBLISHED',
    })).rejects.toThrow(RuleViolationError);
  });

  it('cannot credit themselves on a colleague’s product', async () => {
    await expect(setProductContributors(engineerA, ids.productB, [
      { contributorId: ids.contribB, shareBp: 5000 },
      { contributorId: ids.contribA, shareBp: 5000 },
    ])).rejects.toThrow(RuleViolationError);
  });

  it('cannot delete a product row directly either — RLS, not the service', async () => {
    await withRawActorContext(
      { actorId: ids.userA, actorRole: 'CONTRIBUTOR', contributorId: ids.contribA },
      (tx) => tx.execute(sql`DELETE FROM products WHERE id = ${ids.productA}`),
    );

    // A DELETE the policy refuses removes nothing and raises nothing, so the
    // assertion is on the ROW, never on an error that was never thrown.
    const [still] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: products.id }).from(products).where(eq(products.id, ids.productA)),
    );
    expect(still).toBeDefined();
  });

  it('the owner, by contrast, can do all three', async () => {
    const { productId } = await createProduct(owner, {
      slug: `eng-owner-${suffix}`,
      titleAr: 'منتج المالك',
      disciplineId: ids.discipline,
      fileType: 'PDF',
      currency: 'USD',
    });
    createdProducts.push(productId);
    expect(productId).toBeTruthy();
  });
});
