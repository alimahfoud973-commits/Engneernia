/**
 * The bank or provider reference the owner types when approving a payment
 * (Stage 3, W13).
 *
 * It is optional (owner decision). An empty form field arrives as `''` — the
 * browser always sends a named text input — and `''` is a VALUE to the unique
 * index `payments_provider_ref_unique (payment_method_id, provider_ref)`, so
 * the first approval without a reference stored `''` and every later one on
 * the same method collided with it. "No reference" is NULL, which the index
 * lets repeat.
 *
 * Surrounding whitespace is trimmed; letter case is kept exactly as typed, so
 * `ABC123` and `abc123` remain two references.
 */
export function normalizeProviderRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** The write hit `payments_provider_ref_unique` — and only that index. */
export function isProviderRefTaken(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } })?.cause;
  const direct = error as { code?: string; constraint_name?: string };
  const code = cause?.code ?? direct?.code;
  const constraint = cause?.constraint_name ?? direct?.constraint_name;
  return code === '23505' && constraint === 'payments_provider_ref_unique';
}
