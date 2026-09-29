import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { withRawActorContext } from '@/db/actor-context';
import { closeDb } from '@/db';
import { approvePayment, createOrder, placeOrder, rejectPayment } from './orders';
import { submitPaymentProof } from './proofs';
import type { Actor } from '@/authz/actor';
import {
  buildCommerceWorld, paymentsOfOrder, pngBytes, type CommerceWorld,
} from '@/db/testing/commerce-fixtures';

/**
 * ===========================================================================
 * APPROVE AND REJECT CANNOT BOTH WIN (Stage 7 — S7-04)
 * ===========================================================================
 * Both used to read the payment and the order without a lock and write
 * without naming the status they expected. When they ran together the one
 * that committed last overwrote the other with stale reads: an order booked,
 * invoiced and granted, then marked PAYMENT_ISSUE with its payment REJECTED.
 *
 * Every mutating path now locks the ORDER row first, re-reads under the lock,
 * and writes only from the status it saw. The second of two decisions waits,
 * sees the first, and is refused.
 * ===========================================================================
 */

let w: CommerceWorld;
const superuserUrl = () => {
  const url = process.env.DATABASE_SUPERUSER_URL;
  if (!url) throw new Error('DATABASE_SUPERUSER_URL is required for the lock-holder');
  return url;
};

async function orderWithReceipt(buyer: Actor, slug: string) {
  const { orderId } = await createOrder(buyer, { productSlugs: [slug], buyerCountry: 'SY' });
  await placeOrder(buyer, { orderId, paymentMethodId: w.methods.bank });
  const [payment] = await paymentsOfOrder(w, orderId);
  await submitPaymentProof(buyer, { paymentId: payment!.id, filename: 'r.png', body: pngBytes() });
  return { orderId, paymentId: payment!.id };
}

/** The whole story of one order, read as the owner. */
async function outcome(orderId: string) {
  const [row] = (await withRawActorContext(w.ownerRaw, (tx) => tx.execute(sql`
    SELECT o.status::text AS "order",
           (SELECT string_agg(p.status::text, ',' ORDER BY p.created_at) FROM payments p WHERE p.order_id = o.id) AS payments,
           (SELECT count(*)::int FROM invoices i WHERE i.order_id = o.id) AS invoices,
           (SELECT count(*)::int FROM ledger_transactions t WHERE t.reference_id = o.id) AS ledger,
           (SELECT count(*)::int FROM entitlements e JOIN order_items oi ON oi.id = e.order_item_id
             WHERE oi.order_id = o.id) AS grants
      FROM orders o WHERE o.id = ${orderId}::uuid`))) as unknown as Array<Record<string, unknown>>;
  return row!;
}

const APPROVED_STORY = { order: 'COMPLETED', payments: 'APPROVED', invoices: 1, ledger: 1, grants: 1 };
const REJECTED_STORY = { order: 'PAYMENT_ISSUE', payments: 'REJECTED', invoices: 0, ledger: 0, grants: 0 };

const settle = (p: Promise<unknown>) => p.then(() => 'OK', (e: Error) => `ERR ${e.message}`);

beforeAll(async () => {
  const prices: Record<string, bigint> = { forced: 1000n, double: 1000n };
  for (let i = 0; i < 10; i += 1) prices[`r${i}`] = 1000n;
  w = await buildCommerceWorld({ prefix: 's7-race', buyers: 2, prices });
}, 120_000);

afterAll(async () => {
  await w.cleanup();
  await closeDb();
}, 60_000);

describe('S7-04 — concurrent approve and reject on one payment', () => {
  it('forced interleaving: approve takes the payment first, reject then sees it and is refused', async () => {
    const buyer = w.buyers[0]!;
    const { orderId, paymentId } = await orderWithReceipt(buyer, w.products.forced!.slug);

    const probe = postgres(superuserUrl(), { max: 1, onnotice: () => {} });
    const holder = postgres(superuserUrl(), { max: 1, onnotice: () => {} });
    const waiting = async () => (await probe`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`)[0]!.n as number;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    try {
      // Hold the PAYMENT row, so approve runs up to its payment write and stops there.
      const held = holder.begin(async (t) => {
        await t`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
        await released;
      });
      await new Promise((r) => setTimeout(r, 200));
      const approve = settle(approvePayment(w.owner, { paymentId }));
      for (let i = 0; i < 200 && (await waiting()) < 1; i += 1) await new Promise((r) => setTimeout(r, 25));
      const reject = settle(rejectPayment(w.owner, { paymentId, reason: 'سباق' }));
      for (let i = 0; i < 200 && (await waiting()) < 2; i += 1) await new Promise((r) => setTimeout(r, 25));
      release();
      await held;
      const results = [await approve, await reject];
      expect(results.filter((r) => r === 'OK')).toHaveLength(1);
      expect(results[0]).toBe('OK');
      expect(await outcome(orderId)).toEqual(APPROVED_STORY);
    } finally {
      release();
      await probe.end({ timeout: 5 });
      await holder.end({ timeout: 5 });
    }
  });

  it('ten free-running pairs: always exactly one decision and one consistent story', async () => {
    for (let i = 0; i < 10; i += 1) {
      const buyer = w.buyers[i % 2]!;
      const { orderId, paymentId } = await orderWithReceipt(buyer, w.products[`r${i}`]!.slug);
      const [a, r] = await Promise.all([
        settle(approvePayment(w.owner, { paymentId })),
        settle(rejectPayment(w.owner, { paymentId, reason: 'سباق' })),
      ]);
      expect([a, r].filter((x) => x === 'OK')).toHaveLength(1);
      expect(await outcome(orderId)).toEqual(a === 'OK' ? APPROVED_STORY : REJECTED_STORY);
    }
  }, 120_000);

  it('two approvals at once still make one sale', async () => {
    const { orderId, paymentId } = await orderWithReceipt(w.buyers[1]!, w.products.double!.slug);
    const results = await Promise.all([
      settle(approvePayment(w.owner, { paymentId })),
      settle(approvePayment(w.owner, { paymentId })),
    ]);
    expect(results.filter((x) => x === 'OK')).toHaveLength(1);
    expect(await outcome(orderId)).toEqual(APPROVED_STORY);
  });
});
