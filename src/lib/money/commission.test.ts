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

  it('a fixed engineer share shrinks with the discount in its original proportion (D-02)', () => {
    // 90 fixed on a price of 100 is 90% of the price. The sale fetched 80, so
    // the engineer takes 90% of 80 and the platform 10% of it — the discount
    // is borne by both sides, not by the platform alone (the pre-D-02 answer
    // was 80 / 0, which this replaces).
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(10_000n),
      discount: usd(2_000n),
      agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: 9_000n, currency: 'USD' },
    });

    expect(snapshot.clamped).toBe(false);
    expect(snapshot.requestedMinor).toBe(7_200n);
    expect(snapshot.engineerAmountMinor).toBe(7_200n);
    expect(snapshot.platformAmountMinor).toBe(800n);
  });

  it('a fixed share larger than the price it is quoted against is capped, and says by how much (S5-02)', () => {
    const snapshot = computeCommissionSnapshot({
      listPrice: usd(10_000n),
      discount: usd(2_000n),
      agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: 12_000n, currency: 'USD' },
    });

    expect(snapshot.clamped).toBe(true);
    // 120% of what was paid was asked for; all of it is what could be given.
    expect(snapshot.requestedMinor).toBe(9_600n);
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

/**
 * ===========================================================================
 * STAGE 5 — OWNER DECISIONS D-02 AND D-03, AND THE CAP (S5-02)
 * ===========================================================================
 * The owner's own examples, as written, then the properties that make them
 * hold for every price rather than only for these.
 * ===========================================================================
 */
describe('Stage 5 — discounts and fixed amounts keep their original proportion', () => {
  const pct30: CommissionAgreement = { model: 'PERCENTAGE', engineerBp: 3_000, currency: 'USD' };

  it('Scenario A — $100 paid at 30% engineer: engineer $30, platform $70', () => {
    const s = computeCommissionSnapshot({ listPrice: usd(10_000n), agreement: pct30 });
    expect(s.engineerAmountMinor).toBe(3_000n);
    expect(s.platformAmountMinor).toBe(7_000n);
  });

  it('Scenario B — $100 list, $50 paid, 70/30: platform $35, engineer $15', () => {
    const s = computeCommissionSnapshot({
      listPrice: usd(10_000n), discount: usd(5_000n), agreement: pct30,
    });
    expect(s.netPriceMinor).toBe(5_000n);
    expect(s.engineerAmountMinor).toBe(1_500n);
    expect(s.platformAmountMinor).toBe(3_500n);
  });

  it('Scenario B, fixed — $30 fixed on $100 is 30%, so a $50 sale pays $15 / $35', () => {
    const s = computeCommissionSnapshot({
      listPrice: usd(10_000n),
      discount: usd(5_000n),
      agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: 3_000n, currency: 'USD' },
    });
    expect(s.engineerAmountMinor).toBe(1_500n);
    expect(s.platformAmountMinor).toBe(3_500n);
    expect(s.clamped).toBe(false);
  });

  it('Scenario B, fixed platform — $70 fixed for the platform on $100 pays it $35 of $50', () => {
    const s = computeCommissionSnapshot({
      listPrice: usd(10_000n),
      discount: usd(5_000n),
      agreement: { model: 'FIXED_PLATFORM', platformFixedMinor: 7_000n, currency: 'USD' },
    });
    expect(s.platformAmountMinor).toBe(3_500n);
    expect(s.engineerAmountMinor).toBe(1_500n);
  });

  it('Scenario C — $20 fixed on a co-authored product is shared 60/40: $12 and $8', () => {
    // The sale path slices the pot by contribution first, then applies each
    // engineer's terms to THEIR slice against the product's whole price.
    const agreement: CommissionAgreement = {
      model: 'FIXED_ENGINEER', engineerFixedMinor: 2_000n, currency: 'USD',
    };
    const a = computeCommissionSnapshot({
      listPrice: usd(6_000n), agreement, fixedBaseMinor: 10_000n,
    });
    const b = computeCommissionSnapshot({
      listPrice: usd(4_000n), agreement, fixedBaseMinor: 10_000n,
    });
    expect(a.engineerAmountMinor).toBe(1_200n);
    expect(b.engineerAmountMinor).toBe(800n);
    expect(a.engineerAmountMinor + b.engineerAmountMinor).toBe(2_000n);
    expect(a.platformAmountMinor + b.platformAmountMinor).toBe(8_000n);
  });

  it('Scenario D — a fixed amount above the price is capped: nothing negative, nothing above what was paid', () => {
    const s = computeCommissionSnapshot({
      listPrice: usd(1_000n),
      agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: 3_000n, currency: 'USD' },
    });
    expect(s.clamped).toBe(true);
    expect(s.requestedMinor).toBe(3_000n);
    expect(s.engineerAmountMinor).toBe(1_000n);
    expect(s.platformAmountMinor).toBe(0n);
  });

  it('a fixed amount equal to the price is not a cap', () => {
    const s = computeCommissionSnapshot({
      listPrice: usd(1_000n),
      agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: 1_000n, currency: 'USD' },
    });
    expect(s.clamped).toBe(false);
    expect(s.engineerAmountMinor).toBe(1_000n);
  });

  it('a free product pays nothing and cannot divide by its zero price', () => {
    const s = computeCommissionSnapshot({
      listPrice: usd(0n),
      agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: 500n, currency: 'USD' },
    });
    expect(s.engineerAmountMinor).toBe(0n);
    expect(s.platformAmountMinor).toBe(0n);
    expect(s.clamped).toBe(true);
  });

  it('a percentage agreement records no requested amount', () => {
    const s = computeCommissionSnapshot({ listPrice: usd(10_000n), agreement: pct30 });
    expect(s.requestedMinor).toBeNull();
  });

  it('property — every fixed split re-adds to the pot, is never negative, and keeps its proportion within one unit', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 20_000_000n }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.constantFrom('FIXED_ENGINEER' as const, 'FIXED_PLATFORM' as const),
        (list, fixed, discountBp, model) => {
          const discount = (list * BigInt(discountBp)) / 10_000n;
          const agreement: CommissionAgreement = model === 'FIXED_ENGINEER'
            ? { model, engineerFixedMinor: fixed, currency: 'USD' }
            : { model, platformFixedMinor: fixed, currency: 'USD' };
          const s = computeCommissionSnapshot({
            listPrice: usd(list), discount: usd(discount), agreement,
          });
          const net = list - discount;
          expect(s.engineerAmountMinor + s.platformAmountMinor).toBe(net);
          expect(s.engineerAmountMinor >= 0n && s.platformAmountMinor >= 0n).toBe(true);
          expect(s.clamped).toBe(fixed > list);
          const fixedSide = model === 'FIXED_ENGINEER' ? s.engineerAmountMinor : s.platformAmountMinor;
          if (fixed <= list) {
            // fixedSide ≈ fixed × net ÷ list, rounded once.
            const exact2 = 2n * fixed * net;
            const got2 = 2n * fixedSide * list;
            expect(got2 - exact2 <= list && exact2 - got2 <= list).toBe(true);
          } else {
            expect(fixedSide).toBe(net);
          }
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

/**
 * ===========================================================================
 * STAGE 5 — THE OWNER'S FINAL DECISIONS ON FIXED COMMISSIONS
 * ===========================================================================
 * Prices are final prices, tax included; these cases run at a zero tax rate
 * so the owner's figures are the figures on the snapshot.
 * ===========================================================================
 */
describe('Stage 5 final — fixed commissions under a discount, and both fixed at once', () => {
  it('Test B — fixed platform $20 on $100, paid $50: platform $10', () => {
    const s = computeCommissionSnapshot({
      listPrice: usd(10_000n), discount: usd(5_000n),
      agreement: { model: 'FIXED_PLATFORM', platformFixedMinor: 2_000n, currency: 'USD' },
    });
    expect(s.platformAmountMinor).toBe(1_000n);
    expect(s.engineerAmountMinor).toBe(4_000n);
    expect(s.requestedPlatformMinor).toBe(1_000n);
    expect(s.requestedEngineerMinor).toBeNull();
  });

  it('Test C — fixed engineer $30 on $100, paid $50: engineer $15', () => {
    const s = computeCommissionSnapshot({
      listPrice: usd(10_000n), discount: usd(5_000n),
      agreement: { model: 'FIXED_ENGINEER', engineerFixedMinor: 3_000n, currency: 'USD' },
    });
    expect(s.engineerAmountMinor).toBe(1_500n);
    expect(s.requestedEngineerMinor).toBe(1_500n);
  });

  it('Test D — fixed engineer $20 shared 60/40: $12 and $8, and $6 and $4 at half price', () => {
    const agreement: CommissionAgreement = { model: 'FIXED_ENGINEER', engineerFixedMinor: 2_000n, currency: 'USD' };
    const at = (sliceMinor: bigint) =>
      computeCommissionSnapshot({ listPrice: usd(sliceMinor), agreement, fixedBaseMinor: 10_000n });
    expect(at(6_000n).engineerAmountMinor).toBe(1_200n);
    expect(at(4_000n).engineerAmountMinor).toBe(800n);
    // Half price: the slices of the $50 paid are $30 and $20.
    expect(at(3_000n).engineerAmountMinor).toBe(600n);
    expect(at(2_000n).engineerAmountMinor).toBe(400n);
  });

  it('Test E — platform $20 + engineer $30 on $100, paid $50: fixed $10 + $15 = $25, the $25 left shared 20:30', () => {
    const s = computeCommissionSnapshot({
      listPrice: usd(10_000n), discount: usd(5_000n),
      agreement: { model: 'FIXED_BOTH', engineerFixedMinor: 3_000n, platformFixedMinor: 2_000n, currency: 'USD' },
    });
    // The fixed commissions after the discount.
    expect(s.requestedPlatformMinor).toBe(1_000n);
    expect(s.requestedEngineerMinor).toBe(1_500n);
    expect(s.requestedMinor).toBe(2_500n);
    // What is booked: the fixed amounts plus the remainder in their ratio.
    expect(s.platformAmountMinor).toBe(2_000n);
    expect(s.engineerAmountMinor).toBe(3_000n);
    expect(s.engineerAmountMinor + s.platformAmountMinor).toBe(5_000n);
    expect(s.clamped).toBe(false);
    expect(s.engineerFixedMinor).toBe(3_000n);
    expect(s.platformFixedMinor).toBe(2_000n);
  });

  it('both fixed amounts above the price: the sale completes, capped, nothing negative or above what was paid', () => {
    const s = computeCommissionSnapshot({
      listPrice: usd(1_000n),
      agreement: { model: 'FIXED_BOTH', engineerFixedMinor: 3_000n, platformFixedMinor: 2_000n, currency: 'USD' },
    });
    expect(s.clamped).toBe(true);
    expect(s.requestedMinor).toBe(5_000n);
    expect(s.engineerAmountMinor).toBe(600n);
    expect(s.platformAmountMinor).toBe(400n);
    expect(s.engineerAmountMinor + s.platformAmountMinor).toBe(1_000n);
  });

  it('refuses a combined agreement with nothing to divide by, or a negative side', () => {
    const run = (e: bigint, p: bigint) => () => computeCommissionSnapshot({
      listPrice: usd(1_000n),
      agreement: { model: 'FIXED_BOTH', engineerFixedMinor: e, platformFixedMinor: p, currency: 'USD' },
    });
    expect(run(0n, 0n)).toThrow(ValidationError);
    expect(run(-1n, 100n)).toThrow(ValidationError);
  });

  it('property — a combined agreement always re-adds to the pot, in the ratio of its amounts, never negative', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 5_000_000n }),
        fc.bigInt({ min: 0n, max: 5_000_000n }),
        fc.integer({ min: 0, max: 10_000 }),
        (list, e, p, discountBp) => {
          fc.pre(e + p > 0n);
          const discount = (list * BigInt(discountBp)) / 10_000n;
          const s = computeCommissionSnapshot({
            listPrice: usd(list), discount: usd(discount),
            agreement: { model: 'FIXED_BOTH', engineerFixedMinor: e, platformFixedMinor: p, currency: 'USD' },
          });
          const net = list - discount;
          expect(s.engineerAmountMinor + s.platformAmountMinor).toBe(net);
          expect(s.engineerAmountMinor >= 0n && s.platformAmountMinor >= 0n).toBe(true);
          // engineer ≈ net × e / (e + p), rounded once
          const twice = 2n * s.engineerAmountMinor * (e + p) - 2n * net * e;
          expect(twice <= e + p && -twice <= e + p).toBe(true);
          expect(s.clamped).toBe(e + p > list);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
