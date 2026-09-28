import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { Transaction } from '@/db/actor-context';

/**
 * CLEANING UP FIXTURES THAT HAVE BECOME FINANCIAL HISTORY — tests only.
 *
 * Used only by `*.itest.ts`; nothing in the application imports this.
 *
 * Since migration 0062 (S5-03) a completed order, its frozen lines and
 * splits, an approved payment, an issued statement, commission terms a sale
 * was booked under, and an engineer with any of these cannot be deleted —
 * not by the application role, and not by the migrator. An integration file
 * that sells to a buyer it created therefore cannot remove that buyer's order
 * in `afterAll` the way it used to.
 *
 * The migration keeps one door open, and it is not one the application can
 * reach: a SUPERUSER session that sets `app.financial_purge = 'on'` in its
 * own transaction. This opens exactly that — a superuser connection
 * (DATABASE_SUPERUSER_URL, which the application never has), one transaction,
 * the flag set locally — runs the cleanup, and closes the connection.
 *
 * Row-level security does not apply to a superuser, so the cleanup sees every
 * row it created without declaring an actor.
 */
export async function withFinancialPurge<T>(
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const url = process.env.DATABASE_SUPERUSER_URL;
  if (!url) {
    throw new Error('DATABASE_SUPERUSER_URL must be set to clean up financial fixtures');
  }
  const client = postgres(url, {
    max: 1,
    types: { bigint: postgres.BigInt },
    onnotice: () => {},
  });
  try {
    const db = drizzle(client);
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.financial_purge', 'on', true)`);
      return work(tx as unknown as Transaction);
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}
