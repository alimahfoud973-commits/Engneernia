import 'server-only';
import { inArray } from 'drizzle-orm';
import { settings } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';

/**
 * ===========================================================================
 * FINANCIAL POLICY, READ FROM THE DATABASE (decisions §8)
 * ===========================================================================
 * There is no minimum payout in this file. There is a function that asks the
 * database what it is.
 *
 * The owner's instruction was explicit: "لا تجعل الحد الأدنى رقمًا ثابتًا
 * داخل الكود". They have since set it to zero — no minimum at all — and the
 * mechanism stays precisely because that instruction stands: putting a
 * threshold back is a row, not a deploy.
 *
 * THE REFUND POLICY THAT USED TO LIVE HERE IS GONE. The platform issues no
 * refunds for any reason, so there is no window to configure and no rule to
 * read. Its settings rows were deleted in migration 0035.
 *
 * The fallback below is NOT policy. It is what the code does when the settings
 * table has not been seeded, and it is the least opinionated value available:
 * a zero threshold withholds nothing. A seeded database never uses it.
 * ===========================================================================
 */

export interface SettlementPolicy {
  readonly minimumPayoutMinor: bigint;
  readonly currency: string;
}

const KEYS = ['settlement.minimumPayoutMinor', 'settlement.currency'] as const;

export async function readFinancialPolicy(
  tx: Transaction,
): Promise<{ readonly settlement: SettlementPolicy }> {
  const rows = await tx
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...KEYS]));

  const map = new Map(rows.map((row) => [row.key, row.value]));

  const minimumValue = map.get('settlement.minimumPayoutMinor');
  const minimumPayoutMinor =
    typeof minimumValue === 'number' && Number.isSafeInteger(minimumValue) && minimumValue >= 0
      ? BigInt(minimumValue)
      : 0n;

  const currencyValue = map.get('settlement.currency');

  return {
    settlement: {
      minimumPayoutMinor,
      currency: typeof currencyValue === 'string' ? currencyValue : 'USD',
    },
  };
}
