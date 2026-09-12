import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { contributors, settlements } from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { notifyUser } from '@/notifications/notify';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError } from '@/lib/errors';
import { postLedgerTransaction } from '@/ledger/post';
import { LEDGER_ACCOUNTS, LEDGER_KINDS } from '@/ledger/accounts';

/**
 * ===========================================================================
 * THE SETTLEMENT LIFECYCLE (decisions §9: PENDING → APPROVED → PAID)
 * ===========================================================================
 *
 * Three transitions, each the owner's alone, each recorded.
 *
 * The one that moves money is `markSettlementPaid`, and it does two things in
 * ONE transaction: post the payout to the ledger and stamp the settlement. If
 * either fails, neither happened — a settlement marked paid that the books
 * never heard about is not a state this system can reach, and a CHECK
 * constraint refuses the row even if this code were wrong.
 * ===========================================================================
 */

export type SettlementStatus =
  | 'PENDING' | 'APPROVED' | 'PAID' | 'CARRIED_FORWARD' | 'CANCELLED';

/**
 * Who may move a settlement where.
 *
 * CARRIED_FORWARD is terminal by design: a statement that paid nothing because
 * the balance was under the threshold is not "waiting to be approved". The
 * balance itself rolls into the next month's settlement, which is where it
 * gets paid. Approving this one would mean paying a month twice.
 */
const TRANSITIONS: Readonly<Record<SettlementStatus, readonly SettlementStatus[]>> =
  Object.freeze({
    PENDING: ['APPROVED', 'CANCELLED'],
    APPROVED: ['PAID', 'CANCELLED'],
    PAID: [],
    CARRIED_FORWARD: ['CANCELLED'],
    CANCELLED: [],
  });

export function canMoveSettlement(from: SettlementStatus, to: SettlementStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

function requireOwner(actor: Actor, what: string): void {
  if (!isOwner(actor)) {
    throw new RuleViolationError(`${what} من صلاحية مالك المنصة وحده`);
  }
}

async function loadSettlement(
  tx: Transaction,
  settlementId: string,
): Promise<typeof settlements.$inferSelect> {
  const [row] = await tx
    .select()
    .from(settlements)
    .where(eq(settlements.id, settlementId))
    .limit(1);
  if (!row) throw new NotFoundError('كشف التسوية غير موجود');
  return row;
}

function assertTransition(
  settlement: typeof settlements.$inferSelect,
  to: SettlementStatus,
): void {
  const from = settlement.status as SettlementStatus;
  if (!canMoveSettlement(from, to)) {
    throw new RuleViolationError('انتقال غير مسموح في دورة حياة التسوية', {
      reference: settlement.reference,
      from,
      to,
      allowed: [...TRANSITIONS[from]],
    });
  }
}

/** The owner has reviewed the statement and stands behind the amount (§15). */
export async function approveSettlement(
  actor: Actor,
  input: { settlementId: string; note?: string | null },
): Promise<{ reference: string; netDueMinor: bigint; currency: string }> {
  requireOwner(actor, 'اعتماد التسوية');

  return withActor(actor, async (tx) => {
    const settlement = await loadSettlement(tx, input.settlementId);
    assertTransition(settlement, 'APPROVED');

    if (settlement.netDueMinor <= 0n) {
      // Unreachable through the generator, which marks these CARRIED_FORWARD.
      // Kept because the constraint that forbids paying zero fires later, with
      // a far less helpful message.
      throw new RuleViolationError('لا يُعتمد كشف لا يستحق صرفاً', {
        reference: settlement.reference,
      });
    }

    const now = new Date();
    const updated = await tx
      .update(settlements)
      .set({
        status: 'APPROVED',
        approvedAt: now,
        approvedBy: actor.kind === 'USER' ? actor.userId : null,
        note: input.note ?? settlement.note,
        updatedAt: now,
      })
      .where(and(eq(settlements.id, settlement.id), eq(settlements.status, 'PENDING')))
      .returning({ id: settlements.id });

    if (updated.length === 0) {
      throw new RuleViolationError('لم يُطبَّق اعتماد التسوية', {
        reference: settlement.reference,
      });
    }

    await notifyContributorUser(tx, settlement.contributorId, 'SETTLEMENT_APPROVED', {
      reference: settlement.reference,
      periodKey: settlement.periodKey,
    });

    await recordAudit(tx, actor, {
      action: 'SETTLEMENT_APPROVED',
      entityType: 'settlement',
      entityId: settlement.id,
      after: {
        reference: settlement.reference,
        contributorId: settlement.contributorId,
        periodKey: settlement.periodKey,
        netDueMinor: settlement.netDueMinor.toString(),
        currency: settlement.currency,
      },
    });

    return {
      reference: settlement.reference,
      netDueMinor: settlement.netDueMinor,
      currency: settlement.currency,
    };
  });
}

/**
 * THE MONEY LEAVES (specification §15).
 *
 *   DR  ENGINEER_PAYABLE   the debt is discharged
 *   CR  PLATFORM_CASH      and the cash has gone
 *
 * Posted with `occurredAt = now`, deliberately: the payment happened when it
 * happened, in the month it happened, not retroactively inside the month being
 * settled. Backdating it would reopen a closed month in the books — which is
 * exactly what §48 forbids — and would make the generator's "already paid"
 * figure depend on the cutoff it is supposed to be independent of.
 */
export async function markSettlementPaid(
  actor: Actor,
  input: {
    settlementId: string;
    payoutMethod?: string | null;
    payoutReference?: string | null;
    note?: string | null;
  },
): Promise<{ reference: string; ledgerTransactionId: string; amountMinor: bigint }> {
  requireOwner(actor, 'تسجيل صرف التسوية');

  return withActor(actor, async (tx) => {
    const settlement = await loadSettlement(tx, input.settlementId);
    assertTransition(settlement, 'PAID');

    if (settlement.netDueMinor <= 0n) {
      throw new RuleViolationError('لا يُصرف كشف بمبلغ صفر أو سالب', {
        reference: settlement.reference,
      });
    }

    const now = new Date();

    const ledgerTransactionId = await postLedgerTransaction(tx, {
      kind: LEDGER_KINDS.SETTLEMENT_PAYOUT,
      currency: settlement.currency,
      occurredAt: now,
      referenceType: 'settlement',
      referenceId: settlement.id,
      memo: `تسوية ${settlement.reference} — فترة ${settlement.periodKey}`,
      lines: [
        {
          account: LEDGER_ACCOUNTS.ENGINEER_PAYABLE,
          contributorId: settlement.contributorId,
          amountMinor: settlement.netDueMinor,
          memo: `صرف ${settlement.reference}`,
        },
        {
          account: LEDGER_ACCOUNTS.PLATFORM_CASH,
          amountMinor: -settlement.netDueMinor,
          memo: `صرف ${settlement.reference}`,
        },
      ],
    });

    const updated = await tx
      .update(settlements)
      .set({
        status: 'PAID',
        paidAt: now,
        paidBy: actor.kind === 'USER' ? actor.userId : null,
        payoutMethod: input.payoutMethod ?? null,
        payoutReference: input.payoutReference ?? null,
        ledgerTransactionId,
        note: input.note ?? settlement.note,
        updatedAt: now,
      })
      .where(and(eq(settlements.id, settlement.id), eq(settlements.status, 'APPROVED')))
      .returning({ id: settlements.id });

    if (updated.length === 0) {
      throw new RuleViolationError('لم يُطبَّق تسجيل الصرف', {
        reference: settlement.reference,
      });
    }

    await notifyContributorUser(tx, settlement.contributorId, 'SETTLEMENT_PAID', {
      reference: settlement.reference,
      periodKey: settlement.periodKey,
    });

    await recordAudit(tx, actor, {
      action: 'SETTLEMENT_PAID',
      entityType: 'settlement',
      entityId: settlement.id,
      after: {
        reference: settlement.reference,
        contributorId: settlement.contributorId,
        amountMinor: settlement.netDueMinor.toString(),
        currency: settlement.currency,
        payoutMethod: input.payoutMethod ?? null,
        payoutReference: input.payoutReference ?? null,
        ledgerTransactionId,
      },
    });

    return {
      reference: settlement.reference,
      ledgerTransactionId,
      amountMinor: settlement.netDueMinor,
    };
  });
}

/**
 * Withdraw a statement issued in error.
 *
 * The row stays — §15 forbids deleting settlement history — and no money has
 * moved, so there is nothing to reverse in the ledger. The balance it
 * described is still in the ledger and will appear in the next generation.
 */
export async function cancelSettlement(
  actor: Actor,
  input: { settlementId: string; reason: string },
): Promise<void> {
  requireOwner(actor, 'إلغاء التسوية');

  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new RuleViolationError('اذكر سبب إلغاء الكشف');
  }

  await withActor(actor, async (tx) => {
    const settlement = await loadSettlement(tx, input.settlementId);
    assertTransition(settlement, 'CANCELLED');

    const updated = await tx
      .update(settlements)
      .set({ status: 'CANCELLED', note: reason, updatedAt: new Date() })
      .where(eq(settlements.id, settlement.id))
      .returning({ id: settlements.id });

    if (updated.length === 0) {
      throw new RuleViolationError('لم يُطبَّق إلغاء الكشف');
    }

    await recordAudit(tx, actor, {
      action: 'SETTLEMENT_GENERATED',
      entityType: 'settlement',
      entityId: settlement.id,
      before: { status: settlement.status },
      after: { status: 'CANCELLED', reason, reference: settlement.reference },
    });
  });
}

async function notifyContributorUser(
  tx: Transaction,
  contributorId: string,
  type: 'SETTLEMENT_APPROVED' | 'SETTLEMENT_PAID',
  payload: Record<string, unknown>,
): Promise<void> {
  const [row] = await tx
    .select({ userId: contributors.userId })
    .from(contributors)
    .where(eq(contributors.id, contributorId))
    .limit(1);

  if (!row?.userId) return;
  await notifyUser(tx, { userId: row.userId, type, payload });
}

/** Owner-only count of what is waiting, for the console badge. */
export async function settlementRunSummary(
  actor: Actor,
  periodKey: string,
): Promise<{ pending: number; approved: number; paid: number; carriedForward: number }> {
  requireOwner(actor, 'ملخص التسوية');

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT status::text AS status, COUNT(*)::int AS count
        FROM settlements WHERE period_key = ${periodKey}
       GROUP BY status
    `)) as unknown as Array<{ status: string; count: number }>;

    const of = (status: string) =>
      Number(rows.find((row) => row.status === status)?.count ?? 0);

    return {
      pending: of('PENDING'),
      approved: of('APPROVED'),
      paid: of('PAID'),
      carriedForward: of('CARRIED_FORWARD'),
    };
  });
}
