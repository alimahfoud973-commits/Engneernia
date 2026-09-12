import 'server-only';
import { desc, eq, sql } from 'drizzle-orm';
import { contributors, financialAdjustments } from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { notifyContributor } from '@/notifications/notify';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError, ValidationError } from '@/lib/errors';
import { postLedgerTransaction } from '@/ledger/post';
import { LEDGER_ACCOUNTS, LEDGER_KINDS } from '@/ledger/accounts';
import { assertCurrency } from '@/lib/money/currency';
import { periodKeyOf } from '@/lib/time/period';
import { requireDate } from '@/db';

/**
 * ===========================================================================
 * FINANCIAL ADJUSTMENTS (owner decision on OPEN-21)
 * ===========================================================================
 *
 * The owner's brief, and how each line of it lands in this file:
 *
 *   "لا تستخدمها لتعديل أو حذف عمليات البيع الأصلية"
 *       Nothing here writes to an order, an order line or a settlement. An
 *       adjustment is a NEW ledger entry beside the original, which is exactly
 *       what the ledger's append-only design already requires.
 *
 *   "يجب عرض ملخص واضح ... وطلب تأكيد صريح"
 *       `previewAdjustment` computes the whole effect and writes nothing.
 *       `postAdjustment` is a separate call the owner reaches only by
 *       confirming. The preview is advisory; the post revalidates everything
 *       itself, because a summary the user saw is not a permission.
 *
 *   "يجب منع التعديل الذي يؤدي إلى حالة مالية غير صحيحة"
 *       Enumerated in `validate` below — with one deliberate NON-rule: a
 *       decrease that takes an engineer's balance negative is ALLOWED, and
 *       warned about. A negative balance is a real state this platform already
 *       handles (it carries into next month's settlement), and refusing to
 *       record a correction because its result is uncomfortable would mean the
 *       books stop matching reality.
 *
 *   "Financial Ledger قابل للتدقيق، وليس مجرد تعديل أرقام داخل قاعدة البيانات"
 *       Every adjustment writes three things in ONE transaction: the ledger
 *       entry, this record, and the audit log. None can exist without the
 *       others.
 * ===========================================================================
 */

export type AdjustmentTarget = 'ENGINEER' | 'PLATFORM';
export type AdjustmentDirection = 'INCREASE' | 'DECREASE';
export type AdjustmentReason =
  | 'DATA_ENTRY_ERROR'
  | 'DUPLICATE_PAYMENT_RECEIVED'
  | 'BANK_FEE_OR_SHORTFALL'
  | 'AGREED_COMPENSATION'
  | 'SETTLEMENT_CORRECTION'
  | 'OTHER';

export interface AdjustmentInput {
  readonly target: AdjustmentTarget;
  readonly direction: AdjustmentDirection;
  /** Positive minor units. The direction is separate, never the sign. */
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly contributorId?: string | null;
  readonly reason: AdjustmentReason;
  readonly note: string;
  readonly relatedType?: string | null;
  readonly relatedId?: string | null;
}

export interface AdjustmentPreview {
  readonly target: AdjustmentTarget;
  readonly direction: AdjustmentDirection;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly contributorId: string | null;
  readonly contributorName: string | null;
  readonly reason: AdjustmentReason;
  readonly note: string;
  /** The engineer's balance as it stands, and as it would stand after. */
  readonly balanceBeforeMinor: bigint | null;
  readonly balanceAfterMinor: bigint | null;
  /** The accounting month this would land in (Asia/Damascus). */
  readonly periodKey: string;
  /** Things the owner should read before confirming. Never silent. */
  readonly warnings: readonly string[];
}

const MIN_NOTE = 10;

function requireOwner(actor: Actor, what: string): void {
  if (!isOwner(actor)) {
    throw new RuleViolationError(`${what} من صلاحية مالك المنصة وحده`);
  }
}

/**
 * Everything that makes an adjustment invalid, in one place.
 *
 * Pure where it can be: the parts that need the database (does this
 * contributor exist?) are done by the caller, which has the transaction.
 */
function validateShape(input: AdjustmentInput): void {
  assertCurrency(input.currency);

  if (input.amountMinor <= 0n) {
    throw new ValidationError('المبلغ يجب أن يكون أكبر من صفر', {
      amountMinor: input.amountMinor.toString(),
    });
  }

  if (input.note.trim().length < MIN_NOTE) {
    throw new ValidationError('اكتب سبباً مفصّلاً لا يقل عن عشرة أحرف');
  }

  if (input.target === 'ENGINEER' && !input.contributorId) {
    throw new ValidationError('اختر المهندس المتأثر بالتعديل');
  }

  if (input.target === 'PLATFORM' && input.contributorId) {
    throw new ValidationError('تعديل حساب المنصة لا يخص مهندساً بعينه');
  }

  if ((input.relatedType == null) !== (input.relatedId == null)) {
    throw new ValidationError('مرجع العملية الأصلية يُذكر كاملاً أو لا يُذكر');
  }
}

/** The engineer's current balance, from the ledger. Null for a platform adjustment. */
async function contributorBalance(
  tx: Transaction,
  contributorId: string,
  currency: string,
): Promise<bigint> {
  const rows = (await tx.execute(sql`
    SELECT COALESCE(SUM(-amount_minor), 0)::text AS balance
      FROM ledger_lines
     WHERE account_code = ${LEDGER_ACCOUNTS.ENGINEER_PAYABLE}
       AND contributor_id = ${contributorId}
       AND currency = ${currency}
  `)) as unknown as Array<{ balance: string }>;

  return BigInt(rows[0]?.balance ?? '0');
}

async function resolveContributor(
  tx: Transaction,
  contributorId: string,
): Promise<{ id: string; displayName: string; isActive: boolean }> {
  const [row] = await tx
    .select({
      id: contributors.id,
      displayName: contributors.displayName,
      isActive: contributors.isActive,
    })
    .from(contributors)
    .where(eq(contributors.id, contributorId))
    .limit(1);

  if (!row) throw new NotFoundError('المهندس المحدَّد غير موجود');
  return row;
}

/**
 * What would happen, without doing it.
 *
 * Writes nothing. Returns the numbers the confirmation screen shows, and the
 * warnings the owner should read before pressing confirm.
 */
export async function previewAdjustment(
  actor: Actor,
  input: AdjustmentInput,
): Promise<AdjustmentPreview> {
  requireOwner(actor, 'قيود التصحيح');
  validateShape(input);

  return withActor(actor, async (tx) => {
    const warnings: string[] = [];
    let contributorName: string | null = null;
    let before: bigint | null = null;
    let after: bigint | null = null;

    if (input.target === 'ENGINEER') {
      const contributor = await resolveContributor(tx, input.contributorId!);
      contributorName = contributor.displayName;

      if (!contributor.isActive) {
        warnings.push('هذا المهندس غير مفعَّل حالياً، والتعديل سيُسجَّل على رصيده رغم ذلك.');
      }

      before = await contributorBalance(tx, contributor.id, input.currency);
      after = input.direction === 'INCREASE'
        ? before + input.amountMinor
        : before - input.amountMinor;

      if (after < 0n) {
        // Allowed, and said out loud. See the header for why this is not a
        // refusal.
        warnings.push(
          'سيصبح رصيد المهندس سالباً بعد هذا التعديل، ويُخصم من مستحقات الشهر التالي.',
        );
      }

      if (before === 0n && input.direction === 'DECREASE') {
        warnings.push('رصيد المهندس صفر حالياً، فالخصم يُنشئ ديناً عليه.');
      }
    }

    return {
      target: input.target,
      direction: input.direction,
      amountMinor: input.amountMinor,
      currency: input.currency,
      contributorId: input.contributorId ?? null,
      contributorName,
      reason: input.reason,
      note: input.note.trim(),
      balanceBeforeMinor: before,
      balanceAfterMinor: after,
      periodKey: periodKeyOf(new Date()),
      warnings,
    };
  });
}

/**
 * Which two accounts a correction moves between.
 *
 * An ENGINEER adjustment changes what is owed to a person, and the other side
 * is the platform's own revenue — paying an engineer more means keeping less.
 * A PLATFORM adjustment changes the platform's cash against the same revenue
 * account, which is how a bank fee or a miscounted transfer is recorded.
 *
 * The two accounts are fixed rather than chosen on a screen. Letting an
 * operator pick arbitrary accounts is how a ledger becomes unauditable, and
 * the owner asked for a small tool, not a general journal.
 */
function accountsFor(target: AdjustmentTarget): {
  primary: (typeof LEDGER_ACCOUNTS)[keyof typeof LEDGER_ACCOUNTS];
} {
  return {
    primary: target === 'ENGINEER'
      ? LEDGER_ACCOUNTS.ENGINEER_PAYABLE
      : LEDGER_ACCOUNTS.PLATFORM_CASH,
  };
}

export interface PostedAdjustment {
  readonly id: string;
  readonly reference: string;
  readonly ledgerTransactionId: string;
  readonly balanceAfterMinor: bigint | null;
}

/**
 * Post the correction. ONE transaction: ledger entry, record, audit, notice.
 *
 * `idempotencyKey` comes from the confirmation form. Submitting the same
 * confirmation twice returns the first result rather than posting twice — the
 * screen cannot cause a double correction by being refreshed.
 */
export async function postAdjustment(
  actor: Actor,
  input: AdjustmentInput & { idempotencyKey: string },
): Promise<PostedAdjustment> {
  requireOwner(actor, 'قيود التصحيح');
  // Revalidated here, not trusted from the preview: a summary the owner saw is
  // not a permission, and the two calls are separate requests.
  validateShape(input);

  if (input.idempotencyKey.trim().length < 8) {
    throw new ValidationError('مفتاح منع التكرار غير صالح');
  }

  return withActor(actor, async (tx) => {
    const existing = await tx
      .select({
        id: financialAdjustments.id,
        reference: financialAdjustments.reference,
        ledgerTransactionId: financialAdjustments.ledgerTransactionId,
      })
      .from(financialAdjustments)
      .where(eq(financialAdjustments.idempotencyKey, input.idempotencyKey))
      .limit(1);

    if (existing.length > 0) {
      return { ...existing[0]!, balanceAfterMinor: null };
    }

    let contributorName: string | null = null;
    if (input.target === 'ENGINEER') {
      contributorName = (await resolveContributor(tx, input.contributorId!)).displayName;
    }

    const signed = input.direction === 'INCREASE' ? -input.amountMinor : input.amountMinor;
    const { primary } = accountsFor(input.target);
    const occurredAt = new Date();
    const note = input.note.trim();

    const [referenceRow] = (await tx.execute(
      sql`SELECT app_next_adjustment_reference() AS reference`,
    )) as unknown as Array<{ reference: string }>;
    const reference = referenceRow!.reference;

    /*
     * The memo carries the reference and the reason onto the LEDGER LINE
     * itself, which is the part an affected engineer can read. A balance that
     * moves with no visible explanation is the thing this whole feature exists
     * to avoid.
     */
    const memo = `${reference} — ${note}`;

    const ledgerTransactionId = await postLedgerTransaction(tx, {
      kind: LEDGER_KINDS.ADJUSTMENT,
      currency: input.currency,
      occurredAt,
      referenceType: input.relatedType ?? 'adjustment',
      referenceId: input.relatedId ?? null,
      memo,
      lines: [
        {
          account: primary,
          contributorId: input.target === 'ENGINEER' ? input.contributorId! : null,
          amountMinor: signed,
          memo,
        },
        {
          account: LEDGER_ACCOUNTS.PLATFORM_REVENUE,
          amountMinor: -signed,
          memo,
        },
      ],
    });

    const [created] = await tx
      .insert(financialAdjustments)
      .values({
        reference,
        target: input.target,
        direction: input.direction,
        amountMinor: input.amountMinor,
        currency: input.currency,
        contributorId: input.contributorId ?? null,
        contributorName,
        reason: input.reason,
        note,
        relatedType: input.relatedType ?? null,
        relatedId: input.relatedId ?? null,
        ledgerTransactionId,
        occurredAt,
        createdBy: actor.kind === 'USER' ? actor.userId : null,
        createdByName: actor.kind === 'USER' ? actor.displayName : null,
        idempotencyKey: input.idempotencyKey,
      })
      .returning({ id: financialAdjustments.id });

    if (!created) {
      // RLS refuses a write by returning no rows, not by raising.
      throw new RuleViolationError('تعذّر تسجيل قيد التصحيح');
    }

    // §33: the affected engineer is told, and nobody else is.
    if (input.target === 'ENGINEER') {
      await notifyContributor(tx, input.contributorId!, 'BALANCE_ADJUSTED', {
        reference,
        direction: input.direction,
        currency: input.currency,
        amountMinor: input.amountMinor.toString(),
        note,
      });
    }

    await recordAudit(tx, actor, {
      action: 'LEDGER_ADJUSTMENT_POSTED',
      entityType: 'financial_adjustment',
      entityId: created.id,
      after: {
        reference,
        target: input.target,
        direction: input.direction,
        amountMinor: input.amountMinor.toString(),
        currency: input.currency,
        contributorId: input.contributorId ?? null,
        contributorName,
        reason: input.reason,
        note,
        relatedType: input.relatedType ?? null,
        relatedId: input.relatedId ?? null,
        ledgerTransactionId,
      },
    });

    const balanceAfterMinor = input.target === 'ENGINEER'
      ? await contributorBalance(tx, input.contributorId!, input.currency)
      : null;

    return { id: created.id, reference, ledgerTransactionId, balanceAfterMinor };
  });
}

export interface AdjustmentRow {
  readonly id: string;
  readonly reference: string;
  readonly target: string;
  readonly direction: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly contributorName: string | null;
  readonly reason: string;
  readonly note: string;
  readonly occurredAt: Date;
  readonly createdByName: string | null;
  readonly ledgerTransactionId: string;
}

/** The owner's log of corrections. Nobody else can read this table at all. */
export async function listAdjustments(
  actor: Actor,
  options: { limit?: number } = {},
): Promise<readonly AdjustmentRow[]> {
  requireOwner(actor, 'سجل قيود التصحيح');
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  return withActor(actor, async (tx) => {
    const rows = await tx
      .select()
      .from(financialAdjustments)
      .orderBy(desc(financialAdjustments.occurredAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      target: row.target,
      direction: row.direction,
      amountMinor: row.amountMinor,
      currency: row.currency,
      contributorName: row.contributorName,
      reason: row.reason,
      note: row.note,
      occurredAt: requireDate(row.occurredAt, 'occurredAt'),
      createdByName: row.createdByName,
      ledgerTransactionId: row.ledgerTransactionId,
    }));
  });
}

/** Engineers the owner can adjust, for the picker. Owner-only. */
export async function adjustableContributors(
  actor: Actor,
): Promise<readonly { id: string; displayName: string; isActive: boolean }[]> {
  requireOwner(actor, 'قائمة المهندسين');

  return withActor(actor, (tx) =>
    tx
      .select({
        id: contributors.id,
        displayName: contributors.displayName,
        isActive: contributors.isActive,
      })
      .from(contributors)
      .orderBy(contributors.displayName)
      .limit(500),
  );
}
