import { RuleViolationError } from '@/lib/errors';
import { isOwner, type Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * ORDER LIFECYCLE (specification §24)
 * ===========================================================================
 *
 *   DRAFT ─→ AWAITING_PAYMENT ─→ PROOF_SUBMITTED ─→ PENDING_VERIFICATION
 *                   ↑                                      │
 *                   │                        ┌─────────────┴────────────┐
 *              PAYMENT_ISSUE ←───────────────┤                          │
 *                                            ↓                          ↓
 *                                          PAID ──→ COMPLETED       (rejected)
 *
 * Encoded as an explicit table because "who may mark an order paid" is a
 * financial control, not a UI concern. Only the owner can reach PAID, and
 * PAID is the only state that writes the financial snapshot and grants
 * access to a file.
 * ===========================================================================
 */

export type OrderStatus =
  | 'DRAFT'
  | 'AWAITING_PAYMENT'
  | 'PROOF_SUBMITTED'
  | 'PENDING_VERIFICATION'
  | 'PAID'
  | 'COMPLETED'
  | 'PAYMENT_ISSUE'
  | 'CANCELLED'
  | 'REFUNDED';

export type OrderActor = 'OWNER' | 'CUSTOMER' | 'SYSTEM';

interface Transition {
  readonly to: OrderStatus;
  readonly allowedFor: readonly OrderActor[];
  readonly label: string;
}

const TRANSITIONS: Readonly<Record<OrderStatus, readonly Transition[]>> = Object.freeze({
  DRAFT: [
    { to: 'AWAITING_PAYMENT', allowedFor: ['CUSTOMER', 'OWNER'], label: 'تأكيد الطلب' },
    { to: 'CANCELLED', allowedFor: ['CUSTOMER', 'OWNER'], label: 'إلغاء' },
  ],
  AWAITING_PAYMENT: [
    { to: 'PROOF_SUBMITTED', allowedFor: ['CUSTOMER', 'OWNER'], label: 'إرسال إثبات الدفع' },
    // A gateway or an owner recording a confirmed transfer can skip the proof.
    { to: 'PAID', allowedFor: ['OWNER', 'SYSTEM'], label: 'تأكيد الدفع' },
    // A customer may claim they transferred when nothing arrived. Without
    // this the order sits in AWAITING_PAYMENT forever and the owner has no
    // way to close the loop.
    { to: 'PAYMENT_ISSUE', allowedFor: ['OWNER'], label: 'تعذّر تأكيد الدفع' },
    { to: 'CANCELLED', allowedFor: ['CUSTOMER', 'OWNER'], label: 'إلغاء' },
  ],
  PROOF_SUBMITTED: [
    { to: 'PENDING_VERIFICATION', allowedFor: ['OWNER', 'SYSTEM'], label: 'بدء التحقق' },
    { to: 'PAID', allowedFor: ['OWNER'], label: 'اعتماد الدفع' },
    { to: 'PAYMENT_ISSUE', allowedFor: ['OWNER'], label: 'رفض الإثبات' },
    { to: 'CANCELLED', allowedFor: ['OWNER'], label: 'إلغاء' },
  ],
  PENDING_VERIFICATION: [
    { to: 'PAID', allowedFor: ['OWNER'], label: 'اعتماد الدفع' },
    { to: 'PAYMENT_ISSUE', allowedFor: ['OWNER'], label: 'رفض الإثبات' },
    { to: 'CANCELLED', allowedFor: ['OWNER'], label: 'إلغاء' },
  ],
  PAYMENT_ISSUE: [
    { to: 'AWAITING_PAYMENT', allowedFor: ['CUSTOMER', 'OWNER'], label: 'إعادة المحاولة' },
    { to: 'CANCELLED', allowedFor: ['CUSTOMER', 'OWNER'], label: 'إلغاء' },
  ],
  // Granting entitlements is the system's act, immediately after PAID.
  PAID: [{ to: 'COMPLETED', allowedFor: ['SYSTEM', 'OWNER'], label: 'إتمام ومنح الوصول' }],
  // The owner alone reverses a completed sale, through src/commerce/refunds.ts,
  // which reaches this transition only after the ledger reversal has been posted.
  COMPLETED: [{ to: 'REFUNDED', allowedFor: ['OWNER'], label: 'استرجاع' }],
  CANCELLED: [],
  REFUNDED: [],
});

/** The states in which a customer still owns their order and may edit it. */
export const CUSTOMER_EDITABLE: readonly OrderStatus[] = ['DRAFT', 'AWAITING_PAYMENT'];

/** The states that mean the platform has the money. */
export const SETTLED_STATUSES: readonly OrderStatus[] = ['PAID', 'COMPLETED'];

export function transitionsFrom(status: OrderStatus, actor: OrderActor): readonly Transition[] {
  return TRANSITIONS[status].filter((t) => t.allowedFor.includes(actor));
}

export function canTransition(from: OrderStatus, to: OrderStatus, actor: OrderActor): boolean {
  return TRANSITIONS[from].some((t) => t.to === to && t.allowedFor.includes(actor));
}

export function orderActorOf(actor: Actor): OrderActor {
  return isOwner(actor) ? 'OWNER' : 'CUSTOMER';
}

export function assertOrderTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: OrderActor,
): void {
  if (!canTransition(from, to, actor)) {
    throw new RuleViolationError('انتقال غير مسموح في دورة حياة الطلب', {
      from,
      to,
      actor,
      allowed: transitionsFrom(from, actor).map((t) => t.to),
    });
  }
}
