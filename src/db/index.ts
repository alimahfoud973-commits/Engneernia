import 'server-only';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { serverEnv } from '@/lib/config/env';

/**
 * Database access.
 *
 * The connection uses the RESTRICTED application role (see
 * docker/postgres/init/01-roles.sql). That role has no DDL rights and does not
 * carry BYPASSRLS, which is what makes Row-Level Security a real boundary
 * rather than a decoration — see the architecture report §F, layer 3.
 *
 * Initialisation is LAZY and deliberately so: a production build must not
 * require production secrets, and CI must be able to compile the app without a
 * database. The pool is created on first query, not on import.
 *
 * From phase P1, every request opens a transaction and sets the actor context
 * (`SET LOCAL app.actor_id`) before touching any table; the RLS policies read
 * that setting. A query issued without an actor context sees nothing.
 */

type SqlClient = ReturnType<typeof postgres>;

declare global {
  var __emSql: SqlClient | undefined;
}

function createClient(): SqlClient {
  const env = serverEnv();
  return postgres(env.DATABASE_URL, {
    max: env.NODE_ENV === 'production' ? 10 : 5,
    idle_timeout: 20,
    connect_timeout: 10,
    // Amounts are bigint minor units; never let the driver coerce them to float.
    types: { bigint: postgres.BigInt },
    onnotice: () => {},
  });
}

/** The raw SQL client. Prefer `getDb()` unless you need a tagged template. */
export function getSql(): SqlClient {
  if (!globalThis.__emSql) {
    globalThis.__emSql = createClient();
  }
  return globalThis.__emSql;
}

/**
 * The Drizzle query builder, bound to the restricted application role.
 *
 * Memoised. Constructing it installs custom type parsers on the underlying
 * postgres.js client, and connections opened afterwards inherit them — so
 * building a new instance per call makes raw-SQL results depend on the order
 * connections happened to be opened in. One instance, built once.
 */
let memoisedDb: ReturnType<typeof drizzle> | undefined;

export function getDb() {
  memoisedDb ??= drizzle(getSql());
  return memoisedDb;
}

/** Closes the pool. Used by integration tests and graceful shutdown. */
export async function closeDb(): Promise<void> {
  memoisedDb = undefined;
  if (globalThis.__emSql) {
    await globalThis.__emSql.end({ timeout: 5 });
    globalThis.__emSql = undefined;
  }
}

/**
 * Coerce a timestamp coming back from SQL into a Date.
 *
 * Necessary because the driver's parsers are installed per connection: once
 * Drizzle is constructed, connections opened later hand back ISO strings while
 * ones opened earlier hand back Dates. Rather than depend on which connection
 * a query landed on, every timestamp crossing from SQL into application code
 * passes through here.
 *
 * Discovered by the login integration suite, which failed non-deterministically
 * with "getTime is not a function" — see TD-11 in docs/DECISIONS.md.
 */
export function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
