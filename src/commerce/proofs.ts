import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { orders, paymentProofs, payments } from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { notifyUser } from '@/notifications/notify';
import type { Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError, UnauthenticatedError, ValidationError } from '@/lib/errors';
import { getStorage, newStorageKey } from '@/media/storage';
import { getScanner } from '@/media/scanner';
import { detectContainer } from '@/media/file-types';
import { moveOrderForProof } from './proof-transition';

/**
 * ===========================================================================
 * PAYMENT PROOF (specification §24)
 * ===========================================================================
 * The customer uploads a receipt; the owner looks at it and decides.
 *
 * A proof is an image or a PDF from an untrusted person, stored privately and
 * later opened by the owner. Two rules follow: the bytes are inspected and
 * scanned like any other upload, and the file is only ever rendered as an
 * image or a PDF — never as HTML or SVG, which a browser would execute in the
 * owner's session.
 * ===========================================================================
 */

const PROOF_MAX_BYTES = 10 * 1024 * 1024;

/** Deliberately narrow: a receipt is a photo or a PDF. Nothing else. */
const PROOF_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

const IMAGE_SIGNATURES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // WebP is a RIFF container: "RIFF" .... "WEBP"
  ['image/webp', [0x52, 0x49, 0x46, 0x46]],
];

function detectProofType(head: Uint8Array, extension: string): string {
  if (detectContainer(head) === 'PDF') return 'application/pdf';

  for (const [mime, bytes] of IMAGE_SIGNATURES) {
    if (bytes.every((byte, index) => head[index] === byte)) {
      if (mime === 'image/webp') {
        const marker = Buffer.from(head.subarray(8, 12)).toString('latin1');
        if (marker !== 'WEBP') continue;
      }
      return mime;
    }
  }

  throw new ValidationError('يجب أن يكون إثبات الدفع صورة أو ملف PDF', { extension });
}

/**
 * Only a payment waiting for its receipt takes one (W7).
 *
 * A second receipt on a payment already under review, or one on a payment the
 * owner rejected, used to be stored and then refused further down by the
 * order's state machine, leaving the object behind. The retry after a
 * rejection is a new attempt from the order page, not a second receipt here.
 */
function assertAwaitingProof(status: string): void {
  if (status !== 'AWAITING_PROOF') {
    throw new RuleViolationError(
      'لا تقبل هذه الدفعة إيصالاً الآن: إيصالها قيد التحقق أو أنها رُفضت. تابع من صفحة الطلب.',
      { status },
    );
  }
}

/**
 * The payment follows its receipt to PROOF_SUBMITTED (W7).
 *
 * A plain UPDATE here ran as the customer, and `payments_update` admits the
 * owner alone — so it matched zero rows, raised nothing, and every payment
 * stayed AWAITING_PROOF beside a receipt and an order that said otherwise.
 * `app_mark_payment_proof_submitted` (migration 0057) is the one narrow move:
 * it checks ownership, status and the receipt as the customer, changes one
 * column of one row, and raises unless exactly one row moved. Its answer is
 * checked here too, because a write whose effect is not checked is how this
 * defect lived unnoticed.
 */
async function markPaymentProofSubmitted(tx: Transaction, paymentId: string): Promise<void> {
  let rows: Array<{ moved: string | null }>;
  try {
    rows = (await tx.execute(
      sql`SELECT app_mark_payment_proof_submitted(${paymentId}::uuid) AS moved`,
    )) as unknown as typeof rows;
  } catch (error) {
    const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code
      ?? (error as { code?: string })?.code;
    // P0002 no_data_found: not the caller's payment, or no such payment.
    if (code === 'P0002') throw new NotFoundError('الدفعة غير موجودة');
    // 23514 check_violation: not awaiting a receipt, or no receipt on it.
    if (code === '23514') throw new RuleViolationError('تعذّر تسجيل الإيصال على هذه الدفعة');
    throw error;
  }
  if (rows[0]?.moved !== paymentId) {
    throw new RuleViolationError('تعذّر تسجيل الإيصال على هذه الدفعة');
  }
}

export async function submitPaymentProof(
  actor: Actor,
  input: {
    paymentId: string;
    filename: string;
    body: Uint8Array;
    referenceNote?: string | null;
  },
): Promise<{ proofId: string }> {
  if (actor.kind !== 'USER') throw new UnauthenticatedError();

  if (input.body.byteLength === 0) throw new ValidationError('الملف فارغ');
  if (input.body.byteLength > PROOF_MAX_BYTES) {
    throw new ValidationError('حجم إثبات الدفع يتجاوز الحد المسموح', {
      limitMb: PROOF_MAX_BYTES / 1024 / 1024,
    });
  }

  const extension = input.filename.slice(input.filename.lastIndexOf('.')).toLowerCase();
  if (!Object.hasOwn(PROOF_TYPES, extension)) {
    throw new ValidationError('امتداد غير مقبول لإثبات الدفع', {
      allowed: Object.keys(PROOF_TYPES),
    });
  }

  /**
   * WHO THIS PAYMENT BELONGS TO IS SETTLED BEFORE ANY BYTE IS STORED.
   *
   * The scan and the upload used to run first, and the ownership check only
   * afterwards inside the transaction. A payment id that resolves to nothing —
   * invented, or somebody else's, which row-level security makes
   * indistinguishable — therefore left a scanned object in the originals
   * bucket with no row pointing at it. Any account could fill the bucket that
   * way, one receipt at a time, and every call would return an error, which is
   * exactly what a working platform looks like.
   *
   * This read costs one round trip and resolves under the caller's own
   * context, so it answers the ownership question with the same authority the
   * write below would have.
   */
  await withActor(actor, async (tx) => {
    const [payment] = await tx
      .select({ id: payments.id, orderId: payments.orderId, status: payments.status })
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .limit(1);
    if (!payment) throw new NotFoundError('الدفعة غير موجودة');
    // Before storage, for the same reason as ownership: a receipt the payment
    // cannot take must not leave an object behind (W7).
    assertAwaitingProof(payment.status);

    const [order] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, payment.orderId))
      .limit(1);
    if (!order) throw new NotFoundError('الطلب غير موجود');
  });

  // The extension is a claim; the bytes are the evidence.
  const contentType = detectProofType(input.body.subarray(0, 32), extension);

  const scan = await getScanner().scan(input.body);
  if (scan.status === 'INFECTED') {
    throw new RuleViolationError('رُفض الملف: كشف الفاحص برمجية خبيثة');
  }
  if (scan.status === 'FAILED') {
    throw new RuleViolationError('تعذّر فحص الملف؛ لم يُحفظ');
  }

  const storageKey = newStorageKey('proof');
  await getStorage().put('originals', storageKey, input.body, contentType);

  return withActor(actor, async (tx) => {
    /**
     * Checked again here, not instead of above: the pre-flight closes the
     * storage hole, and this is still the check that governs the write. A
     * payment revoked between the two reads must not produce a proof row.
     */
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .limit(1);
    if (!payment) throw new NotFoundError('الدفعة غير موجودة');
    assertAwaitingProof(payment.status);

    const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).limit(1);
    if (!order) throw new NotFoundError('الطلب غير موجود');

    const [proof] = await tx
      .insert(paymentProofs)
      .values({
        paymentId: payment.id,
        storageKey,
        contentType,
        byteSize: BigInt(input.body.byteLength),
        referenceNote: input.referenceNote ?? null,
        submittedBy: actor.userId,
      })
      .returning({ id: paymentProofs.id });

    if (!proof) throw new RuleViolationError('تعذّر حفظ إثبات الدفع');

    await markPaymentProofSubmitted(tx, payment.id);

    await moveOrderForProof(tx, actor, order);

    await recordAudit(tx, actor, {
      action: 'PAYMENT_APPROVED', // reused enum member; the entity says what it is
      entityType: 'payment_proof',
      entityId: proof.id,
      after: {
        paymentId: payment.id,
        orderNumber: order.orderNumber,
        contentType,
        byteSize: input.body.byteLength,
        scanStatus: scan.status,
        submitted: true,
      },
    });

    return { proofId: proof.id };
  });
}

/** Owner records a decision on a proof. The payment outcome follows. */
export async function recordProofDecision(
  actor: Actor,
  input: { proofId: string; approve: boolean; reason?: string | null },
): Promise<void> {
  await withActor(actor, async (tx) => {
    const updated = await tx
      .update(paymentProofs)
      .set({
        decision: input.approve ? 'APPROVED' : 'REJECTED',
        reviewedBy: actor.kind === 'USER' ? actor.userId : null,
        reviewedAt: new Date(),
        rejectionReason: input.approve ? null : (input.reason ?? null),
      })
      .where(eq(paymentProofs.id, input.proofId))
      .returning({ id: paymentProofs.id, paymentId: paymentProofs.paymentId });

    if (updated.length === 0) {
      throw new RuleViolationError('لم يُسجَّل قرار المراجعة');
    }

    const [proof] = updated;
    const [payment] = await tx
      .select({ orderId: payments.orderId })
      .from(payments)
      .where(eq(payments.id, proof!.paymentId))
      .limit(1);

    if (payment) {
      const [order] = await tx
        .select({ customerId: orders.customerId, orderNumber: orders.orderNumber })
        .from(orders)
        .where(eq(orders.id, payment.orderId))
        .limit(1);

      if (order && !input.approve) {
        await notifyUser(tx, {
          userId: order.customerId,
          type: 'PAYMENT_REJECTED',
          payload: { orderNumber: order.orderNumber, reason: input.reason ?? null },
        });
      }
    }
  });
}
