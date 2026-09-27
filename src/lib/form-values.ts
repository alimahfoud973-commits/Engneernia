/**
 * What the user typed, handed back with a refusal (Stage 3, W11).
 *
 * React resets a `<form action={fn}>` after EVERY submission — `startHostTransition`
 * wraps the action in `requestFormReset`, whatever the action returns — and an
 * uncontrolled field then goes back to its `defaultValue`. Our actions refuse
 * by RETURNING `{ error }`, so a refused form came back empty, or back to the
 * stored value, and the owner typed everything again.
 *
 * The remedy React documents: the action returns the submitted values with its
 * error, and each field takes its `defaultValue` from them. The reset then
 * restores exactly what was typed. On success nothing is returned, so the
 * form resets as it always has.
 *
 * Text only. A file cannot be put back into an `<input type="file">` — browsers
 * forbid it — and Next's own `$ACTION_…` fields are not the user's.
 */
export type SubmittedValues = Readonly<Record<string, string>>;

export function submittedValues(formData: FormData): SubmittedValues {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== 'string' || key.startsWith('$ACTION')) continue;
    // A repeated name (a multi-row form) keeps its first value here; such
    // forms keep their rows in component state, not in this record.
    if (!(key in values)) values[key] = value;
  }
  return values;
}
