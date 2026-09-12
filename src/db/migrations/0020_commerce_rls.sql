-- ===========================================================================
-- COMMERCE VISIBILITY AND THE IMMUTABLE SNAPSHOT
-- (specification §12, §13, §24, §41, §48, §49)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Payment-method secrets live in their OWN table.
--
-- RLS protects rows, not columns. Keeping provider credentials in a column of
-- payment_methods would mean the public policy that exposes active methods
-- also exposes the credential to any query that forgets to narrow its SELECT.
-- A separate, owner-only table makes that impossible rather than unlikely.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "payment_method_secrets" (
  "payment_method_id" uuid PRIMARY KEY
    REFERENCES "payment_methods"("id") ON DELETE CASCADE,
  "config_encrypted" text NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "payment_methods" DROP COLUMN IF EXISTS "provider_config_encrypted";--> statement-breakpoint

ALTER TABLE "payment_method_secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_method_secrets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "payment_method_secrets_owner" ON "payment_method_secrets" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- --- payment_methods -------------------------------------------------------
ALTER TABLE "payment_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_methods" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- An inactive method does not exist for a customer. Specification §22: do not
-- promise a way to pay merely because it appears in the interface.
CREATE POLICY "payment_methods_select" ON "payment_methods" FOR SELECT
  USING (app_is_owner() OR "is_active" = true);
--> statement-breakpoint
CREATE POLICY "payment_methods_write" ON "payment_methods" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- --- commission_agreements (specification §12) ------------------------------
ALTER TABLE "commission_agreements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commission_agreements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The owner, and the contributor the agreement is WITH. Nobody else — this is
-- the private commercial term §12 exists to protect.
CREATE POLICY "commission_agreements_select" ON "commission_agreements" FOR SELECT
  USING (app_is_owner() OR "contributor_id" = app_contributor_id());
--> statement-breakpoint
CREATE POLICY "commission_agreements_write" ON "commission_agreements" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- --- orders ----------------------------------------------------------------
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Owner and the customer who placed it. NOT the contributor: an order carries
-- the buyer's identity, and who bought a product is the customer's private
-- information, not a fact the seller of that product is entitled to.
CREATE POLICY "orders_select" ON "orders" FOR SELECT
  USING (app_is_owner() OR "customer_id" = app_actor_id());
--> statement-breakpoint

-- A customer may create and edit their own order only while it is a DRAFT or
-- awaiting payment. Every later transition belongs to the owner.
CREATE POLICY "orders_insert" ON "orders" FOR INSERT
  WITH CHECK (app_is_owner() OR "customer_id" = app_actor_id());
--> statement-breakpoint
CREATE POLICY "orders_update" ON "orders" FOR UPDATE
  USING (
    app_is_owner()
    OR ("customer_id" = app_actor_id()
        AND "status" IN ('DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_ISSUE'))
  )
  WITH CHECK (
    app_is_owner()
    OR ("customer_id" = app_actor_id()
        AND "status" IN ('DRAFT', 'AWAITING_PAYMENT', 'PROOF_SUBMITTED', 'CANCELLED'))
  );
--> statement-breakpoint
CREATE POLICY "orders_delete" ON "orders" FOR DELETE USING (app_is_owner());--> statement-breakpoint

-- --- order_items -----------------------------------------------------------
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Three audiences, three reasons:
--   owner       — everything;
--   customer    — the lines of their own order;
--   contributor — lines for products they are credited on, which is how "my
--                 sales" works (§3.2). They see the price and the split for
--                 THEIR product, and never the order or the buyer behind it.
CREATE POLICY "order_items_select" ON "order_items" FOR SELECT
  USING (
    app_is_owner()
    OR EXISTS (SELECT 1 FROM orders o
                WHERE o.id = order_items.order_id AND o.customer_id = app_actor_id())
    OR EXISTS (SELECT 1 FROM product_contributors pc
                WHERE pc.product_id = order_items.product_id
                  AND pc.contributor_id = app_contributor_id())
  );
--> statement-breakpoint

CREATE POLICY "order_items_insert" ON "order_items" FOR INSERT
  WITH CHECK (
    app_is_owner()
    OR EXISTS (SELECT 1 FROM orders o
                WHERE o.id = order_items.order_id
                  AND o.customer_id = app_actor_id()
                  AND o.status IN ('DRAFT', 'AWAITING_PAYMENT'))
  );
--> statement-breakpoint
CREATE POLICY "order_items_update" ON "order_items" FOR UPDATE
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint
CREATE POLICY "order_items_delete" ON "order_items" FOR DELETE
  USING (
    app_is_owner()
    OR EXISTS (SELECT 1 FROM orders o
                WHERE o.id = order_items.order_id
                  AND o.customer_id = app_actor_id()
                  AND o.status IN ('DRAFT', 'AWAITING_PAYMENT'))
  );
--> statement-breakpoint

-- --- order_item_contributors ------------------------------------------------
ALTER TABLE "order_item_contributors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_item_contributors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A contributor sees only their OWN line. On a co-authored product they never
-- learn who else was credited or with what share.
CREATE POLICY "order_item_contributors_select" ON "order_item_contributors" FOR SELECT
  USING (app_is_owner() OR "contributor_id" = app_contributor_id());
--> statement-breakpoint
CREATE POLICY "order_item_contributors_write" ON "order_item_contributors" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- --- payments and proofs ----------------------------------------------------
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "payments_select" ON "payments" FOR SELECT
  USING (
    app_is_owner()
    OR EXISTS (SELECT 1 FROM orders o
                WHERE o.id = payments.order_id AND o.customer_id = app_actor_id())
  );
--> statement-breakpoint
CREATE POLICY "payments_insert" ON "payments" FOR INSERT
  WITH CHECK (
    app_is_owner()
    OR EXISTS (SELECT 1 FROM orders o
                WHERE o.id = payments.order_id AND o.customer_id = app_actor_id())
  );
--> statement-breakpoint
-- Only the owner approves or rejects a payment (§24).
CREATE POLICY "payments_update" ON "payments" FOR UPDATE
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

ALTER TABLE "payment_proofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_proofs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "payment_proofs_select" ON "payment_proofs" FOR SELECT
  USING (app_is_owner() OR "submitted_by" = app_actor_id());
--> statement-breakpoint
CREATE POLICY "payment_proofs_insert" ON "payment_proofs" FOR INSERT
  WITH CHECK (app_is_owner() OR "submitted_by" = app_actor_id());
--> statement-breakpoint
CREATE POLICY "payment_proofs_update" ON "payment_proofs" FOR UPDATE
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- --- entitlements (specification §41) ---------------------------------------
ALTER TABLE "entitlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entitlements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "entitlements_select" ON "entitlements" FOR SELECT
  USING (app_is_owner() OR "customer_id" = app_actor_id());
--> statement-breakpoint

-- Granting is the platform's act, never the customer's. A customer cannot
-- write themselves an entitlement, which is the whole point of the row.
CREATE POLICY "entitlements_write" ON "entitlements" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- --- order_events -----------------------------------------------------------
ALTER TABLE "order_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "order_events_select" ON "order_events" FOR SELECT
  USING (
    app_is_owner()
    OR EXISTS (SELECT 1 FROM orders o
                WHERE o.id = order_events.order_id AND o.customer_id = app_actor_id())
  );
--> statement-breakpoint
CREATE POLICY "order_events_insert" ON "order_events" FOR INSERT WITH CHECK (true);--> statement-breakpoint
-- No UPDATE or DELETE policy: the order history is append-only.
CREATE TRIGGER order_events_no_update
  BEFORE UPDATE ON "order_events"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();
--> statement-breakpoint
CREATE TRIGGER order_events_no_delete
  BEFORE DELETE ON "order_events"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();
--> statement-breakpoint

-- ===========================================================================
-- THE SNAPSHOT IS IMMUTABLE (specification §13 — "This is mandatory")
--
-- Once taken, the financial values on an order line cannot be changed by
-- anyone: not by application code, not by an admin script, not by the owner.
-- Changing a price or an agreement later reaches new sales only.
--
-- The trigger permits the FIRST write — snapshot_taken_at moving from NULL —
-- and refuses every change afterwards.
-- ===========================================================================
CREATE OR REPLACE FUNCTION order_items_snapshot_is_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.snapshot_taken_at IS NULL THEN
      RETURN NEW;  -- the sale is being recorded for the first time
    END IF;

    IF NEW.unit_price_minor   IS DISTINCT FROM OLD.unit_price_minor
    OR NEW.currency           IS DISTINCT FROM OLD.currency
    OR NEW.commission_model   IS DISTINCT FROM OLD.commission_model
    OR NEW.engineer_bp        IS DISTINCT FROM OLD.engineer_bp
    OR NEW.engineer_amount_minor  IS DISTINCT FROM OLD.engineer_amount_minor
    OR NEW.platform_amount_minor  IS DISTINCT FROM OLD.platform_amount_minor
    OR NEW.agreement_id       IS DISTINCT FROM OLD.agreement_id
    OR NEW.price_row_id       IS DISTINCT FROM OLD.price_row_id
    OR NEW.snapshot_taken_at  IS DISTINCT FROM OLD.snapshot_taken_at
    THEN
      RAISE EXCEPTION
        'The financial snapshot on an order item is immutable once taken (specification 13)'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
  END;
  $$;
--> statement-breakpoint

CREATE TRIGGER order_items_snapshot_guard
  BEFORE UPDATE ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION order_items_snapshot_is_immutable();
--> statement-breakpoint

-- A settled split cannot be re-cut either.
CREATE OR REPLACE FUNCTION order_item_contributors_are_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION
      'A contributor split recorded on a sale is immutable (decisions 6)'
      USING ERRCODE = 'integrity_constraint_violation';
  END;
  $$;
--> statement-breakpoint

CREATE TRIGGER order_item_contributors_guard
  BEFORE UPDATE ON "order_item_contributors"
  FOR EACH ROW EXECUTE FUNCTION order_item_contributors_are_immutable();
--> statement-breakpoint

-- --- integrity constraints ---------------------------------------------------
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_non_negative"
  CHECK (subtotal_minor >= 0 AND discount_minor >= 0 AND total_minor >= 0);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_format"
  CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_non_negative"
  CHECK (unit_price_minor >= 0);
--> statement-breakpoint

-- The split must re-sum to the price, and neither side may be negative.
-- Computed in application code and checked again here, because this is the
-- one invariant the whole settlement system rests on.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_split_balances"
  CHECK (
    snapshot_taken_at IS NULL
    OR (engineer_amount_minor >= 0
        AND platform_amount_minor >= 0
        AND engineer_amount_minor + platform_amount_minor = unit_price_minor)
  );
--> statement-breakpoint

ALTER TABLE "order_item_contributors" ADD CONSTRAINT "oic_share_range"
  CHECK (share_bp > 0 AND share_bp <= 10000);
--> statement-breakpoint
ALTER TABLE "commission_agreements" ADD CONSTRAINT "commission_bp_range"
  CHECK (engineer_bp IS NULL OR (engineer_bp >= 0 AND engineer_bp <= 10000));
--> statement-breakpoint
ALTER TABLE "commission_agreements" ADD CONSTRAINT "commission_window_ordered"
  CHECK (effective_to IS NULL OR effective_to >= effective_from);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive"
  CHECK (amount_minor > 0 AND fee_minor >= 0);
--> statement-breakpoint

-- At most ONE open agreement per scope, mirroring the price table's rule.
CREATE UNIQUE INDEX IF NOT EXISTS "commission_agreements_one_current_contributor"
  ON "commission_agreements" ("contributor_id")
  WHERE product_id IS NULL AND effective_to IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_agreements_one_current_product"
  ON "commission_agreements" ("contributor_id", "product_id")
  WHERE product_id IS NOT NULL AND effective_to IS NULL;
