import 'server-only';
import { inArray } from 'drizzle-orm';
import { settings } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';

/**
 * ===========================================================================
 * FINANCIAL POLICY, READ FROM THE DATABASE (decisions §7, §8)
 * ===========================================================================
 * There is no refund window in this file, and no minimum payout. There is a
 * function that asks the database what they are.
 *
 * The owner asked for exactly this twice, in their own words:
 *
 *   "لا تضع مدة ثابتة مثل 7 أو 14 يومًا في الكود في هذه المرحلة"
 *   "لا تجعل الحد الأدنى رقمًا ثابتًا داخل الكود"
 *
 * The fallbacks below are NOT policy. They are what the code does when the
 * settings table has not been seeded — and each is chosen to be the least
 * opinionated behaviour available: no window (every request reaches the
 * owner), no download block, and a zero threshold (nothing is withheld).
 * A seeded database never uses them.
 * ===========================================================================
 */

export interface RefundPolicy {
  /** Null means no automatic time limit; the owner decides every request. */
  readonly requestWindowDays: number | null;
  readonly blockAfterDownload: boolean;
}

export interface SettlementPolicy {
  readonly minimumPayoutMinor: bigint;
  readonly currency: string;
}

const KEYS = [
  'refunds.requestWindowDays',
  'refunds.blockAfterDownload',
  'settlement.minimumPayoutMinor',
  'settlement.currency',
] as const;

interface PolicyBundle {
  readonly refunds: RefundPolicy;
  readonly settlement: SettlementPolicy;
}

export async function readFinancialPolicy(tx: Transaction): Promise<PolicyBundle> {
  const rows = await tx
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...KEYS]));

  const map = new Map(rows.map((row) => [row.key, row.value]));

  const windowValue = map.get('refunds.requestWindowDays');
  const requestWindowDays =
    typeof windowValue === 'number' && Number.isFinite(windowValue) && windowValue > 0
      ? Math.floor(windowValue)
      : null;

  const minimumValue = map.get('settlement.minimumPayoutMinor');
  const minimumPayoutMinor =
    typeof minimumValue === 'number' && Number.isSafeInteger(minimumValue) && minimumValue >= 0
      ? BigInt(minimumValue)
      : 0n;

  const currencyValue = map.get('settlement.currency');

  return {
    refunds: {
      requestWindowDays,
      blockAfterDownload: map.get('refunds.blockAfterDownload') === true,
    },
    settlement: {
      minimumPayoutMinor,
      currency: typeof currencyValue === 'string' ? currencyValue : 'USD',
    },
  };
}

/**
 * Is a refund request still in time?
 *
 * Pure, so the rule can be tested without a database, and separate from the
 * policy read, so the same rule answers both "may I ask?" in the customer's
 * interface and "was this in time?" when the owner reviews.
 */
export function isWithinRefundWindow(
  policy: RefundPolicy,
  paidAt: Date,
  now: Date = new Date(),
): boolean {
  if (policy.requestWindowDays === null) return true;
  const deadline = paidAt.getTime() + policy.requestWindowDays * 24 * 60 * 60 * 1000;
  return now.getTime() <= deadline;
}
