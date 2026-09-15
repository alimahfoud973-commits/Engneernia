import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeCommissionSnapshot, reverseSnapshot, type CommissionAgreement } from './commission';
import { money } from './money';
import { MoneyInvariantError, RuleViolationError, ValidationError } from '@/lib/errors';

const usd = (minor: bigint) => money(minor, 'USD');

describe('percentage model — specification §11 worked examples', () => {
  it('$10 at 90% engineer yields $9 / $1', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(1000n),
      agreement: { model: 'PERCENTAGE', engineerBp: 9000, currency: 'USD' },
    });
    expect(snapshot.engineerAmountMinor).toBe(900n);
    expect(snapshot.platformAmountMinor).toBe(100n);
  });

  it('$20 at 80% engineer yields $16 / $4', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(2000n),
      agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD' },
    });
    expect(snapshot.engineerAmountMinor).toBe(1600n);
    expect(snapshot.platformAmountMinor).toBe(400n);
  });

  it('the §15 monthly example: $165 gross at 80% yields $132 / $33', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(16_500n),
      agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD' },
    });
    expect(snapshot.engineerAmountMinor).toBe(13_200n);
    expect(snapshot.platformAmountMinor).toBe(3_300n);
  });
});

describe('fixed models — specification §11', () => {
  it('$15 with a fixed $11 engineer share yields $11 / $4', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(1500n),
      agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: 1100n, currency: 'USD' },
    });
    expect(snapshot.engineerAmountMinor).toBe(1100n);
    expect(snapshot.platformAmountMinor).toBe(400n);
    expect(snapshot.clamped).toBe(false);
  });

  it('caps a fixed engineer share that exceeds the price, and flags it', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(500n),
      agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: 1100n, currency: 'USD' },
    });
    expect(snapshot.engineerAmountMinor).toBe(500n);
    expect(snapshot.platformAmountMinor).toBe(0n);
    expect(snapshot.clamped).toBe(true);
  });

  it('supports a fixed platform share', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(2000n),
      agreement: { model: 'FIXED_PLATFORM', platformFixedMinor: 300n, currency: 'USD' },
    });
    expect(snapshot.engineerAmountMinor).toBe(1700n);
    expect(snapshot.platformAmountMinor).toBe(300n);
  });
});

describe('free products — specification §42', () => {
  it('splits a zero price into zero and zero', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(0n),
      agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD' },
    });
    expect(snapshot.engineerAmountMinor).toBe(0n);
    expect(snapshot.platformAmountMinor).toBe(0n);
  });
});

describe('guards', () => {
  it('rejects a currency mismatch between agreement and sale', () => {
    expect(() =>
      computeCommissionSnapshot({
        listPrice: usd(1000n),
        agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'EUR' },
      }),
    ).toThrow(RuleViolationError);
  });

  it('rejects a negative price', () => {
    expect(() =>
      computeCommissionSnapshot({
        listPrice: usd(-100n),
        agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a negative discount — a surcharge is not a discount (OPEN-1)', () => {
    expect(() =>
      computeCommissionSnapshot({
        listPrice: usd(1000n),
        discount: usd(-100n),
        agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a discount larger than the price — the pot cannot go negative', () => {
    expect(() =>
      computeCommissionSnapshot({
        listPrice: usd(1000n),
        discount: usd(1001n),
        agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a negative fixed share', () => {
    expect(() =>
      computeCommissionSnapshot({
        listPrice: usd(1000n),
        agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: -1n, currency: 'USD' },
      }),
    ).toThrow(ValidationError);
  });
});

/**
 * THE MANDATORY REQUIREMENT — specification §13 and §48.
 * A snapshot taken at the time of sale must be unaffected by any later change
 * to the price or to the commission agreement.
 */
describe('§13 historical snapshot immutability', () => {
  it('order #1001 keeps $8 / $2 after the agreement changes to 70/30', () => {
    const originalAgreement: CommissionAgreement = {
      model: 'PERCENTAGE',
      engineerBp: 8000,
      currency: 'USD',
    };
    const order1001 = computeCommissionSnapshot({
      listPrice: usd(1000n),
      agreement: originalAgreement,
    });

    expect(order1001.engineerAmountMinor).toBe(800n);
    expect(order1001.platformAmountMinor).toBe(200n);

    // The owner later changes the agreement, and the price.
    const newAgreement: CommissionAgreement = {
      model: 'PERCENTAGE',
      engineerBp: 7000,
      currency: 'USD',
    };
    const futureSale = computeCommissionSnapshot({
      listPrice: usd(2500n),
      agreement: newAgreement,
    });

    // The new sale uses the new terms...
    expect(futureSale.engineerAmountMinor).toBe(1750n);
    // ...and the historical one is untouched.
    expect(order1001.engineerAmountMinor).toBe(800n);
    expect(order1001.platformAmountMinor).toBe(200n);
    expect(order1001.engineerBp).toBe(8000);
    expect(order1001.listPriceMinor).toBe(1000n);
  });

  it('returns a frozen snapshot that cannot be mutated in place', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(1000n),
      agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD' },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { engineerAmountMinor: bigint }).engineerAmountMinor = 999n;
    }).toThrow(TypeError);
    expect(snapshot.engineerAmountMinor).toBe(800n);
  });
});

describe('refund reversal — specification §17', () => {
  it('mirrors the stored snapshot exactly rather than recomputing', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(2000n),
      agreement: { model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD' },
    });
    const reversal = reverseSnapshot(snapshot);
    expect(reversal.engineerAmountMinor).toBe(-1600n);
    expect(reversal.platformAmountMinor).toBe(-400n);
    expect(
      snapshot.engineerAmountMinor + reversal.engineerAmountMinor,
    ).toBe(0n);
  });
});

/**
 * The invariant that protects every settlement the platform will ever produce.
 */
describe('split invariants hold for every price and every rate', () => {
  it('engineer + platform always equals the net price, and neither is negative', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_000_000n }),
        fc.integer({ min: 0, max: 10_000 }),
        (priceMinor, engineerBp) => {
          const snapshot = computeCommissionSnapshot({
            listPrice: usd(priceMinor),
            agreement: { model: 'PERCENTAGE', engineerBp, currency: 'USD' },
          });
          expect(snapshot.engineerAmountMinor + snapshot.platformAmountMinor).toBe(priceMinor);
          expect(snapshot.engineerAmountMinor).toBeGreaterThanOrEqual(0n);
          expect(snapshot.platformAmountMinor).toBeGreaterThanOrEqual(0n);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('holds for fixed models too', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        (priceMinor, fixedMinor) => {
          const snapshot = computeCommissionSnapshot({
            listPrice: usd(priceMinor),
            agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: fixedMinor, currency: 'USD' },
          });
          expect(snapshot.engineerAmountMinor + snapshot.platformAmountMinor).toBe(priceMinor);
          expect(snapshot.engineerAmountMinor).toBeGreaterThanOrEqual(0n);
          expect(snapshot.platformAmountMinor).toBeGreaterThanOrEqual(0n);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('never throws a money invariant error for valid input', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.integer({ min: 0, max: 10_000 }),
        (priceMinor, bp) => {
          expect(() =>
            computeCommissionSnapshot({
              listPrice: usd(priceMinor),
              agreement: { model: 'PERCENTAGE', engineerBp: bp, currency: 'USD' },
            }),
          ).not.toThrow(MoneyInvariantError);
        },
      ),
      { numRuns: 500 },
    );
  });
});


/**
 * ===========================================================================
 * OPEN-1 — THE COMMISSION BASE WHEN A DISCOUNT EXISTS
 * ===========================================================================
 * The owner's decision: COMMISSION IS COMPUTED AFTER THE DISCOUNT. The pot to
 * divide is what the customer actually paid, so both sides bear the discount
 * in the proportion their agreement already names.
 *
 * These cases are written as the two rejected answers as much as the accepted
 * one: each states not only the number the decision produces but the numbers
 * it does NOT produce, so that a future edit that quietly switches the base
 * fails here with the wrong answer named rather than merely with a mismatch.
 * ===========================================================================
 */
describe('OPEN-1 — commission is computed after the discount', () => {
  const eightyTwenty: CommissionAgreement = {
    model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD',
  };

  it('the owner\u2019s worked example: 100 less 20 pays the engineer 64 and the platform 16', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(10_000n),
      discount: usd(2_000n),
      agreement: eightyTwenty,
    });

    expect(snapshot.netPriceMinor).toBe(8_000n);
    expect(snapshot.engineerAmountMinor).toBe(6_400n);
    expect(snapshot.platformAmountMinor).toBe(1_600n);

    // NOT the rejected answers:
    //   commission on the list price would be 8000 / 0 (engineer bears it all)
    //   the platform absorbing it would be 8000 / 0 the other way round
    expect(snapshot.engineerAmountMinor).not.toBe(8_000n);
    expect(snapshot.platformAmountMinor).not.toBe(2_000n);
  });

  it('records the discount on the snapshot rather than folding it into the price', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(10_000n),
      discount: usd(2_000n),
      agreement: eightyTwenty,
    });

    // The price the customer was quoted survives the sale. A snapshot that
    // stored only the discounted figure could not answer "what was it worth?"
    expect(snapshot.listPriceMinor).toBe(10_000n);
    expect(snapshot.discountMinor).toBe(2_000n);
    expect(snapshot.listPriceMinor - snapshot.discountMinor).toBe(snapshot.netPriceMinor);
  });

  it('a fixed engineer share is capped by the DISCOUNTED price, not the list price', () => {
    // The agreement promises the engineer 90; the sale only fetched 80. The
    // platform cannot pay out more than came in, so the share is clamped and
    // the owner is told the agreement needs revisiting.
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(10_000n),
      discount: usd(2_000n),
      agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: 9_000n, currency: 'USD' },
    });

    expect(snapshot.clamped).toBe(true);
    expect(snapshot.engineerAmountMinor).toBe(8_000n);
    expect(snapshot.platformAmountMinor).toBe(0n);
  });

  it('a discount equal to the price splits nothing, and splits it correctly', () => {
    // Permitted here and refused where it belongs: the ledger will not book a
    // sale of zero. The engine's job is to be total, not to hold that opinion.
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(10_000n),
      discount: usd(10_000n),
      agreement: eightyTwenty,
    });

    expect(snapshot.netPriceMinor).toBe(0n);
    expect(snapshot.engineerAmountMinor).toBe(0n);
    expect(snapshot.platformAmountMinor).toBe(0n);
  });

  it('a zero discount is bit-for-bit the sale that was made before OPEN-1', () => {
    const withZero = computeCommissionSnapshot({
      listPrice: usd(16_500n), discount: usd(0n), agreement: eightyTwenty,
    });
    const without = computeCommissionSnapshot({
      listPrice: usd(16_500n), agreement: eightyTwenty,
    });
    expect(withZero).toEqual(without);
  });

  it('the split re-sums to what was PAID for every price and every discount', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.integer({ min: 0, max: 10_000 }),
        (listPrice, rawDiscount, engineerBp) => {
          // A discount can never exceed the price, so the generator is folded
          // into the valid range rather than filtered — filtering would quietly
          // discard most of the large-price cases.
          const discount = listPrice === 0n ? 0n : rawDiscount % (listPrice + 1n);
          const snapshot = computeCommissionSnapshot({
            listPrice: usd(listPrice),
            discount: usd(discount),
            agreement: { model: 'PERCENTAGE', engineerBp, currency: 'USD' },
          });

          expect(snapshot.engineerAmountMinor + snapshot.platformAmountMinor).toBe(
            listPrice - discount,
          );
          expect(snapshot.engineerAmountMinor).toBeGreaterThanOrEqual(0n);
          expect(snapshot.platformAmountMinor).toBeGreaterThanOrEqual(0n);
        },
      ),
      { numRuns: 500 },
    );
  });
});
