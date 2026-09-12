import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { commissionAgreements, productContributors, productPrices } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';
import { RuleViolationError } from '@/lib/errors';
import { money, type Money } from '@/lib/money/money';
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
  const price: Money = money(priceRow.amountMinor, priceRow.currency);

  const snapshot = computeCommissionSnapshot({
    listPrice: price,
    agreement: toAgreement(agreementRow),
  });

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
