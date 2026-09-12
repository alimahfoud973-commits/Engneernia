import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { refundEntry, refundPayoutEntry, saleEntry } from './entries';
import { assertEntryBalances } from './post';
import { LEDGER_ACCOUNTS } from './accounts';
import { MoneyInvariantError, RuleViolationError, ValidationError } from '@/lib/errors';

const CONTRIBUTOR_A = '11111111-1111-1111-1111-111111111111';
const CONTRIBUTOR_B = '22222222-2222-2222-2222-222222222222';

function sale(overrides: Partial<Parameters<typeof saleEntry>[0]> = {}) {
  return saleEntry({
    orderId: '33333333-3333-3333-3333-333333333333',
    orderNumber: 'EN-2026-000001',
    currency: 'USD',
    grossMinor: 2000n,
    platformMinor: 400n,
    contributorShares: [{ contributorId: CONTRIBUTOR_A, amountMinor: 1600n }],
    occurredAt: new Date('2026-09-15T10:00:00Z'),
    itemCount: 1,
    ...overrides,
  });
}

describe('the sale entry', () => {
  it('debits cash and credits both sides of the split', () => {
    const entry = sale();

    const cash = entry.lines.find((l) => l.account === LEDGER_ACCOUNTS.PLATFORM_CASH);
    const engineer = entry.lines.find((l) => l.account === LEDGER_ACCOUNTS.ENGINEER_PAYABLE);
    const revenue = entry.lines.find((l) => l.account === LEDGER_ACCOUNTS.PLATFORM_REVENUE);

    expect(cash?.amountMinor).toBe(2000n);
    expect(engineer?.amountMinor).toBe(-1600n);
    expect(revenue?.amountMinor).toBe(-400n);
    expect(engineer?.contributorId).toBe(CONTRIBUTOR_A);
  });

  it('balances to zero', () => {
    expect(() => assertEntryBalances(sale())).not.toThrow();
  });

  it('splits across several contributors without losing a cent', () => {
    const entry = sale({
      grossMinor: 1000n,
      platformMinor: 200n,
      contributorShares: [
        { contributorId: CONTRIBUTOR_A, amountMinor: 267n },
        { contributorId: CONTRIBUTOR_B, amountMinor: 533n },
      ],
    });
    expect(() => assertEntryBalances(entry)).not.toThrow();
    expect(entry.lines.reduce((t, l) => t + l.amountMinor, 0n)).toBe(0n);
  });

  it('omits a contributor whose frozen share is zero', () => {
    // A fixed-platform agreement can consume the whole price. The ledger
    // refuses a zero line, so the entry must simply not contain one.
    const entry = sale({
      grossMinor: 2000n,
      platformMinor: 2000n,
      contributorShares: [{ contributorId: CONTRIBUTOR_A, amountMinor: 0n }],
    });
    expect(entry.lines.some((l) => l.account === LEDGER_ACCOUNTS.ENGINEER_PAYABLE)).toBe(false);
    expect(() => assertEntryBalances(entry)).not.toThrow();
  });

  it('refuses a split that does not re-sum to what was paid', () => {
    expect(() => sale({ platformMinor: 401n })).toThrow(MoneyInvariantError);
  });

  it('refuses a negative contributor share', () => {
    expect(() =>
      sale({
        grossMinor: 2000n,
        platformMinor: 2100n,
        contributorShares: [{ contributorId: CONTRIBUTOR_A, amountMinor: -100n }],
      }),
    ).toThrow(MoneyInvariantError);
  });

  it('refuses a sale of nothing', () => {
    expect(() =>
      sale({ grossMinor: 0n, platformMinor: 0n, contributorShares: [] }),
    ).toThrow(RuleViolationError);
  });
});

describe('the refund entry', () => {
  it('is the sale with every sign flipped, against a liability not cash', () => {
    const refund = refundEntry({
      refundRequestId: '44444444-4444-4444-4444-444444444444',
      reference: 'RF-000001',
      orderNumber: 'EN-2026-000001',
      currency: 'USD',
      grossMinor: 2000n,
      platformMinor: 400n,
      contributorShares: [{ contributorId: CONTRIBUTOR_A, amountMinor: 1600n }],
      occurredAt: new Date('2026-10-02T10:00:00Z'),
    });

    const engineer = refund.lines.find((l) => l.account === LEDGER_ACCOUNTS.ENGINEER_PAYABLE);
    const reversed = refund.lines.find(
      (l) => l.account === LEDGER_ACCOUNTS.PLATFORM_REVENUE_REVERSED,
    );
    const owedBack = refund.lines.find(
      (l) => l.account === LEDGER_ACCOUNTS.CUSTOMER_REFUNDS_PAYABLE,
    );

    // Clawed back from the engineer, taken off revenue, owed to the customer.
    expect(engineer?.amountMinor).toBe(1600n);
    expect(reversed?.amountMinor).toBe(400n);
    expect(owedBack?.amountMinor).toBe(-2000n);

    // Approving a refund must NOT move cash: the transfer is a separate act.
    expect(refund.lines.some((l) => l.account === LEDGER_ACCOUNTS.PLATFORM_CASH)).toBe(false);

    expect(() => assertEntryBalances(refund)).not.toThrow();
  });

  it('refuses to reverse figures that do not match the sale', () => {
    expect(() =>
      refundEntry({
        refundRequestId: '44444444-4444-4444-4444-444444444444',
        reference: 'RF-000002',
        orderNumber: 'EN-2026-000001',
        currency: 'USD',
        grossMinor: 2000n,
        platformMinor: 400n,
        contributorShares: [{ contributorId: CONTRIBUTOR_A, amountMinor: 1599n }],
        occurredAt: new Date(),
      }),
    ).toThrow(MoneyInvariantError);
  });

  it('the payout moves the cash and discharges the obligation', () => {
    const payout = refundPayoutEntry({
      refundRequestId: '44444444-4444-4444-4444-444444444444',
      reference: 'RF-000001',
      currency: 'USD',
      grossMinor: 2000n,
      occurredAt: new Date(),
    });

    const owedBack = payout.lines.find(
      (l) => l.account === LEDGER_ACCOUNTS.CUSTOMER_REFUNDS_PAYABLE,
    );
    const cash = payout.lines.find((l) => l.account === LEDGER_ACCOUNTS.PLATFORM_CASH);

    expect(owedBack?.amountMinor).toBe(2000n);
    expect(cash?.amountMinor).toBe(-2000n);
    expect(() => assertEntryBalances(payout)).not.toThrow();
  });
});

describe('a sale and its full reversal cancel out exactly', () => {
  it('for any split the money rules can produce', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 4 }),
        (gross, engineerBp, authorCount) => {
          // One side is rounded, the other is the remainder — the P0 rule.
          const platform = (gross * BigInt(10_000 - engineerBp)) / 10_000n;
          const engineer = gross - platform;

          // Any apportionment among the authors, exact by construction.
          const shares: Array<{ contributorId: string; amountMinor: bigint }> = [];
          let remaining = engineer;
          for (let index = 0; index < authorCount - 1; index += 1) {
            const part = remaining / BigInt(authorCount - index);
            shares.push({ contributorId: `c-${index}`, amountMinor: part });
            remaining -= part;
          }
          shares.push({ contributorId: `c-${authorCount - 1}`, amountMinor: remaining });

          const saleLines = saleEntry({
            orderId: 'o', orderNumber: 'EN-1', currency: 'USD',
            grossMinor: gross, platformMinor: platform,
            contributorShares: shares, occurredAt: new Date(), itemCount: 1,
          });

          const refundLines = refundEntry({
            refundRequestId: 'r', reference: 'RF-1', orderNumber: 'EN-1', currency: 'USD',
            grossMinor: gross, platformMinor: platform,
            contributorShares: shares, occurredAt: new Date(),
          });

          // Both balance, and the engineer's side nets to zero across the two:
          // whatever rounding produced at sale time is reversed identically,
          // because no division happens the second time.
          const engineerNet = [...saleLines.lines, ...refundLines.lines]
            .filter((l) => l.account === LEDGER_ACCOUNTS.ENGINEER_PAYABLE)
            .reduce((total, line) => total + line.amountMinor, 0n);

          return (
            saleLines.lines.reduce((t, l) => t + l.amountMinor, 0n) === 0n &&
            refundLines.lines.reduce((t, l) => t + l.amountMinor, 0n) === 0n &&
            engineerNet === 0n
          );
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('the posting guard', () => {
  it('refuses an entry with one line', () => {
    expect(() =>
      assertEntryBalances({
        kind: 'ADJUSTMENT', currency: 'USD', occurredAt: new Date(),
        referenceType: 'manual',
        lines: [{ account: LEDGER_ACCOUNTS.PLATFORM_CASH, amountMinor: 100n }],
      }),
    ).toThrow(ValidationError);
  });

  it('refuses a contributor on an account that does not take one', () => {
    expect(() =>
      assertEntryBalances({
        kind: 'ADJUSTMENT', currency: 'USD', occurredAt: new Date(),
        referenceType: 'manual',
        lines: [
          { account: LEDGER_ACCOUNTS.PLATFORM_CASH, contributorId: CONTRIBUTOR_A, amountMinor: 100n },
          { account: LEDGER_ACCOUNTS.PLATFORM_REVENUE, amountMinor: -100n },
        ],
      }),
    ).toThrow(ValidationError);
  });

  it('refuses the engineer payable without a contributor', () => {
    expect(() =>
      assertEntryBalances({
        kind: 'ADJUSTMENT', currency: 'USD', occurredAt: new Date(),
        referenceType: 'manual',
        lines: [
          { account: LEDGER_ACCOUNTS.ENGINEER_PAYABLE, amountMinor: 100n },
          { account: LEDGER_ACCOUNTS.PLATFORM_CASH, amountMinor: -100n },
        ],
      }),
    ).toThrow(ValidationError);
  });

  it('refuses an entry that does not balance', () => {
    expect(() =>
      assertEntryBalances({
        kind: 'SALE', currency: 'USD', occurredAt: new Date(), referenceType: 'order',
        lines: [
          { account: LEDGER_ACCOUNTS.PLATFORM_CASH, amountMinor: 2000n },
          { account: LEDGER_ACCOUNTS.PLATFORM_REVENUE, amountMinor: -1999n },
        ],
      }),
    ).toThrow(MoneyInvariantError);
  });
});
