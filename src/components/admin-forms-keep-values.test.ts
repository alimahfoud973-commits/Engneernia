import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ===========================================================================
 * A REFUSED ADMIN FORM KEEPS WHAT THE OWNER TYPED (Stage 3, W11)
 * ===========================================================================
 * React resets a `<form action={fn}>` after every submission, whatever the
 * action returns. Our actions refuse by RETURNING `{ error }`, so every admin
 * form came back empty — or back to the stored value — after a refusal, and
 * the owner typed a product, a price, a commission or a payment method again
 * because of one mistyped field.
 *
 * The remedy has two halves, and each is useless without the other:
 *
 *   1. the action returns `values: submittedValues(formData)` with EVERY
 *      refusal — a refusal without them resets the form as before;
 *   2. the form is keyed with `formKey(state)` and its fields read those
 *      values as their `defaultValue` — without the key a controlled `<select>`
 *      shows the option from page load while its state says otherwise.
 *
 * This guard reads every component an admin page imports, finds each one that
 * holds `useActionState`, and checks both halves. A new admin form that forgets
 * either fails here, not in front of the owner.
 * ===========================================================================
 */

const ROOT = process.cwd();
const ADMIN_PAGES = join(ROOT, 'src/app/[locale]/admin');

/**
 * Stateful components on admin pages that deliberately do not echo values.
 * Each has a reason that makes echoing meaningless — not merely inconvenient.
 */
const EXEMPT_COMPONENTS: Record<string, string> = {
  // Hidden fields and a confirmation box: there is nothing typed to keep.
  VersionControls: 'hidden fields only',
  // Hidden fields only: the preview it confirms is re-derived on the server.
  AdjustmentSummary: 'hidden fields only',
  // A button and hidden fields: there is nothing typed to keep.
  EngineerActiveForm: 'hidden fields only',
  PaymentMethodActiveForm: 'hidden fields only',
  // Buyer-side forms that happen to live in the same module as an admin one.
  BuyButton: 'buyer form, not admin',
  FreeOrderForm: 'buyer form, not admin',
  PaymentMethodPicker: 'buyer form, not admin',
};

/** Actions whose refusal need not echo, for the reason named. */
const EXEMPT_ACTIONS: Record<string, string> = {
  productVersionAction: 'hidden fields only',
  // Its rows live in component state (a repeated field name), not in a record.
  setCreditsAction: 'rows kept in component state',
  confirmAdjustmentAction: 'hidden fields only',
  setEngineerActiveAction: 'hidden fields only',
  setPaymentMethodActiveAction: 'hidden fields only',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** '@/components/x' modules imported by any admin page. */
function adminComponentModules(): string[] {
  const modules = new Set<string>();
  for (const page of walk(ADMIN_PAGES)) {
    for (const m of readFileSync(page, 'utf8').matchAll(/from '@\/components\/([a-z-]+)'/g)) {
      modules.add(join(ROOT, 'src/components', `${m[1]}.tsx`));
    }
  }
  return [...modules].filter(existsSync).sort();
}

/** Top-level function components of a module, by name. */
function components(source: string): Array<{ name: string; body: string }> {
  const starts = [...source.matchAll(/^(?:export )?function (\w+)/gm)];
  return starts.map((m, i) => ({
    name: m[1]!,
    body: source.slice(m.index, starts[i + 1]?.index ?? source.length),
  }));
}

/** name → resolved source file, from the module's named imports. */
function importsOf(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'@\/([^']+)'/g)) {
    const file = join(ROOT, 'src', `${m[2]}.ts`);
    for (const raw of m[1]!.split(',')) {
      const name = raw.replace(/^\s*type\s+/, '').split(' as ')[0]!.trim();
      if (name) map.set(name, file);
    }
  }
  return map;
}

function actionBody(file: string, name: string): string {
  const source = readFileSync(file, 'utf8');
  const start = source.search(new RegExp(`export async function ${name}\\b`));
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

/** Every `return { error: … }` whose error is not `null`. */
function refusals(body: string): string[] {
  return [...body.matchAll(/return \{\s*error:(?!\s*null\b)[\s\S]*?\};/g)].map((m) => m[0]);
}

type Stateful = { module: string; name: string; body: string; actions: string[]; imports: Map<string, string> };

function statefulAdminComponents(): Stateful[] {
  const out: Stateful[] = [];
  for (const file of adminComponentModules()) {
    const source = readFileSync(file, 'utf8');
    const imports = importsOf(source);
    for (const c of components(source)) {
      const actions = [...c.body.matchAll(/useActionState(?:<[^>]*>)?\(\s*(\w+)/g)].map((m) => m[1]!);
      if (actions.length > 0) out.push({ module: file, name: c.name, body: c.body, actions, imports });
    }
  }
  return out;
}

const stateful = statefulAdminComponents();
const guarded = stateful.filter((c) => !(c.name in EXEMPT_COMPONENTS));

describe('W11 — the guard sees the admin forms', () => {
  it('found the stateful admin components', () => {
    const names = guarded.map((c) => c.name);
    for (const expected of [
      'CreateProductForm', 'ProductDetailsForm', 'PriceForm', 'StatusForm', 'CreditsForm',
      'CommissionForm', 'CreatePaymentMethodForm', 'EditPaymentMethodForm',
      'AddEngineerForm', 'EditEngineerForm', 'WhatsappNumberForm',
      'GenerateSettlementsForm', 'PaySettlementForm', 'PaymentDecisionForms', 'AdjustmentTool',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it('every exemption still names a component that exists', () => {
    const all = new Set(stateful.map((c) => c.name));
    for (const name of Object.keys(EXEMPT_COMPONENTS)) expect(all, name).toContain(name);
    const used = new Set(stateful.flatMap((c) => c.actions));
    for (const name of Object.keys(EXEMPT_ACTIONS)) expect(used, name).toContain(name);
  });
});

describe('W11 — every stateful admin form is keyed on its answer', () => {
  it.each(guarded.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const forms = [...c.body.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) expect(form, form).toMatch(/key=\{formKey\(\w+\)\}/);
  });
});

describe('W11 — every refusal of an admin action hands the typed values back', () => {
  const actions = [
    ...new Map(
      guarded.flatMap((c) => c.actions.map((a) => [a, c.imports.get(a)] as const)),
    ).entries(),
  ].filter(([name]) => !(name in EXEMPT_ACTIONS));

  it('found the actions', () => {
    expect(actions.length).toBeGreaterThan(15);
  });

  it.each(actions)('%s', (name, file) => {
    expect(file, `${name} is not imported from '@/…'`).toBeDefined();
    const found = refusals(actionBody(file!, name));
    expect(found.length, `${name} has no refusal to check`).toBeGreaterThan(0);
    for (const refusal of found) expect(refusal, refusal).toMatch(/values:\s*submittedValues\(formData\)/);
  });
});
