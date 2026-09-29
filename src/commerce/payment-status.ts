import { RuleViolationError } from '@/lib/errors';

/**
 * ===========================================================================
 * THE PAYMENT'S OWN LIFECYCLE (Stage 7 — S7-06, owner decision D11)
 * ===========================================================================
 *
 *   INITIATED ─────────┬──────────────────────────→ APPROVED ▪
 *                      │                         ├→ REJECTED ▪
 *   AWAITING_PROOF ──→ PROOF_SUBMITTED ──────────┤
 *        │                                       └→ CANCELLED ▪
 *        └─── (owner: a transfer confirmed without a receipt) → APPROVED
 *
 * ▪ FINAL. A payment is one attempt: a rejected or cancelled one is history,
 *   and the next attempt is a NEW row (K1). Nothing moves out of a final
 *   state, and the database refuses it too (`payments_transition_guard`,
 *   migration 0066) — the two tables must stay identical.
 *
 * Until Stage 7 only the ORDER's table stood between the owner and approving
 * a payment they had already rejected.
 * ===========================================================================
 */

export type PaymentStatus =
  | 'INITIATED'
  | 'AWAITING_PROOF'
  | 'PROOF_SUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED';

/** Still waiting for a decision. At most one per order (index, 0066). */
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = Object.freeze([
  'INITIATED', 'AWAITING_PROOF', 'PROOF_SUBMITTED',
]);

export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = Object.freeze([
  'APPROVED', 'REJECTED', 'CANCELLED',
]);

const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = Object.freeze({
  INITIATED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  AWAITING_PROOF: ['PROOF_SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'],
  PROOF_SUBMITTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
});

export function canMovePayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canMovePayment(from, to)) {
    throw new RuleViolationError('لا يمكن تغيير حالة هذه الدفعة بهذه الطريقة', { from, to });
  }
}

/** The statuses a payment may be in to move to `to` — for conditional writes. */
export function payableFrom(to: PaymentStatus): readonly PaymentStatus[] {
  return (Object.keys(TRANSITIONS) as PaymentStatus[]).filter((from) => TRANSITIONS[from].includes(to));
}

export function isOpenPayment(status: string): boolean {
  return (OPEN_PAYMENT_STATUSES as readonly string[]).includes(status);
}
