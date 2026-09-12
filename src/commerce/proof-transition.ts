import 'server-only';
import { eq } from 'drizzle-orm';
import { orderEvents, orders } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';
import type { Actor } from '@/authz/actor';
import { assertOrderTransition, orderActorOf, type OrderStatus } from './order-status';
import { RuleViolationError } from '@/lib/errors';

/**
 * Moves an order to PROOF_SUBMITTED.
 *
 * Split into its own module purely to keep the proof service from importing
 * the order service and the order service from importing the proof service —
 * a cycle that TypeScript tolerates and Node does not always resolve in the
 * order you expect.
 */
export async function moveOrderForProof(
  tx: Transaction,
  actor: Actor,
  order: { id: string; status: OrderStatus; orderNumber?: string },
): Promise<void> {
  assertOrderTransition(order.status, 'PROOF_SUBMITTED', orderActorOf(actor));

  const updated = await tx
    .update(orders)
    .set({ status: 'PROOF_SUBMITTED', updatedAt: new Date() })
    .where(eq(orders.id, order.id))
    .returning({ id: orders.id });

  if (updated.length === 0) {
    throw new RuleViolationError('لم يُطبَّق تغيير حالة الطلب بعد رفع الإثبات');
  }

  await tx.insert(orderEvents).values({
    orderId: order.id,
    orderNumber: order.orderNumber ?? null,
    fromStatus: order.status,
    toStatus: 'PROOF_SUBMITTED',
    actorUserId: actor.kind === 'USER' ? actor.userId : null,
    note: 'تم رفع إثبات الدفع',
  });
}
