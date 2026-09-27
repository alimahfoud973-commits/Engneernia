/**
 * A key for a `<form>` that changes with every answer its action gives (W11).
 *
 * After each submission React resets the form in the DOM. Uncontrolled fields
 * are then put back from their `defaultValue` — which the action's echoed
 * `values` supply on a refusal. A CONTROLLED `<select>` is the case that
 * cannot be put back that way: React keeps its `value` in state but never
 * syncs the option's `defaultSelected`, so the reset shows whatever was
 * selected when the page loaded while the state still says otherwise.
 *
 * Keying the form on the answer remounts it from the current props and state
 * instead of leaving it half-reset: every field — controlled or not — is drawn
 * again from what the component now holds.
 *
 * Every answer from `useActionState` is a new object, including a second,
 * identical refusal, so each one gets its own number. A WeakMap rather than a
 * ref written during render: nothing here mutates component state.
 */
const keys = new WeakMap<object, number>();
let next = 0;

export function formKey(state: object): number {
  let key = keys.get(state);
  if (key === undefined) {
    next += 1;
    key = next;
    keys.set(state, key);
  }
  return key;
}
