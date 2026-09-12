import 'server-only';
import { eq } from 'drizzle-orm';
import { orders, paymentProofs, payments } from '@/db/schema';
import { withActor } from '@/db/actor-context';
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
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .limit(1);
    if (!payment) throw new NotFoundError('الدفعة غير موجودة');

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

    await tx
      .update(payments)
      .set({ status: 'PROOF_SUBMITTED', updatedAt: new Date() })
      .where(eq(payments.id, payment.id));

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
