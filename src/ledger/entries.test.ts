import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { saleEntry } from './entries';
import { assertEntryBalances } from './post';
import { LEDGER_ACCOUNTS } from './accounts';
import { MoneyInvariantError, RuleViolationError, ValidationError } from '@/lib/errors';
import { extractTax } from '@/lib/money/tax';
import { money } from '@/lib/money/money';

const CONTRIBUTOR_A = '11111111-1111-1111-1111-111111111111';
const CONTRIBUTOR_B = '22222222-2222-2222-2222-222222222222';

function sale(overrides: Partial<Parameters<typeof saleEntry>[0]> = {}) {
  return saleEntry({
    orderId: '33333333-3333-3333-3333-333333333333',
    orderNumber: 'EN-2026-000001',
    currency: 'USD',
    grossMinor: 2000n,
    platformMinor: 400n,
    // The platform ships at rate zero (OPEN-9), so the default fixture is a
    // sale with no tax — the shape every existing assertion was written for.
    taxMinor: 0n,
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

describe('a sale entry balances for any split the money rules can produce', () => {
  it('holds across prices, rates, author counts AND tax rates', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 4 }),
        // Tax is generated too (OPEN-9): 0 is the shipped state, and the rest
        // is every rate the setting accepts. A tax that broke the books at
        // some unlucky price is exactly the defect this has to rule out.
        fc.integer({ min: 0, max: 10_000 }),
        (gross, engineerBp, authorCount, taxBp) => {
          // The state's portion comes out first, and only then is the rest
          // divided — the owner's decision, exercised here rather than assumed.
          const { taxMinor, netMinor } = extractTax(money(gross, 'USD'), taxBp);

          // One side is rounded, the other is the remainder — the P0 rule.
          const platform = (netMinor * BigInt(10_000 - engineerBp)) / 10_000n;
          const engineer = netMinor - platform;

          // Any apportionment among the authors, exact by construction.
          const shares: Array<{ contributorId: string; amountMinor: bigint }> = [];
          let remaining = engineer;
          for (let index = 0; index < authorCount - 1; index += 1) {
            const part = remaining / BigInt(authorCount - index);
            shares.push({ contributorId: `c-${index}`, amountMinor: part });
            remaining -= part;
          }
          shares.push({ contributorId: `c-${authorCount - 1}`, amountMinor: remaining });

          const entry = saleEntry({
            orderId: 'o', orderNumber: 'EN-1', currency: 'USD',
            grossMinor: gross, platformMinor: platform, taxMinor,
            contributorShares: shares, occurredAt: new Date(), itemCount: 1,
          });

          // The books balance, and the cash line equals what the customer paid
          // however the split rounded.
          const cash = entry.lines
            .filter((line) => line.account === LEDGER_ACCOUNTS.PLATFORM_CASH)
            .reduce((total, line) => total + line.amountMinor, 0n);

          const tax = entry.lines
            .filter((line) => line.account === LEDGER_ACCOUNTS.TAX_PAYABLE)
            .reduce((total, line) => total + line.amountMinor, 0n);

          return entry.lines.reduce((t, l) => t + l.amountMinor, 0n) === 0n
            && cash === gross
            // The state's portion is booked in full and to its own account:
            // never rolled into revenue, never split with anybody.
            && tax === -taxMinor;
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('at rate zero the entry is what it always was', () => {
  it('produces no tax line at all', () => {
    const entry = sale({ taxMinor: 0n });
    expect(entry.lines.some((l) => l.account === LEDGER_ACCOUNTS.TAX_PAYABLE)).toBe(false);
  });

  it('produces one once a rate is set, credited to its own account', () => {
    // 2000 gross containing 300 of tax: 1700 left, split 1360/340.
    const entry = sale({
      grossMinor: 2000n, taxMinor: 300n, platformMinor: 340n,
      contributorShares: [{ contributorId: CONTRIBUTOR_A, amountMinor: 1360n }],
    });
    const tax = entry.lines.find((l) => l.account === LEDGER_ACCOUNTS.TAX_PAYABLE);
    expect(tax?.amountMinor).toBe(-300n);
    expect(entry.lines.reduce((t, l) => t + l.amountMinor, 0n)).toBe(0n);
  });

  it('refuses a split that does not re-add to what was paid, tax included', () => {
    expect(() =>
      sale({
        grossMinor: 2000n, taxMinor: 300n, platformMinor: 400n,
        contributorShares: [{ contributorId: CONTRIBUTOR_A, amountMinor: 1600n }],
      }),
    ).toThrow(MoneyInvariantError);
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
