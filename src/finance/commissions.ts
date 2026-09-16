import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { commissionAgreements, contributors, productContributors, products } from '@/db/schema';
import { withActor } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { isOwner, type Actor } from '@/authz/actor';
import { RuleViolationError, ValidationError } from '@/lib/errors';
import { setCommissionAgreement } from './commission-resolver';
import type { CommissionAgreement, CommissionModel } from '@/lib/money/commission';

/**
 * ===========================================================================
 * THE OWNER'S COMMISSION SCREEN (§11 — owner decision on OPEN-15)
 * ===========================================================================
 * A rate belongs to ONE engineer. Since OPEN-15 that is not a filing detail:
 * it is what the sale path actually applies, each engineer's own terms to
 * their own slice. So the owner needs a way to set them one at a time, and
 * this is it.
 *
 * TWO SCOPES, and the narrower wins at sale time:
 *   - the engineer's DEFAULT, used wherever nothing more specific exists;
 *   - an override for ONE product, for the cases a default cannot express.
 *
 * NOTHING IS EDITED IN PLACE. `setCommissionAgreement` closes the open row and
 * opens a new one, exactly as prices work, so the terms in force on any past
 * date stay reconstructible — and a sale already made keeps the frozen rate it
 * was booked at regardless (§13, and a database trigger, not this file).
 * ===========================================================================
 */

export interface CommissionRow {
  readonly contributorId: string;
  readonly displayName: string;
  readonly publicSlug: string;
  readonly isActive: boolean;
  /** The default in force, or null when this engineer has no terms at all. */
  readonly model: CommissionModel | null;
  readonly engineerBp: number | null;
  readonly engineerFixedMinor: bigint | null;
  readonly platformFixedMinor: bigint | null;
  readonly currency: string | null;
  readonly effectiveFrom: Date | null;
  /** How many products carry an override for this engineer. */
  readonly overrideCount: number;
}

export interface OverrideRow {
  readonly agreementId: string;
  readonly contributorId: string;
  readonly contributorName: string;
  readonly productId: string;
  readonly productTitle: string;
  readonly model: CommissionModel;
  readonly engineerBp: number | null;
  readonly currency: string;
}

/**
 * Every engineer and the terms in force for them.
 *
 * Owner-only at the door as well as underneath: the policy on
 * `commission_agreements` would hand a contributor only their own row, so
 * without this guard the screen would silently render a one-row table instead
 * of refusing. A screen that half-works is harder to notice than one that does
 * not open.
 */
export interface CreditedProduct {
  readonly contributorId: string;
  readonly productId: string;
  readonly titleAr: string;
}

export async function commissionOverview(actor: Actor): Promise<{
  engineers: readonly CommissionRow[];
  overrides: readonly OverrideRow[];
  /**
   * The products each engineer is credited on — NOT the catalogue.
   *
   * An override for a product an engineer has no credit on is terms that can
   * never apply, and a select listing every product on the platform is one an
   * owner cannot use once the catalogue passes a page. Scoped per engineer so
   * the form can offer only what would actually take effect.
   */
  creditedProducts: readonly CreditedProduct[];
}> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('شاشة العمولات من صلاحية مالك المنصة وحده');
  }

  return withActor(actor, async (tx) => {
    const engineers = await tx
      .select({
        contributorId: contributors.id,
        displayName: contributors.displayName,
        publicSlug: contributors.publicSlug,
        isActive: contributors.isActive,
        model: commissionAgreements.model,
        engineerBp: commissionAgreements.engineerBp,
        engineerFixedMinor: commissionAgreements.engineerFixedMinor,
        platformFixedMinor: commissionAgreements.platformFixedMinor,
        currency: commissionAgreements.currency,
        effectiveFrom: commissionAgreements.effectiveFrom,
      })
      .from(contributors)
      .leftJoin(
        commissionAgreements,
        and(
          eq(commissionAgreements.contributorId, contributors.id),
          isNull(commissionAgreements.productId),
          isNull(commissionAgreements.effectiveTo),
        ),
      )
      .orderBy(desc(contributors.isActive), contributors.displayName)
      .limit(500);

    const overrideRows = await tx
      .select({
        agreementId: commissionAgreements.id,
        contributorId: commissionAgreements.contributorId,
        contributorName: contributors.displayName,
        productId: commissionAgreements.productId,
        productTitle: products.titleAr,
        model: commissionAgreements.model,
        engineerBp: commissionAgreements.engineerBp,
        currency: commissionAgreements.currency,
      })
      .from(commissionAgreements)
      .innerJoin(contributors, eq(contributors.id, commissionAgreements.contributorId))
      .leftJoin(products, eq(products.id, commissionAgreements.productId))
      .where(and(
        sql`${commissionAgreements.productId} IS NOT NULL`,
        isNull(commissionAgreements.effectiveTo),
      ))
      .orderBy(contributors.displayName)
      .limit(500);

    const creditedProducts = await tx
      .select({
        contributorId: productContributors.contributorId,
        productId: productContributors.productId,
        titleAr: products.titleAr,
      })
      .from(productContributors)
      .innerJoin(products, eq(products.id, productContributors.productId))
      .orderBy(products.titleAr)
      .limit(2000);

    const counts = new Map<string, number>();
    for (const row of overrideRows) {
      counts.set(row.contributorId, (counts.get(row.contributorId) ?? 0) + 1);
    }

    return {
      engineers: engineers.map((row) => ({
        ...row,
        overrideCount: counts.get(row.contributorId) ?? 0,
      })),
      creditedProducts,
      overrides: overrideRows.map((row) => ({
        agreementId: row.agreementId,
        contributorId: row.contributorId,
        contributorName: row.contributorName,
        productId: row.productId!,
        productTitle: row.productTitle ?? '—',
        model: row.model,
        engineerBp: row.engineerBp,
        currency: row.currency,
      })),
    };
  });
}

/**
 * A percentage, as a person types it, into basis points.
 *
 * NO FLOATS, and `Math.round` is banned repo-wide for exactly this reason.
 * "80" is 8000 and "7.25" is 725, parsed from the digits themselves rather
 * than through a binary fraction that cannot hold 0.1 and would make a rate
 * that does not round-trip.
 */
export function parsePercentToBp(input: string): number {
  const trimmed = input.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) {
    throw new ValidationError('النسبة تُكتب رقماً بين 0 و 100، بخانتين عشريتين على الأكثر', {
      input,
    });
  }
  const [whole, fraction = ''] = trimmed.split('.');
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (bp < 0 || bp > 10_000) {
    throw new ValidationError('النسبة يجب أن تكون بين 0 و 100', { input });
  }
  return bp;
}

export interface SaveCommissionInput {
  readonly contributorId: string;
  /** Null for this engineer's default; a product id for an override. */
  readonly productId: string | null;
  readonly agreement: CommissionAgreement;
  readonly note?: string | null;
}

/**
 * Set or replace ONE engineer's terms. Owner-only, audited in the same
 * transaction that writes it (rule 12).
 */
export async function saveCommissionAgreement(
  actor: Actor,
  input: SaveCommissionInput,
): Promise<{ agreementId: string }> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('تحديد نسبة العمولة من صلاحية مالك المنصة وحده');
  }
  if (actor.kind !== 'USER') {
    throw new RuleViolationError('تحديد نسبة العمولة من صلاحية مالك المنصة وحده');
  }

  return withActor(actor, async (tx) => {
    // The engineer must exist. Otherwise a mistyped id writes terms for
    // nobody, which then look like terms that are simply never used.
    const [engineer] = await tx
      .select({ id: contributors.id, name: contributors.displayName })
      .from(contributors)
      .where(eq(contributors.id, input.contributorId))
      .limit(1);

    if (!engineer) {
      throw new RuleViolationError('لا يوجد مهندس بهذا المعرّف');
    }

    const previous = await tx
      .select({
        model: commissionAgreements.model,
        engineerBp: commissionAgreements.engineerBp,
        engineerFixedMinor: commissionAgreements.engineerFixedMinor,
        platformFixedMinor: commissionAgreements.platformFixedMinor,
        currency: commissionAgreements.currency,
      })
      .from(commissionAgreements)
      .where(and(
        eq(commissionAgreements.contributorId, input.contributorId),
        input.productId === null
          ? isNull(commissionAgreements.productId)
          : eq(commissionAgreements.productId, input.productId),
        isNull(commissionAgreements.effectiveTo),
      ))
      .limit(1);

    const agreementId = await setCommissionAgreement(tx, {
      contributorId: input.contributorId,
      productId: input.productId,
      agreement: input.agreement,
      createdBy: actor.userId,
      note: input.note ?? null,
    });

    await recordAudit(tx, actor, {
      action: 'COMMISSION_CHANGED',
      entityType: 'commission_agreement',
      entityId: agreementId,
      before: previous[0]
        ? {
            model: previous[0].model,
            engineerBp: previous[0].engineerBp,
            engineerFixedMinor: previous[0].engineerFixedMinor?.toString() ?? null,
            platformFixedMinor: previous[0].platformFixedMinor?.toString() ?? null,
            currency: previous[0].currency,
          }
        : null,
      after: {
        contributorId: input.contributorId,
        contributorName: engineer.name,
        productId: input.productId,
        model: input.agreement.model,
        engineerBp: input.agreement.model === 'PERCENTAGE' ? input.agreement.engineerBp : null,
        engineerFixedMinor:
          input.agreement.model === 'FIXED_ENGINEER'
            ? input.agreement.engineerFixedMinor.toString()
            : null,
        platformFixedMinor:
          input.agreement.model === 'FIXED_PLATFORM'
            ? input.agreement.platformFixedMinor.toString()
            : null,
        currency: input.agreement.currency,
        note: input.note ?? null,
      },
    });

    return { agreementId };
  });
}
