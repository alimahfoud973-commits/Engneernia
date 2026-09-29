-- ===========================================================================
-- STAGE 7 — ONE OPEN PAYMENT PER ORDER, AND A PAYMENT THAT DEFENDS ITSELF
--
-- The database half of the Stage 7 payment-flow repair. Each section names
-- the owner decision or finding it answers (docs/DECISIONS.md §23):
--
--   D10 / C-1 / C-2  stale open payments left by the old code are CLOSED, never
--                    deleted, before the one-open-payment index is built
--   K1 / S7-05       at most one open payment per order: the partial index
--   D11 / S7-06      the payment's own state machine, and the facts that never
--                    change once a payment exists
--   K2 / D2 / D4     the buyer's one narrow way to close their open payment
--   D9 / S7-10       row-level security on the three tables checkout writes
--   D7               a free order made while the product was free completes
--                    free, even if the product has since become paid
--
-- NONE OF 0065's NEW ENUM VALUES APPEAR HERE. Drizzle applies all pending
-- migrations in one transaction, and a value added in a transaction cannot be
-- used before it commits. The cleanup below is recorded in order_events, whose
-- vocabulary is the existing order_status.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- D10 / C-1 / C-2 — stale open payments
--
-- "Open" is INITIATED, AWAITING_PROOF or PROOF_SUBMITTED. The old code could
-- leave two of them on one order (a second method chosen with the Back
-- button), and an open one on an order that was already settled. For each
-- order the one to KEEP is chosen deterministically:
--
--   1. the one carrying a receipt (PROOF_SUBMITTED) — its order is waiting on
--      exactly that receipt, and cancelling it would strand the review;
--   2. then AWAITING_PROOF, then INITIATED;
--   3. then the newest (created_at DESC), then id DESC as the tie-break.
--
-- Every other open payment on the order becomes CANCELLED, and so does every
-- open payment on an order that is PAID, COMPLETED, CANCELLED or REFUNDED —
-- nothing can ever be decided on it. No row is deleted, no terminal payment is
-- touched, no column but status and updated_at changes. Each closure leaves an
-- order_events row (from = to = the order's current status, no actor) saying
-- which payment was closed and why.
--
-- A function rather than a bare statement so the integration suite can run the
-- very same logic against deliberately dirty data (inside a rolled-back
-- transaction) and prove both the choice and that a second run does nothing.
-- It is not callable by the application: EXECUTE is revoked from PUBLIC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_close_stale_open_payments()
  RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
  DECLARE
    v_closed    integer;
    v_prev_role text;
  BEGIN
    -- payments and order_events are FORCE ROW LEVEL SECURITY; the cleanup
    -- acts as the owner for its own statements and restores the context.
    v_prev_role := current_setting('app.actor_role', true);
    PERFORM set_config('app.actor_role', 'OWNER', true);

    WITH open_payments AS (
      SELECT p.id,
             p.order_id,
             o.status       AS order_status,
             o.order_number AS order_number,
             row_number() OVER (
               PARTITION BY p.order_id
               ORDER BY CASE p.status
                          WHEN 'PROOF_SUBMITTED' THEN 0
                          WHEN 'AWAITING_PROOF'  THEN 1
                          ELSE 2
                        END,
                        p.created_at DESC,
                        p.id DESC
             ) AS keep_rank
        FROM payments p
        JOIN orders o ON o.id = p.order_id
       WHERE p.status IN ('INITIATED', 'AWAITING_PROOF', 'PROOF_SUBMITTED')
    ),
    stale AS (
      SELECT *
        FROM open_payments
       WHERE keep_rank > 1
          OR order_status IN ('PAID', 'COMPLETED', 'CANCELLED', 'REFUNDED')
    ),
    closed AS (
      UPDATE payments p
         SET status = 'CANCELLED',
             updated_at = now()
        FROM stale s
       WHERE p.id = s.id
         AND p.status IN ('INITIATED', 'AWAITING_PROOF', 'PROOF_SUBMITTED')
      RETURNING p.id, s.order_id, s.order_status, s.order_number, s.keep_rank
    )
    INSERT INTO order_events (order_id, order_number, from_status, to_status, actor_user_id, note)
    SELECT c.order_id, c.order_number, c.order_status, c.order_status, NULL,
           '0066: أُغلقت محاولة دفع مفتوحة '
             || CASE WHEN c.keep_rank > 1 THEN 'مكررة' ELSE 'على طلب منتهٍ' END
             || ' ' || c.id::text
      FROM closed c;
    GET DIAGNOSTICS v_closed = ROW_COUNT;

    PERFORM set_config('app.actor_role', COALESCE(v_prev_role, ''), true);
    RETURN v_closed;
  END;
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_close_stale_open_payments() FROM PUBLIC;--> statement-breakpoint

SELECT app_close_stale_open_payments();--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- K1 / S7-05 — at most one open payment per order
--
-- Every retry is a new row (K1), so the old idempotency key `order:method`
-- no longer states the rule. This does: a second open payment on one order is
-- refused however it is written. The application serialises on the order row
-- and closes the previous attempt before opening the next; this index is the
-- refusal that cannot be forgotten.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_open_per_order
  ON payments (order_id)
  WHERE status IN ('INITIATED', 'AWAITING_PROOF', 'PROOF_SUBMITTED');--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- D11 / S7-06 — the payment's own state machine
--
--   INITIATED        → APPROVED | REJECTED | CANCELLED
--   AWAITING_PROOF   → PROOF_SUBMITTED | APPROVED | REJECTED | CANCELLED
--   PROOF_SUBMITTED  → APPROVED | REJECTED | CANCELLED
--   APPROVED, REJECTED, CANCELLED — final: nothing but updated_at may change
--
-- INITIATED → APPROVED and AWAITING_PROOF → APPROVED stay: the owner may
-- record a transfer confirmed without a receipt (the order table's own rule),
-- and the finance suites approve such payments.
--
-- What a payment IS never changes after it is written: its order, method,
-- amount, currency, idempotency key and the method snapshot the buyer was
-- shown (migration 0055). The decision columns move only with their decision.
--
-- UPDATE only. What a buyer may INSERT is row-level security's job (below);
-- the owner and the seed scripts keep their present ability. This fires for a
-- superuser too — a console cannot rewrite a decided payment either.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payments_transition_guard()
  RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
  BEGIN
    IF NEW.order_id                 IS DISTINCT FROM OLD.order_id
    OR NEW.payment_method_id        IS DISTINCT FROM OLD.payment_method_id
    OR NEW.amount_minor             IS DISTINCT FROM OLD.amount_minor
    OR NEW.currency                 IS DISTINCT FROM OLD.currency
    OR NEW.idempotency_key          IS DISTINCT FROM OLD.idempotency_key
    OR NEW.method_name_snapshot     IS DISTINCT FROM OLD.method_name_snapshot
    OR NEW.instructions_snapshot    IS DISTINCT FROM OLD.instructions_snapshot
    OR NEW.account_details_snapshot IS DISTINCT FROM OLD.account_details_snapshot
    OR NEW.requires_proof_snapshot  IS DISTINCT FROM OLD.requires_proof_snapshot
    OR NEW.created_at               IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Payment %: its order, method, amount, currency and snapshot never change', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD.status IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
      IF NEW.status          IS DISTINCT FROM OLD.status
      OR NEW.provider_ref    IS DISTINCT FROM OLD.provider_ref
      OR NEW.fee_minor       IS DISTINCT FROM OLD.fee_minor
      OR NEW.approved_by     IS DISTINCT FROM OLD.approved_by
      OR NEW.approved_at     IS DISTINCT FROM OLD.approved_at
      OR NEW.rejected_reason IS DISTINCT FROM OLD.rejected_reason
      THEN
        RAISE EXCEPTION 'Payment % is %, which is final', OLD.id, OLD.status
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'INITIATED'       AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED'))
      OR (OLD.status = 'AWAITING_PROOF'  AND NEW.status IN ('PROOF_SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'))
      OR (OLD.status = 'PROOF_SUBMITTED' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'Payment %: % → % is not a permitted move', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF (NEW.approved_by IS DISTINCT FROM OLD.approved_by
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
        OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref)
       AND NEW.status <> 'APPROVED' THEN
      RAISE EXCEPTION 'Payment %: approval details are written only with the approval', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW.rejected_reason IS DISTINCT FROM OLD.rejected_reason AND NEW.status <> 'REJECTED' THEN
      RAISE EXCEPTION 'Payment %: a rejection reason is written only with the rejection', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
  END;
  $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS payments_transition_guard ON payments;--> statement-breakpoint
CREATE TRIGGER payments_transition_guard
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_transition_guard();--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- K2 / D2 / D4 — the buyer closes their own open payment
--
-- Changing method before a receipt (D2, WhatsApp included — K2) and
-- cancelling one's own order (D4) both close the open payment as CANCELLED.
-- `payments_update` is owner-only and stays so: a policy decides ROWS, never
-- COLUMNS, and one loose enough for this would let a buyer rewrite an amount.
-- This is the one narrow move, in the pattern of 0057:
--
--   1. the caller is signed in;
--   2. the order resolves under the caller's own policies and is theirs;
--   3. it still waits for payment: DRAFT, AWAITING_PAYMENT or PAYMENT_ISSUE —
--      never past a receipt (D4);
--   4. only INITIATED and AWAITING_PROOF payments close — a receipt under
--      review is the owner's to decide;
--   5. the role is raised to OWNER for the one UPDATE and restored at once.
--
-- Returns the ids it closed, so the application can audit each one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_cancel_open_payments(p_order_id uuid)
  RETURNS TABLE (payment_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE
    v_actor     uuid := app_actor_id();
    v_order     orders%ROWTYPE;
    v_prev_role text;
    v_closed    uuid[];
  BEGIN
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'A payment is closed by its signed-in buyer'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_order FROM orders o WHERE o.id = p_order_id;
    IF NOT FOUND OR v_order.customer_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Order not found' USING ERRCODE = 'no_data_found';
    END IF;

    IF v_order.status NOT IN ('DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_ISSUE') THEN
      RAISE EXCEPTION 'Order % is %; its payment cannot be closed by the buyer',
        v_order.order_number, v_order.status
        USING ERRCODE = 'check_violation';
    END IF;

    v_prev_role := current_setting('app.actor_role', true);
    PERFORM set_config('app.actor_role', 'OWNER', true);
    WITH closed AS (
      UPDATE payments
         SET status = 'CANCELLED',
             updated_at = now()
       WHERE order_id = p_order_id
         AND status IN ('INITIATED', 'AWAITING_PROOF')
      RETURNING id
    )
    SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_closed FROM closed;
    PERFORM set_config('app.actor_role', COALESCE(v_prev_role, ''), true);

    RETURN QUERY SELECT unnest(v_closed);
  END;
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_cancel_open_payments(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_cancel_open_payments(uuid) TO app_user;--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- D9 / S7-10 — row-level security admits only what checkout writes
--
-- The owner branches are unchanged. The buyer branches were wider than any
-- code path: a buyer's own INSERT could carry any status, amount, approver or
-- currency; a receipt row could name somebody else's payment; and an order
-- event could be written onto any order at all. FORCE ROW LEVEL SECURITY
-- stays on all three tables.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS payments_insert ON payments;--> statement-breakpoint
CREATE POLICY payments_insert ON payments FOR INSERT
  WITH CHECK (
    app_is_owner()
    OR (
      status IN ('INITIATED', 'AWAITING_PROOF')
      AND approved_by IS NULL
      AND approved_at IS NULL
      AND provider_ref IS NULL
      AND rejected_reason IS NULL
      AND fee_minor = 0
      AND EXISTS (
        SELECT 1 FROM orders o
         WHERE o.id = payments.order_id
           AND o.customer_id = app_actor_id()
           AND o.status IN ('DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_ISSUE')
           AND o.total_minor = payments.amount_minor
           AND o.currency = payments.currency
      )
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS payment_proofs_insert ON payment_proofs;--> statement-breakpoint
CREATE POLICY payment_proofs_insert ON payment_proofs FOR INSERT
  WITH CHECK (
    app_is_owner()
    OR (
      submitted_by = app_actor_id()
      AND EXISTS (
        SELECT 1 FROM payments p
          JOIN orders o ON o.id = p.order_id
         WHERE p.id = payment_proofs.payment_id
           AND o.customer_id = app_actor_id()
           AND p.status = 'AWAITING_PROOF'
      )
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS order_events_insert ON order_events;--> statement-breakpoint
CREATE POLICY order_events_insert ON order_events FOR INSERT
  WITH CHECK (
    app_is_owner()
    OR (
      (actor_user_id IS NULL OR actor_user_id = app_actor_id())
      AND EXISTS (
        SELECT 1 FROM orders o
         WHERE o.id = order_events.order_id
           AND o.customer_id = app_actor_id()
      )
    )
  );--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- D7 — a free order made while the product was free completes free
--
-- Owner decision (option A): the order keeps the terms it was made on, free
-- ones included — the same rule a paid order now follows (K3). The one
-- condition removed is "the product's CURRENT price is zero". Everything else
-- stands: the order is the caller's and DRAFT, every figure on the order and
-- every line on it is zero, the product is still published, and it has no
-- payment. A NEW order is always priced from today's price row, so this can
-- never make a paid product free — only honour a free order already made.
-- Body otherwise identical to 0054; grants are kept by CREATE OR REPLACE.
-- ---------------------------------------------------------------------------
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

    SELECT * INTO v_order FROM orders o WHERE o.id = p_order_id;
    IF NOT FOUND OR v_order.customer_id <> v_actor THEN
      RAISE EXCEPTION 'Order not found' USING ERRCODE = 'no_data_found';
    END IF;

    IF v_order.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Order % is %, not DRAFT', v_order.order_number, v_order.status;
    END IF;

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

    -- The terms the order was MADE on (D7): every line free on the order
    -- itself, and the product still published. Today's price is not asked.
    SELECT count(*) INTO v_not_free
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = p_order_id
       AND (oi.unit_price_minor <> 0
            OR p.status <> 'PUBLISHED');
    IF v_not_free > 0 THEN
      RAISE EXCEPTION 'Order % contains a line that is not free or a product no longer published',
        v_order.order_number;
    END IF;

    IF EXISTS (SELECT 1 FROM payments pay WHERE pay.order_id = p_order_id) THEN
      RAISE EXCEPTION 'Order % already has a payment', v_order.order_number;
    END IF;

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
