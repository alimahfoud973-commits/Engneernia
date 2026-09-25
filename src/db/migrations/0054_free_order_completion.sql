-- ===========================================================================
-- A FREE PRODUCT IS TAKEN, NOT PAID FOR (Stage 2 buyer audit, F1; OPEN-12)
--
-- OPEN-12 settled that a free product needs an account and is recorded as an
-- order at zero. What nothing did was complete such an order. The only road to
-- COMPLETED ran through a payment, and `payments_amount_positive` (0020)
-- rightly refuses a payment of zero — so "الحصول عليه مجاناً" created an order,
-- sent the buyer to choose a payment method for nothing, and failed there.
--
-- The constraint is correct and stays. A free order does not become a special
-- kind of payment; it skips payment altogether.
--
-- WHY A DEFINER FUNCTION. Granting access is the platform's act, never the
-- customer's (entitlements_write, 0020), and a customer may not move their own
-- order past PROOF_SUBMITTED (orders_update). Both rules stand. This function
-- is the one narrow place that may complete an order without the owner, and it
-- does so only after proving the order is free in every sense that matters:
--
--   1. the caller is signed in and the order is theirs;
--   2. it is still a DRAFT — nothing has been offered, paid or claimed;
--   3. its subtotal, discount and total are all zero;
--   4. every line is priced at zero AND its product is published AND the
--      product's price in force right now is zero — a price raised after the
--      order was built is not given away;
--   5. no payment exists for it.
--
-- WHAT IT DOES NOT WRITE, deliberately: no payment, no ledger transaction, no
-- invoice, no commission snapshot, no engineer share and no sales count. No
-- money moved. The ledger could not record it anyway — ledger lines may not be
-- zero (0025) — and a tax invoice for nothing would spend a number from the
-- gapless series on a document no one paid for.
--
-- WHAT IT DOES WRITE, in one transaction: the entitlements (the same rows the
-- paid path writes, read by the same download gate), the order moving to
-- COMPLETED with the same three history events the paid path records, and an
-- audit entry.
--
-- THE ONE ELEVATED STATEMENT. `orders` has FORCE ROW LEVEL SECURITY, so even
-- this function is refused COMPLETED under the customer's own policy. The role
-- is raised to OWNER for that single UPDATE and restored immediately — every
-- check above has already run as the customer, under their own policies.
-- `entitlements` is NO FORCE (0023), so the definer writes it directly.
-- ===========================================================================

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'FREE_ORDER_COMPLETED';--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_complete_free_order(p_order_id uuid)
  RETURNS TABLE (order_id uuid, order_number text, entitlements_granted integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE
    v_actor     uuid := app_actor_id();
    v_order     orders%ROWTYPE;
    v_lines     integer;
    v_not_free  integer;
    v_granted   integer;
    v_prev_role text;
  BEGIN
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'A free order is completed by its signed-in owner'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Under the customer's own policies: another person's order is simply not
    -- found, which is the same answer a wrong id gets. Read WITHOUT a lock
    -- first: FOR UPDATE applies the UPDATE policy, which admits only an order
    -- still editable by the customer — their own completed order would then
    -- read as "not found" instead of "already completed".
    SELECT * INTO v_order FROM orders o WHERE o.id = p_order_id;
    IF NOT FOUND OR v_order.customer_id <> v_actor THEN
      RAISE EXCEPTION 'Order not found' USING ERRCODE = 'no_data_found';
    END IF;

    IF v_order.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Order % is %, not DRAFT', v_order.order_number, v_order.status;
    END IF;

    -- Now the lock, re-checking DRAFT: of two simultaneous clicks, the second
    -- waits here and then finds nothing left to complete.
    PERFORM 1 FROM orders o WHERE o.id = p_order_id AND o.status = 'DRAFT' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order % is no longer DRAFT', v_order.order_number;
    END IF;

    IF v_order.subtotal_minor <> 0 OR v_order.discount_minor <> 0 OR v_order.total_minor <> 0 THEN
      RAISE EXCEPTION 'Order % is not free', v_order.order_number;
    END IF;

    SELECT count(*) INTO v_lines FROM order_items oi WHERE oi.order_id = p_order_id;
    IF v_lines = 0 THEN
      RAISE EXCEPTION 'Order % has no lines', v_order.order_number;
    END IF;

    SELECT count(*) INTO v_not_free
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      LEFT JOIN product_prices pp
        ON pp.product_id = p.id AND pp.effective_to IS NULL
     WHERE oi.order_id = p_order_id
       AND (oi.unit_price_minor <> 0
            OR p.status <> 'PUBLISHED'
            OR pp.amount_minor IS DISTINCT FROM 0);
    IF v_not_free > 0 THEN
      RAISE EXCEPTION 'Order % contains a product that is not free now', v_order.order_number;
    END IF;

    IF EXISTS (SELECT 1 FROM payments pay WHERE pay.order_id = p_order_id) THEN
      RAISE EXCEPTION 'Order % already has a payment', v_order.order_number;
    END IF;

    -- The grant. The partial unique index `entitlements_live_unique` (0048)
    -- still refuses a second live entitlement to the same product.
    INSERT INTO entitlements (customer_id, product_id, order_item_id)
    SELECT v_order.customer_id, oi.product_id, oi.id
      FROM order_items oi
     WHERE oi.order_id = p_order_id;
    GET DIAGNOSTICS v_granted = ROW_COUNT;

    v_prev_role := current_setting('app.actor_role', true);
    PERFORM set_config('app.actor_role', 'OWNER', true);
    UPDATE orders
       SET status = 'COMPLETED',
           placed_at = COALESCE(placed_at, now()),
           paid_at = now(),
           completed_at = now(),
           updated_at = now()
     WHERE id = p_order_id;
    PERFORM set_config('app.actor_role', COALESCE(v_prev_role, ''), true);

    -- The same three steps the paid path records, so an order's history reads
    -- the same whichever way it was settled.
    INSERT INTO order_events (order_id, order_number, from_status, to_status, actor_user_id, note)
    VALUES
      (p_order_id, v_order.order_number, 'DRAFT', 'AWAITING_PAYMENT', v_actor, 'منتج مجاني'),
      (p_order_id, v_order.order_number, 'AWAITING_PAYMENT', 'PAID', NULL, 'لا دفع — الإجمالي صفر'),
      (p_order_id, v_order.order_number, 'PAID', 'COMPLETED', NULL, 'منح الوصول');

    INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, after)
    VALUES (v_actor, app_actor_role()::user_role, 'FREE_ORDER_COMPLETED', 'order', p_order_id::text,
            jsonb_build_object('orderNumber', v_order.order_number,
                               'entitlementsGranted', v_granted));

    RETURN QUERY SELECT p_order_id, v_order.order_number::text, v_granted;
  END;
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_complete_free_order(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_complete_free_order(uuid) TO app_user;
