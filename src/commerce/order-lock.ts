import 'server-only';
import { eq } from 'drizzle-orm';
import { orders } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';

/**
 * THE ORDER ROW IS THE LOCK (Stage 7, S7-04).
 *
 * Every path that changes an order or one of its payments — choosing a
 * method, uploading a receipt, approving, rejecting, cancelling — takes this
 * row first and re-reads what it decides on under it; payments come second,
 * always in that order, so two paths never wait on each other crosswise.
 * Approve and reject used to read without a lock and write without naming the
 * status they expected, and the one that committed last overwrote the other.
 *
 * Its own module so the order service and the proof service can both use it
 * without importing each other (see proof-transition.ts).
 *
 * `FOR UPDATE` applies the UPDATE policy: the owner locks any order, a buyer
 * only their own while it still waits for payment — exactly where they act.
 * Null when the row cannot be locked by this actor any more.
 */
export async function lockOrder(tx: Transaction, orderId: string) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
  return order ?? null;
}
