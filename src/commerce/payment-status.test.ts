import { describe, it, expect } from 'vitest';
import {
  OPEN_PAYMENT_STATUSES, TERMINAL_PAYMENT_STATUSES, assertPaymentTransition, canMovePayment,
  payableFrom, type PaymentStatus,
} from './payment-status';
import { RuleViolationError } from '@/lib/errors';

/**
 * The payment's own state machine (Stage 7 — S7-06). The database trigger
 * `payments_transition_guard` (migration 0066) encodes the same table; the
 * integration suite proves the two agree from the database side.
 */

const ALL: readonly PaymentStatus[] = [
  'INITIATED', 'AWAITING_PROOF', 'PROOF_SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED',
];

const ALLOWED: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  INITIATED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  AWAITING_PROOF: ['PROOF_SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'],
  PROOF_SUBMITTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};

describe('payment transitions', () => {
  it.each(ALL.flatMap((from) => ALL.map((to) => [from, to] as const)))('%s → %s', (from, to) => {
    const allowed = ALLOWED[from].includes(to);
    expect(canMovePayment(from, to)).toBe(allowed);
    if (allowed) expect(() => assertPaymentTransition(from, to)).not.toThrow();
    else expect(() => assertPaymentTransition(from, to)).toThrow(RuleViolationError);
  });

  it('open and terminal partition every status', () => {
    expect([...OPEN_PAYMENT_STATUSES].sort()).toEqual(['AWAITING_PROOF', 'INITIATED', 'PROOF_SUBMITTED']);
    expect([...TERMINAL_PAYMENT_STATUSES].sort()).toEqual(['APPROVED', 'CANCELLED', 'REJECTED']);
    for (const status of TERMINAL_PAYMENT_STATUSES) expect(ALLOWED[status]).toEqual([]);
  });

  it('only an open payment can be approved, rejected or cancelled', () => {
    expect([...payableFrom('APPROVED')].sort()).toEqual([...OPEN_PAYMENT_STATUSES].sort());
    expect([...payableFrom('REJECTED')].sort()).toEqual([...OPEN_PAYMENT_STATUSES].sort());
    expect([...payableFrom('CANCELLED')].sort()).toEqual([...OPEN_PAYMENT_STATUSES].sort());
    expect(payableFrom('PROOF_SUBMITTED')).toEqual(['AWAITING_PROOF']);
  });
});
