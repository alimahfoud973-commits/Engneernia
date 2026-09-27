import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError, ValidationError } from '@/lib/errors';

/**
 * ===========================================================================
 * THE REFUSE → CORRECT → RETRY CYCLE, THROUGH THE REAL ACTIONS (Stage 3, W11)
 * ===========================================================================
 * `admin-forms-keep-values.test.ts` checks the SHAPE of every admin form and
 * action. This file runs the cycle an owner actually goes through, on the five
 * forms where retyping costs the most — product, price, commission, payment
 * method, engineer:
 *
 *   valid           → success, and nothing is echoed (the form resets as before);
 *   invalid         → refusal, a message, and every typed value handed back;
 *   store refusal   → the constraint the store enforces (a taken slug, a taken
 *                     code, an unknown account) refuses, nothing is stored,
 *                     and the typed values come back;
 *   retry           → the form is resubmitted from the echoed values with ONE
 *                     field corrected, and succeeds with the rest untouched.
 *
 * The session and the stores are replaced by fakes: what is under test is the
 * action between them. That the database refuses and stores nothing is proven
 * against PostgreSQL by the stores' own integration tests, and in the browser
 * on a production build (PROJECT_STATE, W11).
 * ===========================================================================
 */

const OWNER = { kind: 'user', userId: 'owner', role: 'OWNER' } as const;

vi.mock('@/auth/current', () => ({ requireOwner: vi.fn(async () => OWNER) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { to });
  }),
}));

/** Fake stores: a write either lands whole or throws and leaves them as they were. */
const store = {
  products: new Map<string, Record<string, unknown>>(),
  prices: [] as Array<Record<string, unknown>>,
  agreements: [] as Array<Record<string, unknown>>,
  methods: new Map<string, Record<string, unknown>>(),
  engineers: new Map<string, Record<string, unknown>>(),
  accounts: new Set<string>(),
};

vi.mock('@/catalog/products', () => ({
  createProduct: vi.fn(async (_a: unknown, input: { slug: string }) => {
    if (store.products.has(input.slug)) {
      throw new ConflictError('هذا العنوان اللطيف مستخدم لمنتج آخر. اختر عنواناً آخر.');
    }
    store.products.set(input.slug, input);
    return { productId: '00000000-0000-4000-8000-000000000001' };
  }),
  changeProductPrice: vi.fn(async (_a: unknown, input: Record<string, unknown>) => {
    store.prices.push(input);
  }),
  changeProductStatus: vi.fn(),
  setProductContributors: vi.fn(),
  updateProductDetails: vi.fn(),
}));
vi.mock('@/media/ingest', () => ({ ingestProductFile: vi.fn() }));

vi.mock('@/finance/commissions', async () => {
  const { ValidationError: VE } = await import('@/lib/errors');
  return {
    // The real parser's contract, for the one input this test gives it.
    parsePercentToBp: (input: string) => {
      // Whole percents only: the inputs here are 70 and 150.
      if (!/^\d{1,3}$/.test(input) || Number(input) > 100) throw new VE('النسبة يجب أن تكون بين 0 و 100');
      return Number(input) * 100;
    },
    saveCommissionAgreement: vi.fn(async (_a: unknown, input: { contributorId: string }) => {
      if (!store.engineers.has(input.contributorId)) {
        const { NotFoundError } = await import('@/lib/errors');
        throw new NotFoundError('Contributor');
      }
      store.agreements.push(input);
    }),
  };
});

vi.mock('@/payments/admin', () => ({
  createPaymentMethod: vi.fn(async (_a: unknown, input: { code: string }) => {
    if (store.methods.has(input.code)) throw new ConflictError('يوجد طريقة دفع بهذا الرمز مسبقاً');
    store.methods.set(input.code, input);
  }),
  updatePaymentMethod: vi.fn(),
  setPaymentMethodActive: vi.fn(),
}));

vi.mock('@/contributors/admin', () => ({
  addEngineer: vi.fn(async (_a: unknown, input: { email: string; publicSlug: string }) => {
    if (!store.accounts.has(input.email)) {
      throw new ValidationError('لا يوجد حساب بهذا البريد. اطلب من المهندس إنشاء حساب بهذا البريد نفسه، ثم أضفه هنا.');
    }
    store.engineers.set(input.publicSlug, input);
  }),
  updateEngineer: vi.fn(),
  setEngineerActive: vi.fn(),
}));

const { createProductAction, changePriceAction } = await import('@/catalog/product-actions');
const { saveCommissionAction } = await import('@/finance/commission-actions');
const { createPaymentMethodAction } = await import('@/payments/admin-actions');
const { addEngineerAction } = await import('@/contributors/engineer-actions');

const PRODUCT = '00000000-0000-4000-8000-000000000001';
const DISCIPLINE = '00000000-0000-4000-8000-0000000000d1';
const ENGINEER = '00000000-0000-4000-8000-0000000000e1';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  // What Next adds to every action POST: it is not the user's and must not echo.
  data.set('$ACTION_ID_abc', '');
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** Resubmit from what the refusal echoed, correcting only `fix`. */
function retry(values: Readonly<Record<string, string>> | undefined, fix: Record<string, string>): FormData {
  expect(values).toBeDefined();
  return form({ ...values, ...fix });
}

const INITIAL = { error: null };

beforeEach(() => {
  store.products.clear();
  store.prices.length = 0;
  store.agreements.length = 0;
  store.methods.clear();
  store.engineers.clear();
  store.accounts.clear();
});

describe('W11 — product', () => {
  const typed = {
    titleAr: 'جداول تسليح', slug: 'rebar-tables', subtitleAr: 'وصف', disciplineId: DISCIPLINE,
    categoryId: '', fileType: 'EXCEL', level: 'ADVANCED', currency: 'USD',
  };

  it('valid → the product is created and the owner is taken to it', async () => {
    await expect(createProductAction(INITIAL, form(typed))).rejects.toMatchObject({ to: `/admin/products/${PRODUCT}` });
    expect(store.products.get('rebar-tables')).toMatchObject({ titleAr: 'جداول تسليح', fileType: 'EXCEL' });
  });

  it('invalid → refused with a message, every field handed back', async () => {
    const state = await createProductAction(INITIAL, form({ ...typed, titleAr: 'x' }));
    expect(state.error).toBeTruthy();
    expect(state.values).toEqual({ ...typed, titleAr: 'x' });
    expect(store.products.size).toBe(0);
  });

  it('a taken slug → refused by the store, nothing stored, values kept; fixing the slug alone succeeds', async () => {
    store.products.set('rebar-tables', { titleAr: 'قديم' });
    const refused = await createProductAction(INITIAL, form(typed));
    expect(refused.error).toContain('مستخدم لمنتج آخر');
    expect(refused.values).toEqual(typed);
    expect(store.products.size).toBe(1);

    await expect(createProductAction(refused, retry(refused.values, { slug: 'rebar-tables-2' }))).rejects.toMatchObject({
      to: `/admin/products/${PRODUCT}`,
    });
    expect(store.products.get('rebar-tables-2')).toMatchObject({
      titleAr: 'جداول تسليح', subtitleAr: 'وصف', fileType: 'EXCEL', level: 'ADVANCED',
    });
  });
});

describe('W11 — price', () => {
  const typed = { productId: PRODUCT, amount: '35.25', currency: 'USD', reason: 'تحديث الأسعار' };

  it('valid → saved, nothing echoed', async () => {
    const state = await changePriceAction(INITIAL, form(typed));
    expect(state).toEqual({ error: null, ok: true });
    expect(store.prices).toEqual([{ productId: PRODUCT, newAmountMinor: 3525n, currency: 'USD', reason: 'تحديث الأسعار' }]);
  });

  it('three decimals → refused in Arabic, nothing saved, values kept; correcting the amount alone keeps the reason', async () => {
    const refused = await changePriceAction(INITIAL, form({ ...typed, amount: '35.255' }));
    expect(refused.error).toContain('خانتين عشريتين');
    expect(refused.values).toEqual({ ...typed, amount: '35.255' });
    expect(store.prices).toHaveLength(0);

    const retried = await changePriceAction(refused, retry(refused.values, { amount: '35.25' }));
    expect(retried).toEqual({ error: null, ok: true });
    expect(store.prices[0]).toMatchObject({ newAmountMinor: 3525n, reason: 'تحديث الأسعار' });
  });
});

describe('W11 — commission (an engineer\'s share)', () => {
  const typed = { contributorId: ENGINEER, productId: '', model: 'PERCENTAGE', percent: '70', amount: '', currency: 'USD', note: 'اتفاق جديد' };

  it('valid → saved, nothing echoed', async () => {
    store.engineers.set(ENGINEER, {});
    expect(await saveCommissionAction(INITIAL, form(typed))).toEqual({ error: null, ok: true });
    expect(store.agreements).toHaveLength(1);
  });

  it('150% → refused, nothing saved, values kept; correcting the percent alone keeps the engineer and note', async () => {
    store.engineers.set(ENGINEER, {});
    const refused = await saveCommissionAction(INITIAL, form({ ...typed, percent: '150' }));
    expect(refused.error).toContain('بين 0 و 100');
    expect(refused.values).toEqual({ ...typed, percent: '150' });
    expect(store.agreements).toHaveLength(0);

    expect(await saveCommissionAction(refused, retry(refused.values, { percent: '70' }))).toEqual({ error: null, ok: true });
    expect(store.agreements[0]).toMatchObject({ contributorId: ENGINEER, note: 'اتفاق جديد', agreement: { engineerBp: 7000 } });
  });

  it('an engineer the store does not know → refused, nothing saved, values kept', async () => {
    const refused = await saveCommissionAction(INITIAL, form(typed));
    expect(refused.error).toBeTruthy();
    expect(refused.values).toEqual(typed);
    expect(store.agreements).toHaveLength(0);
  });
});

describe('W11 — payment method', () => {
  const typed = {
    code: 'bank-transfer', type: 'MANUAL', displayNameAr: 'حوالة بنكية', instructionsAr: 'حوّل إلى الحساب',
    countries: 'SY', currencies: 'USD', sortOrder: '20', requiresProof: 'on',
  };

  it('valid → created, nothing echoed', async () => {
    expect(await createPaymentMethodAction(INITIAL, form(typed))).toEqual({ error: null, ok: true });
    expect(store.methods.get('bank-transfer')).toMatchObject({ displayNameAr: 'حوالة بنكية', requiresProof: true });
  });

  it('a non-numeric sort order → refused, nothing created, values kept (the checkbox too)', async () => {
    const refused = await createPaymentMethodAction(INITIAL, form({ ...typed, sortOrder: 'أولاً' }));
    expect(refused.error).toBeTruthy();
    expect(refused.values).toEqual({ ...typed, sortOrder: 'أولاً' });
    expect(store.methods.size).toBe(0);
  });

  it('a taken code → refused by the store, nothing created, values kept; changing the code alone succeeds', async () => {
    store.methods.set('bank-transfer', {});
    const refused = await createPaymentMethodAction(INITIAL, form(typed));
    expect(refused.error).toBe('يوجد طريقة دفع بهذا الرمز مسبقاً');
    expect(refused.values).toEqual(typed);
    expect(store.methods.size).toBe(1);

    expect(await createPaymentMethodAction(refused, retry(refused.values, { code: 'bank-transfer-2' }))).toEqual({ error: null, ok: true });
    expect(store.methods.get('bank-transfer-2')).toMatchObject({
      displayNameAr: 'حوالة بنكية', instructionsAr: 'حوّل إلى الحساب', sortOrder: 20, requiresProof: true,
    });
  });
});

describe('W11 — engineer management', () => {
  const typed = {
    email: 'eng@test.local', displayName: 'م. سامر', publicSlug: 'samer', settlementCode: 'SAMER',
    disciplineId: DISCIPLINE, specialization: 'خرسانة', bio: '',
  };

  it('valid → added, nothing echoed', async () => {
    store.accounts.add('eng@test.local');
    expect(await addEngineerAction(INITIAL, form(typed))).toEqual({ error: null, ok: true });
    expect(store.engineers.has('samer')).toBe(true);
  });

  it('a malformed email → refused, values kept', async () => {
    const refused = await addEngineerAction(INITIAL, form({ ...typed, email: 'not-an-email' }));
    expect(refused.error).toBeTruthy();
    expect(refused.values).toEqual({ ...typed, email: 'not-an-email' });
    expect(store.engineers.size).toBe(0);
  });

  it('no account yet → refused with the next step, nothing added; once the account exists the same submission succeeds', async () => {
    const refused = await addEngineerAction(INITIAL, form(typed));
    expect(refused.error).toContain('لا يوجد حساب بهذا البريد');
    expect(refused.values).toEqual(typed);
    expect(store.engineers.size).toBe(0);

    store.accounts.add('eng@test.local');
    expect(await addEngineerAction(refused, retry(refused.values, {}))).toEqual({ error: null, ok: true });
    expect(store.engineers.get('samer')).toMatchObject({ displayName: 'م. سامر', settlementCode: 'SAMER', specialization: 'خرسانة' });
  });
});
