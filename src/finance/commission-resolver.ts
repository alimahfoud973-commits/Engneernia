import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { commissionAgreements, productContributors, productPrices } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';
import { extractTax, type TaxBreakdown } from '@/lib/money/tax';
import { MoneyInvariantError, RuleViolationError } from '@/lib/errors';
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

/**
 * The agreement in force RIGHT NOW for this product.
 *
 * "In force" means the open row (effective_to IS NULL), which is what the
 * temporal table guarantees exactly one of per scope. A product-scoped row
 * wins over the contributor's default (§11).
 */
async function findAgreement(
  tx: Transaction,
  contributorId: string,
  productId: string,
): Promise<typeof commissionAgreements.$inferSelect> {
  const [override] = await tx
    .select()
    .from(commissionAgreements)
    .where(
      and(
        eq(commissionAgreements.contributorId, contributorId),
        eq(commissionAgreements.productId, productId),
        isNull(commissionAgreements.effectiveTo),
      ),
    )
    .limit(1);

  if (override) return override;

  const [fallback] = await tx
    .select()
    .from(commissionAgreements)
    .where(
      and(
        eq(commissionAgreements.contributorId, contributorId),
        isNull(commissionAgreements.productId),
        isNull(commissionAgreements.effectiveTo),
      ),
    )
    .orderBy(desc(commissionAgreements.effectiveFrom))
    .limit(1);

  if (fallback) return fallback;

  throw new RuleViolationError(
    'لا يوجد اتفاق عمولة سارٍ لهذا المنتج — لا يمكن إتمام البيع',
    { contributorId, productId },
  );
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
