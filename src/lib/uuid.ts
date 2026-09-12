/**
 * ===========================================================================
 * IS THIS STRING SHAPED LIKE AN ID?
 * ===========================================================================
 * Every id in this platform's URLs is a PostgreSQL `uuid`. A path segment that
 * is not one reaches the database as a comparison against a uuid column, and
 * PostgreSQL answers by RAISING — `invalid input syntax for type uuid`. The
 * route then returns 500 and writes a stack trace to the log.
 *
 * That is wrong in three ways at once. It is the wrong status: a route that
 * cannot resolve an id has found nothing, and 404 is what "nothing" means. It
 * is free log noise, one error entry per malformed request, which is the kind
 * of thing that hides a real incident. And it is a distinguishable response —
 * a malformed id behaves differently from a well-formed one that does not
 * belong to the caller, which is the beginning of an oracle even where the
 * information it leaks is thin.
 *
 * Checked at the edge of the request, before the value is ever handed to a
 * query. This is a SHAPE check, never an authorisation one: whether the id
 * exists and whether the caller may see it are decided by Row-Level Security,
 * and this function must not be mistaken for either.
 * ===========================================================================
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
