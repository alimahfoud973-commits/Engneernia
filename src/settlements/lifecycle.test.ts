import { describe, it, expect } from 'vitest';
import { canMoveSettlement, type SettlementStatus } from './lifecycle';

/**
 * The settlement lifecycle as a table.
 *
 * Every state against every state, exhaustively, so a transition nobody
 * decided cannot appear by accident — the same shape as the order lifecycle
 * and the authorization matrix.
 */
const STATUSES: readonly SettlementStatus[] = [
  'PENDING', 'APPROVED', 'PAID', 'CARRIED_FORWARD', 'CANCELLED',
];

const ALLOWED: ReadonlySet<string> = new Set([
  'PENDING→APPROVED',
  'PENDING→CANCELLED',
  'APPROVED→PAID',
  'APPROVED→CANCELLED',
  'CARRIED_FORWARD→CANCELLED',
]);

describe('the settlement lifecycle (decisions §9)', () => {
  it('permits exactly the decided transitions and nothing else', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const key = `${from}→${to}`;
        expect(canMoveSettlement(from, to), key).toBe(ALLOWED.has(key));
      }
    }
  });

  it('a paid settlement is terminal', () => {
    for (const to of STATUSES) {
      expect(canMoveSettlement('PAID', to)).toBe(false);
    }
  });

  it('a carried-forward statement can never be approved or paid', () => {
    // Its balance rolls into the NEXT month's settlement, which is where it
    // gets paid. Approving this one would pay the same money twice.
    expect(canMoveSettlement('CARRIED_FORWARD', 'APPROVED')).toBe(false);
    expect(canMoveSettlement('CARRIED_FORWARD', 'PAID')).toBe(false);
  });

  it('nothing reaches PAID without passing through APPROVED', () => {
    expect(canMoveSettlement('PENDING', 'PAID')).toBe(false);
    expect(canMoveSettlement('CANCELLED', 'PAID')).toBe(false);
  });
});
