-- ===========================================================================
-- Four defects the end-to-end purchase test surfaced.
-- ===========================================================================

-- --- 1. The append-only guard named the wrong table ------------------------
-- order_events and download_events reuse the function written for audit_logs,
-- so a blocked write on any of them reported "audit_logs is append-only".
-- A misleading error costs debugging time exactly when something is already
-- going wrong.
CREATE OR REPLACE FUNCTION audit_logs_are_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END;
  $$;
--> statement-breakpoint

-- --- 2. order_events must outlive the order it describes --------------------
-- ON DELETE CASCADE meant deleting an order tried to delete its history, which
-- the append-only trigger correctly refused — so the two rules deadlocked and
-- no order could be deleted at all. The trail now stands alone, exactly as the
-- download trail does, and keeps the order number so it stays readable.
ALTER TABLE "order_events" DROP CONSTRAINT IF EXISTS "order_events_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "order_events" ADD COLUMN IF NOT EXISTS "order_number" text;--> statement-breakpoint

-- --- 3. Entitlement download counting was blocked by FORCE RLS ---------------
-- app_record_entitlement_download is SECURITY DEFINER and runs as the table
-- owner. FORCE ROW LEVEL SECURITY applies the policies to the owner too, so
-- the function saw zero rows and reported the entitlement as revoked — for a
-- customer who had just legitimately bought the product.
--
-- Dropping FORCE restores the trusted path without weakening anything that
-- matters: the application connects as app_user, which is not the table owner
-- and remains fully subject to the policies. Same decision, same reason, as
-- `contributors` in 0001 and `product_contributors` in 0008.
ALTER TABLE "entitlements" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- --- 4. An owner must be able to reject a claimed payment before any proof ---
-- The lifecycle only allowed PAYMENT_ISSUE from PROOF_SUBMITTED or
-- PENDING_VERIFICATION. A customer who says they transferred but did not
-- leaves the order stuck in AWAITING_PAYMENT with no way for the owner to
-- close the loop. Handled in the state table, not here — see order-status.ts.
SELECT 1;
