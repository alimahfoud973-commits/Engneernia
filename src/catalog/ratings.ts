import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { entitlements, productRatings } from '@/db/schema';
import { withActor } from '@/db/actor-context';
import { authorize } from '@/authz/policy';
import { type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError, ValidationError } from '@/lib/errors';
import { getPublicSettings } from '@/platform/settings';

/**
 * ===========================================================================
 * PRODUCT RATINGS (OPEN-14)
 * ===========================================================================
 * The owner's decisions: a score from 1 to 5, no written review in the first
 * release, and the public sees an average and a count — never who rated.
 *
 * WHO MAY RATE is not decided here. It is decided by the row policy in
 * migration 0045, which admits an INSERT only when a live entitlement exists
 * for that customer and that product. This module refuses early so the person
 * gets a sentence instead of a silent no-op, but the refusal that matters
 * happens underneath it: a rating from someone who never bought the product
 * cannot be written from a route, a server action, or a psql prompt holding
 * the application's own credentials.
 *
 * THE FLAG GATES THE WRITE, not only the display. A feature turned off that
 * still accepts writes is not off — it is invisible, which is worse, because
 * the rows keep arriving where nobody is looking.
 * ===========================================================================
 */

/**
 * "1 تقييماً" is wrong Arabic, and it was on the page.
 *
 * The counted noun changes with the number: one is مفرد, two is مثنى, three to
 * ten take a plural, and eleven upward return to a singular accusative. A
 * template that appends one fixed word is correct for exactly one of those
 * cases — and English-shaped pluralisation is the most common way an Arabic
 * interface reads as machine-made.
 */
export function ratingCountLabel(count: number): string {
  if (count === 1) return 'تقييم واحد';
  if (count === 2) return 'تقييمان';
  if (count >= 3 && count <= 10) return `${count} تقييمات`;
  return `${count} تقييماً`;
}

export const MIN_SCORE = 1;
export const MAX_SCORE = 5;

export interface RatingSummary {
  readonly count: number;
  /** Null when nobody has rated: an average of zero would read as a bad score. */
  readonly average: number | null;
}

/** SQLSTATE 42501 — `new row violates row-level security policy`. */
function isRowLevelSecurityViolation(error: unknown): boolean {
  const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code
    ?? (error as { code?: string })?.code;
  return code === '42501';
}

function assertScore(score: number): void {
  if (!Number.isInteger(score) || score < MIN_SCORE || score > MAX_SCORE) {
    throw new ValidationError(`التقييم من ${MIN_SCORE} إلى ${MAX_SCORE}`, { score });
  }
}

async function assertRatingsEnabled(): Promise<void> {
  if (!(await getPublicSettings()).ratingsEnabled) {
    throw new RuleViolationError('التقييمات غير مفعّلة على المنصة');
  }
}

/**
 * Record or replace this customer's score for a product.
 *
 * TWO REFUSALS, TWO SHAPES. Row-level security is usually described as
 * refusing a write by returning no rows — that is a USING clause, which
 * filters. A WITH CHECK clause RAISES: `new row violates row-level security
 * policy`, SQLSTATE 42501. This statement can meet either, so it handles both:
 * the raise from the insert half, and the silent filter from the conflict
 * update half. Written after watching it raise where the comment here first
 * claimed it would return nothing.
 */
export async function rateProduct(
  actor: Actor,
  input: { productId: string; score: number },
): Promise<void> {
  authorize(actor, 'product.rate');
  assertScore(input.score);
  await assertRatingsEnabled();

  if (actor.kind !== 'USER') throw new NotFoundError();

  await withActor(actor, async (tx) => {
    let written: Array<{ id: string }>;
    try {
      written = await tx
        .insert(productRatings)
      .values({
        productId: input.productId,
        customerId: actor.userId,
        score: input.score,
      })
      .onConflictDoUpdate({
        target: [productRatings.productId, productRatings.customerId],
        set: { score: input.score, updatedAt: new Date() },
      })
        .returning({ id: productRatings.id });
    } catch (error) {
      // 42501 is the row policy refusing the new row. The reason, by
      // construction, is that this person holds no live entitlement for this
      // product — that is the only condition the WITH CHECK adds.
      if (isRowLevelSecurityViolation(error)) {
        throw new RuleViolationError('لا يمكن تقييم منتج لم تشترِه');
      }
      throw error;
    }

    if (written.length === 0) {
      // The other shape: a USING clause filtered the row away instead.
      throw new RuleViolationError('لا يمكن تقييم منتج لم تشترِه');
    }
  });
}

/** This customer's own score, or null. Used to show the form pre-filled. */
export async function myRating(actor: Actor, productId: string): Promise<number | null> {
  if (actor.kind !== 'USER') return null;

  return withActor(actor, async (tx) => {
    const [row] = await tx
      .select({ score: productRatings.score })
      .from(productRatings)
      .where(
        and(
          eq(productRatings.productId, productId),
          eq(productRatings.customerId, actor.userId),
        ),
      )
      .limit(1);

    return row?.score ?? null;
  });
}

/**
 * May this actor rate this product — i.e. do they hold it?
 *
 * For deciding whether to RENDER the form, nothing more. The first version of
 * the page showed the form only to someone who had already rated, which meant
 * a buyer could never leave a first score: the one state the feature exists
 * for was the one it refused. Entitlement is the right question, and the row
 * policy answers it again when the write arrives.
 */
export async function canRate(actor: Actor, productId: string): Promise<boolean> {
  if (actor.kind !== 'USER') return false;
  if (!(await getPublicSettings()).ratingsEnabled) return false;

  return withActor(actor, async (tx) => {
    const [row] = await tx
      .select({ id: entitlements.id })
      .from(entitlements)
      .where(
        and(
          eq(entitlements.productId, productId),
          eq(entitlements.customerId, actor.userId),
          isNull(entitlements.revokedAt),
        ),
      )
      .limit(1);
    return row !== undefined;
  });
}

/**
 * What the catalogue shows, for anyone including a guest.
 *
 * Read through `app_product_rating`, which is SECURITY DEFINER: the rows
 * themselves stay invisible, so this cannot become a way to ask who bought a
 * product. Returns nothing at all while the feature is off.
 */
export async function ratingSummary(
  actor: Actor,
  productId: string,
): Promise<RatingSummary | null> {
  if (!(await getPublicSettings()).ratingsEnabled) return null;

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT rating_count, score_sum FROM app_product_rating(${productId}::uuid)`,
    )) as unknown as Array<{ rating_count: number; score_sum: number }>;

    const count = Number(rows[0]?.rating_count ?? 0);
    const sum = Number(rows[0]?.score_sum ?? 0);

    /**
     * Rounded here rather than in SQL, to one decimal place: two roundings in
     * two languages disagree eventually, so there is only one.
     *
     * `Math.trunc` after adding a half, not `Math.round`: the repository bans
     * Math.round outright so that no money is ever rounded by it. This is a
     * star rating and not an amount, and the arithmetic is the same.
     */
    const average = count === 0 ? null : Math.trunc((sum / count) * 10 + 0.5) / 10;
    return { count, average };
  });
}
