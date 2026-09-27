-- ===========================================================================
-- A RECEIPT MOVES THE PAYMENT TOO (Stage 3 admin audit, W7)
--
-- `submitPaymentProof` stores the receipt, moves the order to PROOF_SUBMITTED,
-- and has always meant to move the payment with it. It could not: the UPDATE
-- ran as the customer, `payments_update` (0020) admits the owner alone, and
-- row-level security refuses an UPDATE by matching zero rows, not by raising.
-- Nothing checked the count, so every upload left the payment at
-- AWAITING_PROOF beside a receipt and an order that said otherwise.
--
-- WHY A DEFINER FUNCTION, AND NOT A CUSTOMER UPDATE POLICY. A policy decides
-- which ROWS a customer may update, never which COLUMNS: a policy loose enough
-- for this move would also let a customer rewrite the amount, the approver or
-- the method snapshot of their own payment. `payments_update` stays owner-only.
-- This function is the one narrow place a customer's payment moves, and it
-- moves one column of one row, one way:
--
--   1. the caller is signed in;
--   2. the payment resolves under the caller's OWN policies (`payments` is
--      FORCE ROW LEVEL SECURITY, so this runs as the customer until step 5) —
--      somebody else's payment is simply not found, as a wrong id is;
--   3. its order is the caller's (checked again, explicitly);
--   4. it is AWAITING_PROOF, and a receipt from this caller is already on it —
--      the receipt comes first, in the same transaction, so this can never run
--      ahead of the evidence it records;
--   5. THE ONE ELEVATED STATEMENT: the role is raised to OWNER for the single
--      UPDATE, guarded by the same status, and restored immediately — the same
--      device `app_complete_free_order` (0054) uses. Exactly one row must move.
--
-- The order's own move is unchanged: the customer already makes it under
-- `orders_update`, and the application checks that UPDATE's row count.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_mark_payment_proof_submitted(p_payment_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE
    v_actor     uuid := app_actor_id();
    v_payment   payments%ROWTYPE;
    v_customer  uuid;
    v_moved     integer;
    v_prev_role text;
  BEGIN
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'A receipt is recorded by its signed-in buyer'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_payment FROM payments p WHERE p.id = p_payment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'no_data_found';
    END IF;

    SELECT o.customer_id INTO v_customer FROM orders o WHERE o.id = v_payment.order_id;
    IF v_customer IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'no_data_found';
    END IF;

    IF v_payment.status <> 'AWAITING_PROOF' THEN
      RAISE EXCEPTION 'Payment is %, not AWAITING_PROOF', v_payment.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM payment_proofs pp
       WHERE pp.payment_id = p_payment_id AND pp.submitted_by = v_actor
    ) THEN
      RAISE EXCEPTION 'No receipt from this buyer is on the payment'
        USING ERRCODE = 'check_violation';
    END IF;

    v_prev_role := current_setting('app.actor_role', true);
    PERFORM set_config('app.actor_role', 'OWNER', true);
    UPDATE payments
       SET status = 'PROOF_SUBMITTED',
           updated_at = now()
     WHERE id = p_payment_id
       AND status = 'AWAITING_PROOF';
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    PERFORM set_config('app.actor_role', COALESCE(v_prev_role, ''), true);

    IF v_moved <> 1 THEN
      RAISE EXCEPTION 'Payment did not move to PROOF_SUBMITTED (% rows)', v_moved
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN p_payment_id;
  END;
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_mark_payment_proof_submitted(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_mark_payment_proof_submitted(uuid) TO app_user;
