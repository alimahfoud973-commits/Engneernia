import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { commissionAgreements, productContributors, productPrices } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';
import { extractTax, type TaxBreakdown } from '@/lib/money/tax';
import { MoneyInvariantError, RuleViolationError } from '@/lib/errors';
import { money, subtract, type Money } from '@/lib/money/money';
import {
  computeCommissionSnapshot, type CommissionAgreement, type CommissionSnapshot,
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
  readonly snapshot: CommissionSnapshot;
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
  readonly agreementId: string;
  readonly priceRowId: string;
  /** How the engineer's side divides between credited contributors. */
  readonly distribution: ReadonlyArray<{
    readonly contributorId: string;
    readonly shareBp: number;
    readonly amountMinor: bigint;
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

  // 3. Whose agreement governs the split. On a co-authored product the terms
  //    are the PRIMARY contributor's — the one holding the largest share —
  //    because §11 defines an agreement per contributor, not per product.
  //    OPEN-15 records that a genuinely per-co-author rate is undecided.
  const primary = [...credits].sort(
    (a, b) => b.shareBp - a.shareBp || a.contributorId.localeCompare(b.contributorId),
  )[0]!;

  const agreementRow = await findAgreement(tx, primary.contributorId, productId);
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

  const snapshot = computeCommissionSnapshot({
    listPrice: money(netList, currency),
    discount: money(discountNet, currency),
    agreement: toAgreement(agreementRow),
  });

  /**
   * The seam between the two modules, checked at the seam. `computeCommission
   * Snapshot` guarantees its own split re-adds to its own net; this is the
   * separate claim that its net is the amount tax left behind.
   */
  if (snapshot.netPriceMinor !== tax.netMinor) {
    throw new MoneyInvariantError('صافي العمولة لا يطابق الصافي بعد الضريبة', {
      productId,
      snapshotNetMinor: snapshot.netPriceMinor.toString(),
      taxNetMinor: tax.netMinor.toString(),
    });
  }

  // 4. Divide the engineer's side, losing nothing to rounding.
  const shares: ContributorShare[] = credits.map((c) => ({
    contributorId: c.contributorId,
    shareBp: c.shareBp,
  }));

  const distribution = distributeEngineerAmount(
    money(snapshot.engineerAmountMinor, snapshot.currency),
    shares,
  );

  return {
    snapshot,
    grossMinor: priceRow.amountMinor,
    discountMinor,
    payableMinor: payable.amountMinor,
    tax,
    agreementId: agreementRow.id,
    priceRowId: priceRow.id,
    distribution: distribution.map((d) => ({
      contributorId: d.contributorId,
      shareBp: d.shareBp,
      amountMinor: d.amountMinor,
    })),
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
