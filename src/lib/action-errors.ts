import 'server-only';
import { AppError } from './errors';
import { logger } from './logger';

/**
 * ===========================================================================
 * WHAT A SERVER ACTION IS ALLOWED TO SAY
 * ===========================================================================
 * Four actions had written this themselves, identically and wrongly:
 *
 *     if (error instanceof AppError) return error.message;
 *     logger.error(...);
 *     return 'تعذّر إتمام العملية';
 *
 * `MoneyInvariantError` is an AppError. Its code is INTERNAL, its status is
 * 500, and its message reads "Money invariant violated: Split does not re-sum
 * to the net price" — so the first branch handed that sentence to the customer
 * and returned before reaching the logger. The one error class the taxonomy
 * calls "must never happen in production" was the one shown to the public and
 * written to no log at all, on the screens that move money.
 *
 * The rule here: an error the domain raised FOR a person (a validation
 * message, a rule they broke, a rate limit) speaks for itself. Anything from
 * 500 upwards, and anything unrecognised, is ours — it goes to the log with
 * its context and the person gets a sentence that tells them what to do next.
 * ===========================================================================
 */

const GENERIC = 'تعذّر إتمام العملية. حاول مرة أخرى.';

export function toUserMessage(error: unknown, context: string, fallback = GENERIC): string {
  /**
   * The boundary is the status, not the class.
   *
   * Reading `httpStatus` means a new AppError subclass lands on the right side
   * of this line by construction — the author picks a status, which they must
   * do anyway, rather than remembering to add their class to a list here.
   */
  if (error instanceof AppError && error.httpStatus < 500) {
    return error.message;
  }

  logger.error({ err: error }, context);
  return fallback;
}
