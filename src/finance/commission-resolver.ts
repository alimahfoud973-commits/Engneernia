import 'server-only';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  commissionAgreements, contributors, productContributors, productPrices, products,
} from '@/db/schema';
import type { Transaction } from '@/db/actor-context';
import { extractTax, type TaxBreakdown } from '@/lib/money/tax';
import { MoneyInvariantError, RuleViolationError, ValidationError } from '@/lib/errors';
import { money, subtract, type Money } from '@/lib/money/money';
import {
  computeCommissionSnapshot, type CommissionAgreement, type CommissionModel,
} from '@/lib/money/commission';
import { distributeEngineerAmount, type ContributorShare } from '@/lib/money/distribution';

/**
 * ===========================================================================
 * RESOLVING THE TERMS THAT APPLY TO ONE SALE (specification §11, §13)
 * ===========================================================================
 *   product-specific agreement  →  else contributor default  →  else refuse
 *
 * There is deliberately NO platform-wide fallback rate. A sale whose terms
 * nobody agreed is a sale nobody can be paid for correctly, and inventing a
 * default here would be exactly the kind of silent business rule the owner
 * asked not to have invented.
 * ===========================================================================
 */

export interface ResolvedTerms {
  /**
   * The catalogue price as displayed, tax included and BEFORE any discount.
   *
   * This is the number compared against the price frozen on the order line, so
   * that a price moved between placing an order and approving its payment is
   * caught. A discount must not look like a price change, which is why the
   * comparison uses this and not `payableMinor`.
   */
  readonly grossMinor: bigint;
  /** Taken off the displayed price. Zero unless the order line carries one. */
  readonly discountMinor: bigint;
  /**
   * What the customer actually pays: `grossMinor - discountMinor`, tax still
   * included. This — not the list price — is what the ledger books, what the
   * invoice totals, and what `tax` was extracted from.
   */
  readonly payableMinor: bigint;
  /**
   * The tax inside `payableMinor`, never inside the list price. A discount
   * reduces the tax with everything else: the state's portion is a share of
   * what changed hands, not of a price nobody paid.
   */
  readonly tax: TaxBreakdown;
  readonly priceRowId: string;
  /**
   * The LINE's totals, summed from the per-contributor splits below.
   *
   * `model` and `engineerBp` describe the line only when exactly one engineer
   * is credited. On a co-authored product there is no single model or rate for
   * the line — that is the whole of OPEN-15 — so both are null and the truth
   * lives on the per-contributor rows, which is the only place it can.
   */
  readonly line: {
    readonly model: CommissionModel | null;
    readonly engineerBp: number | null;
    readonly engineerAmountMinor: bigint;
    readonly platformAmountMinor: bigint;
    /** True when any contributor's fixed agreement had to be capped. */
    readonly clamped: boolean;
  };
  /**
   * One entry per credited engineer: their slice of the sale, THEIR OWN
   * agreement, and what that agreement made of it (owner decision on OPEN-15).
   */
  readonly distribution: ReadonlyArray<{
    readonly contributorId: string;
    readonly shareBp: number;
    /** Their portion of the tax-free, post-discount pot. */
    readonly sliceMinor: bigint;
    /** What they earn from it, under their own agreement. */
    readonly amountMinor: bigint;
    /** What the platform takes from THEIR slice, and from no one else's. */
    readonly platformAmountMinor: bigint;
    readonly agreementId: string;
    readonly model: CommissionModel;
    readonly engineerBp: number | null;
    readonly engineerFixedMinor: bigint | null;
    readonly platformFixedMinor: bigint | null;
    readonly clamped: boolean;
  }>;
}

function toAgreement(row: typeof commissionAgreements.$inferSelect): CommissionAgreement {
  switch (row.model) {
    case 'PERCENTAGE':
      if (row.engineerBp === null) {
        throw new RuleViolationError('اتفاق نسبة بلا قيمة نسبة', { agreementId: row.id });
      }
      return { model: 'PERCENTAGE', engineerBp: row.engineerBp, currency: row.currency };
    case 'FIXED_ENGINEER':
      if (row.engineerFixedMinor === null) {
        throw new RuleViolationError('اتفاق مبلغ ثابت بلا قيمة', { agreementId: row.id });
      }
      return {
        model: 'FIXED_ENGINEER',
        engineerFixedMinor: row.engineerFixedMinor,
        currency: row.currency,
      };
    case 'FIXED_PLATFORM':
      if (row.platformFixedMinor === null) {
        throw new RuleViolationError('اتفاق حصة منصة ثابتة بلا قيمة', { agreementId: row.id });
      }
      return {
        model: 'FIXED_PLATFORM',
        platformFixedMinor: row.platformFixedMinor,
        currency: row.currency,
      };
  }
}

type AgreementRow = typeof commissionAgreements.$inferSelect;

/**
 * The agreement in force RIGHT NOW for this product, chosen from rows already
 * read — or null when there is none.
 *
 * "In force" means the open row (effective_to IS NULL), which is what the
 * temporal table guarantees exactly one of per scope. A product-scoped row
 * wins over the contributor's default (§11).
 *
 * The one rule both the sale and the sale-readiness check below apply, so the
 * two can never disagree about which agreement governs a slice.
 */
function pickAgreement(
  rows: readonly AgreementRow[],
  contributorId: string,
  productId: string,
): AgreementRow | null {
  const open = rows.filter((r) => r.contributorId === contributorId && r.effectiveTo === null);
  const override = open.find((r) => r.productId === productId);
  if (override) return override;

  const defaults = open
    .filter((r) => r.productId === null)
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  return defaults[0] ?? null;
}

async function findAgreement(
  tx: Transaction,
  contributorId: string,
  productId: string,
): Promise<AgreementRow> {
  const rows = await tx
    .select()
    .from(commissionAgreements)
    .where(
      and(
        eq(commissionAgreements.contributorId, contributorId),
        isNull(commissionAgreements.effectiveTo),
        or(isNull(commissionAgreements.productId), eq(commissionAgreements.productId, productId)),
      ),
    );

  const agreement = pickAgreement(rows, contributorId, productId);
  if (agreement) return agreement;

  throw new RuleViolationError(
    'لا يوجد اتفاق عمولة سارٍ لهذا المنتج — لا يمكن إتمام البيع',
    { contributorId, productId },
  );
}

/**
 * ===========================================================================
 * CAN THIS PRODUCT BE SOLD RIGHT NOW? (Stage 2 buyer audit, F2)
 * ===========================================================================
 * `resolveTermsForSale` refuses a sale whose engineer has no agreement, or one
 * in another currency — but it runs when the owner APPROVES a payment, after
 * the customer has already transferred the money. This asks the same question
 * earlier, so a product that would be refused at approval is never offered.
 *
 * Same choice of agreement (`pickAgreement`), same validation (`toAgreement`,
 * then `computeCommissionSnapshot`, which is where the currency rule lives),
 * same price row (the open one). It reports instead of throwing, one entry per
 * engineer, so the owner's checklist can name who is missing terms.
 *
 * A FREE PRODUCT HAS NOTHING TO RESOLVE. At a price of zero no payment is
 * approved and no commission is computed (F1, 0054), so no agreement is
 * required. Raising the price is what brings the requirement in — and that
 * change is guarded by `keepPublishedSellable` below.
 *
 * No price at all is not reported here: `publishBlockers` already refuses it.
 *
 * Read in three set-based queries whatever the number of products, because
 * changing one engineer's default re-checks every product they are credited
 * on — one query per product made that seconds for a large catalogue.
 * ===========================================================================
 */
export type SaleBlockerReason = 'NO_AGREEMENT' | 'CURRENCY_MISMATCH' | 'INVALID_AGREEMENT';

export interface SaleBlocker {
  readonly contributorId: string;
  readonly reason: SaleBlockerReason;
  readonly message: string;
}

export async function productSaleBlockers(
  tx: Transaction,
  productId: string,
): Promise<readonly SaleBlocker[]> {
  return (await saleBlockersByProduct(tx, [productId])).get(productId) ?? [];
}

async function saleBlockersByProduct(
  tx: Transaction,
  productIds: readonly string[],
): Promise<ReadonlyMap<string, readonly SaleBlocker[]>> {
  const result = new Map<string, SaleBlocker[]>();
  if (productIds.length === 0) return result;

  const prices = await tx
    .select({
      productId: productPrices.productId,
      amountMinor: productPrices.amountMinor,
      currency: productPrices.currency,
    })
    .from(productPrices)
    .where(and(inArray(productPrices.productId, [...productIds]), isNull(productPrices.effectiveTo)));

  const paid = new Map(prices.filter((p) => p.amountMinor > 0n).map((p) => [p.productId, p]));
  if (paid.size === 0) return result;
  const paidIds = [...paid.keys()];

  // LEFT join: a name the reader may not see must not hide a missing agreement.
  const credits = await tx
    .select({
      productId: productContributors.productId,
      contributorId: productContributors.contributorId,
      displayName: contributors.displayName,
    })
    .from(productContributors)
    .leftJoin(contributors, eq(contributors.id, productContributors.contributorId))
    .where(inArray(productContributors.productId, paidIds))
    .orderBy(productContributors.productId, productContributors.contributorId);
  if (credits.length === 0) return result;

  const agreements = await tx
    .select()
    .from(commissionAgreements)
    .where(
      and(
        inArray(commissionAgreements.contributorId, [...new Set(credits.map((c) => c.contributorId))]),
        isNull(commissionAgreements.effectiveTo),
        or(isNull(commissionAgreements.productId), inArray(commissionAgreements.productId, paidIds)),
      ),
    );

  for (const credit of credits) {
    const price = paid.get(credit.productId)!;
    const name = credit.displayName ?? credit.contributorId;
    const row = pickAgreement(agreements, credit.contributorId, credit.productId);
    const blocker = agreementBlocker(row, price, name);
    if (blocker) {
      const list = result.get(credit.productId) ?? [];
      list.push({ contributorId: credit.contributorId, ...blocker });
      result.set(credit.productId, list);
    }
  }
  return result;
}

/** Why the sale would refuse this engineer's slice, or null if it would not. */
function agreementBlocker(
  row: AgreementRow | null,
  price: { amountMinor: bigint; currency: string },
  name: string,
): { reason: SaleBlockerReason; message: string } | null {
  if (!row) {
    return { reason: 'NO_AGREEMENT', message: `لا يوجد اتفاق عمولة سارٍ للمهندس ${name}` };
  }

  if (row.currency !== price.currency) {
    return {
      reason: 'CURRENCY_MISMATCH',
      message: `اتفاق عمولة المهندس ${name} بعملة ${row.currency} وسعر المنتج بعملة ${price.currency}`,
    };
  }

  // The engine the sale runs, run on the list price: whatever it would refuse
  // at approval (a malformed or negative term) is refused here.
  try {
    computeCommissionSnapshot({
      listPrice: money(price.amountMinor, price.currency),
      agreement: toAgreement(row),
    });
  } catch (error) {
    if (!(error instanceof RuleViolationError || error instanceof ValidationError)) throw error;
    return { reason: 'INVALID_AGREEMENT', message: `اتفاق عمولة المهندس ${name} غير صالح` };
  }
  return null;
}

/**
 * Run a change that could leave a PUBLISHED product unsellable — its credits,
 * its price, or an engineer's agreement — and refuse it if it would.
 *
 * "Would" means: the change introduces a sale blocker the product did not
 * already have. A product already broken before this rule existed can still be
 * repaired one step at a time (credit one engineer's terms, then the next);
 * what cannot happen is a sellable product being made unsellable, or a broken
 * one broken further.
 *
 * The products are locked first, so a concurrent publish or a second change
 * waits for this one and then re-reads what it wrote. Only the owner reaches
 * this with anything to lock: a row the actor may not update is not returned.
 */
export async function keepPublishedSellable<T>(
  tx: Transaction,
  productIds: readonly string[],
  change: () => Promise<T>,
): Promise<T> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return change();

  const locked = await tx
    .select({ id: products.id, status: products.status })
    .from(products)
    .where(inArray(products.id, ids))
    .orderBy(products.id)
    .for('update');

  const published = locked.filter((p) => p.status === 'PUBLISHED').map((p) => p.id);
  const key = (b: SaleBlocker) => `${b.contributorId}:${b.reason}`;

  const before = await saleBlockersByProduct(tx, published);

  const result = await change();

  const after = await saleBlockersByProduct(tx, published);
  for (const id of published) {
    const had = new Set((before.get(id) ?? []).map(key));
    const introduced = (after.get(id) ?? []).filter((b) => !had.has(key(b)));
    if (introduced.length > 0) {
      throw new RuleViolationError(
        `لا يمكن تطبيق هذا التعديل لأنه يجعل منتجاً منشوراً غير قابل للبيع: ${introduced
          .map((b) => b.message)
          .join('، ')}`,
        { productId: id, blockers: introduced.map((b) => b.message) },
      );
    }
  }

  return result;
}

/**
 * Compute everything that will be frozen onto the order line.
 *
 * Called once, inside the transaction that marks an order PAID. After that
 * the values are immutable — enforced by a database trigger, not by trust.
 */
export async function resolveTermsForSale(
  tx: Transaction,
  productId: string,
  /**
   * The rate in force, read from settings by the caller (owner decision on
   * OPEN-9). REQUIRED, not defaulted: a sale path that forgets tax would
   * silently split the state's portion between the platform and the engineer,
   * and a default of zero would let it compile.
   */
  taxRateBp: number,
  /**
   * What comes off this line's displayed price (owner decision on OPEN-1).
   *
   * REQUIRED for the same reason `taxRateBp` is. A default of zero would let a
   * future sale path drop a discount the customer was granted and book the
   * full price against it — the discount would vanish into the platform's
   * share, and every figure downstream would still re-add correctly, so
   * nothing would notice.
   */
  discountMinor: bigint,
): Promise<ResolvedTerms> {
  // 1. The price in force: the single open row.
  const [priceRow] = await tx
    .select()
    .from(productPrices)
    .where(and(eq(productPrices.productId, productId), isNull(productPrices.effectiveTo)))
    .limit(1);

  if (!priceRow) {
    throw new RuleViolationError('لا يوجد سعر حالي لهذا المنتج', { productId });
  }

  // 2. Who is credited, and with what split.
  const credits = await tx
    .select({
      contributorId: productContributors.contributorId,
      shareBp: productContributors.shareBp,
    })
    .from(productContributors)
    .where(eq(productContributors.productId, productId))
    .orderBy(productContributors.contributorId);

  if (credits.length === 0) {
    throw new RuleViolationError('لا يوجد مهندس منسوب إليه هذا المنتج', { productId });
  }

  // 3. EVERY credited engineer's own agreement, resolved separately
  //    (owner decision on OPEN-15). Read before any arithmetic, so a sale with
  //    one unagreed co-author is refused before a single figure is computed.
  const currency = priceRow.currency;
  const price: Money = money(priceRow.amountMinor, currency);

  /**
   * THE DISCOUNT COMES OFF FIRST, AND IT COMES OFF THE DISPLAYED PRICE
   * (owner decision on OPEN-1).
   *
   * A discount is a customer-facing number: it is quoted against the price on
   * the page, which includes tax. So the order is the order in which the money
   * actually moves —
   *
   *     list price  →  less the discount  →  less the tax  →  split
   *
   * and every step below divides only what is still there after the one above.
   */
  if (discountMinor < 0n) {
    throw new RuleViolationError('الخصم لا يمكن أن يكون سالباً', {
      productId,
      discountMinor: discountMinor.toString(),
    });
  }
  if (discountMinor > priceRow.amountMinor) {
    throw new RuleViolationError('الخصم يتجاوز سعر المنتج', {
      productId,
      discountMinor: discountMinor.toString(),
      priceMinor: priceRow.amountMinor.toString(),
    });
  }
  const payable = subtract(price, money(discountMinor, currency));

  /**
   * TAX COMES OUT BEFORE ANYTHING IS DIVIDED (owner decision on OPEN-9).
   *
   * The displayed price includes the tax, so the pot to split is what remains
   * after the state's portion is taken — not the price. Feeding the gross to
   * the commission engine would hand the engineer a share of money that was
   * never the platform's to give.
   *
   * Extracted from what was PAID, not from the list price. Tax on money the
   * customer never handed over would be remitted to the state out of the
   * platform's own pocket.
   *
   * At rate zero `netMinor === payable`, so this is an exact identity and the
   * split is bit-for-bit what it was before tax existed.
   */
  const tax = extractTax(payable, taxRateBp);

  /**
   * THE SNAPSHOT RECORDS THE DISCOUNT IN THE ENGINE'S OWN TERMS.
   *
   * `listPriceMinor` on a snapshot has always meant the tax-free pot BEFORE a
   * discount, so the discount handed to the engine has to be tax-free too —
   * otherwise `listPrice - discount` would not equal the pot the split is
   * actually computed on, and the snapshot would describe a sale that did not
   * happen.
   *
   * Derived by SUBTRACTION rather than by taxing the discount separately. Two
   * independent roundings of the same rate disagree on odd amounts, and the
   * disagreement would land in the one place it must never land: the identity
   * `engineer + platform + tax = paid`. Taking the difference of two extracted
   * nets makes `netList - discountNet === tax.netMinor` true by construction,
   * for every price, every discount and every rate.
   */
  const netList = extractTax(price, taxRateBp).netMinor;
  const discountNet = netList - tax.netMinor;

  /**
   * Asserted rather than assumed. Extracting tax is monotonic — a smaller
   * gross never leaves a larger net — so this cannot fire today. It is here
   * because the day it does fire, the alternative is a negative discount
   * silently inflating an engineer's share.
   */
  if (discountNet < 0n) {
    throw new MoneyInvariantError('الخصم بعد الضريبة خرج سالباً', {
      productId,
      netListMinor: netList.toString(),
      netPayableMinor: tax.netMinor.toString(),
    });
  }

  /**
   * =========================================================================
   * THE POT IS SLICED FIRST, AND EACH SLICE MEETS ITS OWN AGREEMENT (OPEN-15)
   * =========================================================================
   * Before this decision one rate governed the whole line — the PRIMARY
   * author's — and the engineers' side was divided afterwards by credit. That
   * paid a co-author at a rate they never agreed to, and it made the sale
   * reconstructible: a colleague's pay was the pot less your own, and the pot
   * followed from one rate you knew.
   *
   * Now the order is reversed:
   *
   *     net  ──split by credit──▶  slice per engineer
   *     slice ──their agreement──▶  their pay + the platform's cut of it
   *
   * Two properties fall out, and both are asserted below rather than assumed:
   *
   *   THE MONEY STILL RE-ADDS. `distributeEngineerAmount` divides the net into
   *   slices that sum to it exactly (largest remainder), and each slice is then
   *   divided into two parts that sum to that slice exactly. A sum of exact
   *   sums is exact, so `engineers + platform + tax = paid` survives untouched
   *   — the identity the ledger refuses to post without.
   *
   *   A COLLEAGUE'S PAY STOPS BEING DERIVABLE. It is now a function of THEIR
   *   rate, which §12 keeps private. Knowing the price, your own rate and your
   *   own pay yields your own slice and therefore the others' combined slice —
   *   but not a currency figure any of them received. That is KI-3 closed, and
   *   it is closed by arithmetic rather than by a policy, which is why no
   *   policy could close it before.
   */
  const shares: ContributorShare[] = credits.map((c) => ({
    contributorId: c.contributorId,
    shareBp: c.shareBp,
  }));

  const slices = distributeEngineerAmount(money(tax.netMinor, currency), shares);

  const distribution: Array<ResolvedTerms['distribution'][number]> = [];
  let engineerTotal = 0n;
  let platformTotal = 0n;
  let anyClamped = false;

  for (const slice of slices) {
    // Their own agreement: product-scoped first, then their default, then a
    // refusal. There is still no platform-wide fallback rate — inventing one
    // for a co-author is exactly the silent business rule §11 forbids.
    const agreementRow = await findAgreement(tx, slice.contributorId, productId);

    /*
     * The discount is NOT passed here. It came off the displayed price before
     * tax, so the pot being sliced is already net of it and each slice carries
     * its proportional part. Handing the engine the discount a second time
     * would subtract it once per engineer.
     */
    const snapshot = computeCommissionSnapshot({
      listPrice: money(slice.amountMinor, currency),
      agreement: toAgreement(agreementRow),
    });

    distribution.push({
      contributorId: slice.contributorId,
      shareBp: slice.shareBp,
      sliceMinor: slice.amountMinor,
      amountMinor: snapshot.engineerAmountMinor,
      platformAmountMinor: snapshot.platformAmountMinor,
      agreementId: agreementRow.id,
      model: snapshot.model,
      engineerBp: snapshot.engineerBp,
      engineerFixedMinor: snapshot.engineerFixedMinor,
      platformFixedMinor: snapshot.platformFixedMinor,
      clamped: snapshot.clamped,
    });

    engineerTotal += snapshot.engineerAmountMinor;
    platformTotal += snapshot.platformAmountMinor;
    anyClamped = anyClamped || snapshot.clamped;
  }

  /**
   * The seam between the modules, checked at the seam. Each snapshot
   * guarantees its own two parts re-add to its own slice; this is the separate
   * claim that the slices re-add to what tax left behind — which is what the
   * database CHECK on the order line and the ledger both go on to require.
   */
  if (engineerTotal + platformTotal !== tax.netMinor) {
    throw new MoneyInvariantError('مجموع حصص المهندسين والمنصة لا يساوي الصافي بعد الضريبة', {
      productId,
      engineerTotalMinor: engineerTotal.toString(),
      platformTotalMinor: platformTotal.toString(),
      taxNetMinor: tax.netMinor.toString(),
    });
  }

  /*
   * `discountNet` is computed above and is recorded on the ORDER LINE, not
   * here: with per-engineer terms there is no single snapshot to carry it.
   * Referenced so the derivation above is not mistaken for dead code.
   */
  void discountNet;

  /**
   * A line-level model and rate exist only for a sole author. Writing the
   * primary's onto a co-authored line is what OPEN-15 corrects — it would name
   * a rate that governed only part of the sale, and an auditor reading it
   * would mis-compute every figure beneath it.
   */
  const sole = distribution.length === 1 ? distribution[0]! : null;

  return {
    grossMinor: priceRow.amountMinor,
    discountMinor,
    payableMinor: payable.amountMinor,
    tax,
    priceRowId: priceRow.id,
    line: {
      model: sole ? sole.model : null,
      engineerBp: sole ? sole.engineerBp : null,
      engineerAmountMinor: engineerTotal,
      platformAmountMinor: platformTotal,
      clamped: anyClamped,
    },
    distribution,
  };
}

/** Owner action: set or replace a contributor's or a product's terms (§11). */
export async function setCommissionAgreement(
  tx: Transaction,
  input: {
    contributorId: string;
    productId?: string | null;
    agreement: CommissionAgreement;
    createdBy: string;
    note?: string | null;
  },
): Promise<string> {
  const now = new Date();
  const productId = input.productId ?? null;

  // A default reaches every product the engineer is credited on; an override,
  // only its own. Either may leave a published product unsellable (F2).
  const affected =
    productId !== null
      ? [productId]
      : (
          await tx
            .select({ productId: productContributors.productId })
            .from(productContributors)
            .where(eq(productContributors.contributorId, input.contributorId))
        ).map((r) => r.productId);

  return keepPublishedSellable(tx, affected, () => writeAgreement(tx, input, productId, now));
}

async function writeAgreement(
  tx: Transaction,
  input: Parameters<typeof setCommissionAgreement>[1],
  productId: string | null,
  now: Date,
): Promise<string> {
  // Temporal, exactly like prices: close the open row, open a new one. The
  // terms in force on any past date stay reconstructible.
  await tx
    .update(commissionAgreements)
    .set({ effectiveTo: now })
    .where(
      and(
        eq(commissionAgreements.contributorId, input.contributorId),
        productId === null
          ? isNull(commissionAgreements.productId)
          : eq(commissionAgreements.productId, productId),
        isNull(commissionAgreements.effectiveTo),
      ),
    );

  const [created] = await tx
    .insert(commissionAgreements)
    .values({
      contributorId: input.contributorId,
      productId,
      model: input.agreement.model,
      engineerBp: input.agreement.model === 'PERCENTAGE' ? input.agreement.engineerBp : null,
      engineerFixedMinor:
        input.agreement.model === 'FIXED_ENGINEER' ? input.agreement.engineerFixedMinor : null,
      platformFixedMinor:
        input.agreement.model === 'FIXED_PLATFORM' ? input.agreement.platformFixedMinor : null,
      currency: input.agreement.currency,
      effectiveFrom: now,
      createdBy: input.createdBy,
      note: input.note ?? null,
    })
    .returning({ id: commissionAgreements.id });

  if (!created) {
    throw new RuleViolationError('تعذّر حفظ اتفاق العمولة');
  }
  return created.id;
}

export { sql };
