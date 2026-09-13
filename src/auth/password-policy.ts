/**
 * The password policy, as plain values.
 *
 * Separated from `password.ts` because that module is `server-only` — it pulls
 * in argon2 — and the sign-up form needs the minimum length to put in the
 * field's `minLength` and to say out loud. Importing the policy rather than
 * repeating the number is what keeps the browser's hint and the server's
 * refusal from drifting apart.
 *
 * MINIMUM LENGTH ONLY, deliberately. Composition rules (one uppercase, one
 * symbol…) measurably push people toward predictable substitutions. Length,
 * plus the lockout in the login flow, is the stronger combination and is what
 * NIST SP 800-63B recommends.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Guards against very long inputs hitting the key-derivation function. */
export const MAX_PASSWORD_LENGTH = 256;
