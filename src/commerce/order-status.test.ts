import { describe, it, expect } from 'vitest';
import {
  assertOrderTransition, canTransition, transitionsFrom, type OrderStatus,
} from './order-status';
import { RuleViolationError } from '@/lib/errors';

const ALL: readonly OrderStatus[] = [
  'DRAFT', 'AWAITING_PAYMENT', 'PROOF_SUBMITTED', 'PENDING_VERIFICATION',
  'PAID', 'COMPLETED', 'PAYMENT_ISSUE', 'CANCELLED', 'REFUNDED',
];

describe('the documented manual-payment path (specification §24)', () => {
  it('walks draft → awaiting → proof → verification → paid → completed', () => {
    expect(canTransition('DRAFT', 'AWAITING_PAYMENT', 'CUSTOMER')).toBe(true);
    expect(canTransition('AWAITING_PAYMENT', 'PROOF_SUBMITTED', 'CUSTOMER')).toBe(true);
    expect(canTransition('PROOF_SUBMITTED', 'PENDING_VERIFICATION', 'OWNER')).toBe(true);
    expect(canTransition('PENDING_VERIFICATION', 'PAID', 'OWNER')).toBe(true);
    expect(canTransition('PAID', 'COMPLETED', 'SYSTEM')).toBe(true);
  });

  it('lets a rejected payment be retried', () => {
    expect(canTransition('PENDING_VERIFICATION', 'PAYMENT_ISSUE', 'OWNER')).toBe(true);
    expect(canTransition('PAYMENT_ISSUE', 'AWAITING_PAYMENT', 'CUSTOMER')).toBe(true);
  });

  /**
   * A customer can claim they transferred when nothing arrived. Without this
   * the order sits in AWAITING_PAYMENT forever with no way to close it.
   */
  it('lets the owner close a payment that never arrived, before any proof', () => {
    expect(canTransition('AWAITING_PAYMENT', 'PAYMENT_ISSUE', 'OWNER')).toBe(true);
    expect(canTransition('AWAITING_PAYMENT', 'PAYMENT_ISSUE', 'CUSTOMER')).toBe(false);
  });
});

/**
 * The financial control this table exists to enforce. PAID writes the
 * snapshot and opens the file; nobody but the owner may reach it.
 */
describe('only the owner can mark an order paid', () => {
  it('refuses every customer route to PAID', () => {
    for (const from of ALL) {
      expect(canTransition(from, 'PAID', 'CUSTOMER'), `${from} → PAID as customer`).toBe(false);
    }
  });

  it('refuses a customer approving their own proof', () => {
    expect(canTransition('PROOF_SUBMITTED', 'PAID', 'CUSTOMER')).toBe(false);
    expect(canTransition('PENDING_VERIFICATION', 'PAID', 'CUSTOMER')).toBe(false);
  });

  it('refuses a customer rejecting or refunding', () => {
    expect(canTransition('PENDING_VERIFICATION', 'PAYMENT_ISSUE', 'CUSTOMER')).toBe(false);
    expect(canTransition('COMPLETED', 'REFUNDED', 'CUSTOMER')).toBe(false);
  });

  it('gives a customer exactly the moves they should have', () => {
    const moves = ALL.flatMap((status) =>
      transitionsFrom(status, 'CUSTOMER').map((t) => `${status}→${t.to}`),
    ).sort();
    expect(moves).toEqual([
      'AWAITING_PAYMENT→CANCELLED',
      'AWAITING_PAYMENT→PROOF_SUBMITTED',
      'DRAFT→AWAITING_PAYMENT',
      'DRAFT→CANCELLED',
      'PAYMENT_ISSUE→AWAITING_PAYMENT',
      'PAYMENT_ISSUE→CANCELLED',
    ]);
  });
});

describe('terminal states', () => {
  it('offers nothing from CANCELLED or REFUNDED', () => {
    for (const actor of ['OWNER', 'CUSTOMER', 'SYSTEM'] as const) {
      expect(transitionsFrom('CANCELLED', actor)).toEqual([]);
      expect(transitionsFrom('REFUNDED', actor)).toEqual([]);
    }
  });

  it('never allows a paid order to be cancelled', () => {
    for (const actor of ['OWNER', 'CUSTOMER', 'SYSTEM'] as const) {
      expect(canTransition('PAID', 'CANCELLED', actor)).toBe(false);
      expect(canTransition('COMPLETED', 'CANCELLED', actor)).toBe(false);
    }
  });

  it('never allows a completed order back to an unpaid state', () => {
    for (const to of ['DRAFT', 'AWAITING_PAYMENT', 'PROOF_SUBMITTED', 'PENDING_VERIFICATION'] as const) {
      expect(canTransition('COMPLETED', to, 'OWNER'), `COMPLETED → ${to}`).toBe(false);
    }
  });
});

describe('table soundness', () => {
  it('has an entry for every status with only known targets', () => {
    for (const status of ALL) {
      for (const t of transitionsFrom(status, 'OWNER')) {
        expect(ALL).toContain(t.to);
      }
    }
  });

  it('never allows a state to transition to itself', () => {
    for (const status of ALL) {
      for (const actor of ['OWNER', 'CUSTOMER', 'SYSTEM'] as const) {
        expect(canTransition(status, status, actor), `${status} → itself`).toBe(false);
      }
    }
  });
});

describe('assertOrderTransition', () => {
  it('names the moves that were available', () => {
    try {
      assertOrderTransition('DRAFT', 'PAID', 'CUSTOMER');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RuleViolationError);
      expect((error as RuleViolationError).details).toMatchObject({
        from: 'DRAFT',
        to: 'PAID',
        allowed: ['AWAITING_PAYMENT', 'CANCELLED'],
      });
    }
  });

  it('passes a legitimate move', () => {
    expect(() => assertOrderTransition('PENDING_VERIFICATION', 'PAID', 'OWNER')).not.toThrow();
  });
});
