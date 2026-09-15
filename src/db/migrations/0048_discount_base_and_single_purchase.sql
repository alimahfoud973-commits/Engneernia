-- ===========================================================================
-- OPEN-1 AND OPEN-11, DECIDED — AND PUT WHERE CODE CANNOT FORGET THEM
-- ===========================================================================
-- Two owner decisions, and every statement below follows from one of them.
--
--   OPEN-1  — COMMISSION IS COMPUTED AFTER THE DISCOUNT. The pot to divide is
--             what the customer actually paid, so a discount is borne by both
--             sides in the proportion their agreement already names. Same
--             shape as OPEN-9: what is not there is not divided.
--
--   OPEN-11 — A PRODUCT IS BOUGHT ONCE. What is sold is a file and a permanent
--             right to download it; a second purchase buys nothing, and this
--             platform has no refund with which to undo one.
--
-- AT ZERO DISCOUNT THIS MIGRATION CHANGES NO NUMBER ANYWHERE. Every amount
-- column added defaults to 0, and `list = paid` is the identity every sale so
-- far already satisfies. That is what the tests assert, not a hope.
-- ===========================================================================


-- ===========================================================================
-- PART ONE — OPEN-1: THE DISCOUNT BECOMES A FIRST-CLASS AMOUNT
-- ===========================================================================

-- --- 1. the discount, frozen onto the LINE ---------------------------------
-- On the line and not only on the order. An order-level discount would have to
-- be apportioned across lines before any line could be split between the
-- platform and an engineer, and an apportionment recomputed at settlement time
-- is an apportionment that can disagree with the one that was booked.
ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "discount_minor" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint

-- A discount is never a surcharge and never a negative price. It MAY equal the
-- price: the sale is then worth nothing, and the ledger refuses to book a sale
-- of zero — which is the right place for that refusal, not here.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_discount_within_price"
  CHECK (discount_minor >= 0 AND discount_minor <= unit_price_minor);
--> statement-breakpoint

-- --- 2. the immutability trigger learns about it IN THE SAME MIGRATION -----
-- 0042's own words, and they are still the point: "a snapshot column the
-- trigger does not name is a snapshot column anybody can rewrite". A discount
-- that could be edited after the sale is a commission that could be edited
-- after the sale, because one is computed from the other.
CREATE OR REPLACE FUNCTION order_items_snapshot_is_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.snapshot_taken_at IS NULL THEN
      RETURN NEW;  -- the sale is being recorded for the first time
    END IF;

    IF NEW.unit_price_minor   IS DISTINCT FROM OLD.unit_price_minor
    OR NEW.discount_minor     IS DISTINCT FROM OLD.discount_minor
    OR NEW.currency           IS DISTINCT FROM OLD.currency
    OR NEW.commission_model   IS DISTINCT FROM OLD.commission_model
    OR NEW.engineer_bp        IS DISTINCT FROM OLD.engineer_bp
    OR NEW.engineer_amount_minor  IS DISTINCT FROM OLD.engineer_amount_minor
    OR NEW.platform_amount_minor  IS DISTINCT FROM OLD.platform_amount_minor
    OR NEW.tax_bp             IS DISTINCT FROM OLD.tax_bp
    OR NEW.tax_minor          IS DISTINCT FROM OLD.tax_minor
    OR NEW.net_minor          IS DISTINCT FROM OLD.net_minor
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

-- --- 3. the two arithmetic constraints move off the price and onto the paid -
--
-- 0042 wrote `tax + net = unit_price_minor` and `engineer + platform = net`.
-- The first is now false by exactly the discount, and a discounted sale is
-- refused by it. Replaced rather than dropped: with both in force the database
-- still proves the whole equation as two halves that cannot be satisfied
-- separately —
--
--     engineer + platform + tax + discount = unit_price_minor
--
-- COALESCE and the NULL guards keep every sale made before today valid: their
-- discount is 0, so `unit_price_minor - 0` is the price the old constraint
-- named, character for character in effect.
ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_tax_split_adds_up";
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tax_split_adds_up"
  CHECK (
    snapshot_taken_at IS NULL
    OR tax_minor IS NULL
    OR (net_minor IS NOT NULL
        AND tax_minor >= 0 AND net_minor >= 0
        AND tax_minor + net_minor = unit_price_minor - discount_minor)
  );
--> statement-breakpoint

ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_split_balances";
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_split_balances"
  CHECK (
    snapshot_taken_at IS NULL
    OR (engineer_amount_minor >= 0
        AND platform_amount_minor >= 0
        AND engineer_amount_minor + platform_amount_minor
            = COALESCE(net_minor, unit_price_minor - discount_minor))
  );
--> statement-breakpoint

-- --- 4. the order header states the same arithmetic ------------------------
-- 0020 checked only that the three amounts were non-negative, which left
-- `total` free to be anything at all. It is not anything: it is a definition.
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_amounts_non_negative";
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_non_negative"
  CHECK (
    subtotal_minor >= 0
    AND discount_minor >= 0
    AND total_minor >= 0
    AND discount_minor <= subtotal_minor
    AND total_minor = subtotal_minor - discount_minor
  );
--> statement-breakpoint

-- --- 5. NOBODY EDITS THE MONEY ON AN ORDER ---------------------------------
--
-- This is the "no unsafe way to change the calculation" half of OPEN-1, and it
-- is a trigger rather than a policy because ROW-level security protects rows,
-- not columns. `orders_update` deliberately lets a customer update their own
-- order while it is a DRAFT — that is how an order reaches AWAITING_PAYMENT —
-- and RLS has no way to say "this row, but not these four columns of it".
--
-- Two rules, and the second is the one that matters for the books:
--
--   a. a non-owner may never change an amount or the currency. No route does
--      today; this is what makes that a property of the database rather than
--      a property of the routes that happen to exist.
--   b. NOBODY changes them once the order is paid — the owner included. The
--      line-level snapshot has been immutable since 0020, but the header was
--      not, and a header that can be edited after the fact can contradict the
--      invoice already in the customer's hands.
CREATE OR REPLACE FUNCTION orders_amounts_are_controlled() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.subtotal_minor IS NOT DISTINCT FROM OLD.subtotal_minor
   AND NEW.discount_minor IS NOT DISTINCT FROM OLD.discount_minor
   AND NEW.total_minor    IS NOT DISTINCT FROM OLD.total_minor
   AND NEW.currency       IS NOT DISTINCT FROM OLD.currency
    THEN
      RETURN NEW;  -- nothing financial moved
    END IF;

    IF OLD.status IN ('PAID', 'COMPLETED', 'REFUNDED') THEN
      RAISE EXCEPTION
        'The amounts on a settled order are immutable (specification 13, OPEN-1)'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NOT app_is_owner() THEN
      RAISE EXCEPTION
        'Only the platform owner may change the amounts on an order (OPEN-1)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
  END;
  $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS orders_amount_guard ON "orders";
--> statement-breakpoint
CREATE TRIGGER orders_amount_guard
  BEFORE UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION orders_amounts_are_controlled();
--> statement-breakpoint

-- --- 6. the invoice carries the discount too -------------------------------
-- A tax invoice states what was charged, so `gross_minor` stays the amount
-- paid. The list price and the discount are stated BESIDE it rather than
-- folded into it: a document showing only the discounted figure cannot be
-- reconciled against the catalogue by whoever audits it.
--
-- `list_minor` is backfilled to `gross_minor` for every invoice already
-- issued, which is exactly true of them: none carried a discount, because none
-- could.
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "discount_minor" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "list_minor" bigint;
--> statement-breakpoint
UPDATE "invoices" SET "list_minor" = "gross_minor" WHERE "list_minor" IS NULL;
--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "list_minor" SET NOT NULL;
--> statement-breakpoint

-- An invoice that contradicts itself is worse than no invoice: it is the
-- document the customer keeps and the tax authority reads.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_discount_reconciles"
  CHECK (discount_minor >= 0 AND list_minor - discount_minor = gross_minor);
--> statement-breakpoint


-- ===========================================================================
-- PART TWO — OPEN-11: A PRODUCT IS BOUGHT ONCE
-- ===========================================================================

-- --- 7. ONE LIVE ENTITLEMENT PER PERSON PER PRODUCT ------------------------
--
-- THE INDEX THIS REPLACES WAS NO CONSTRAINT AT ALL for the case it looks like
-- it covers. `(customer_id, product_id, order_item_id)` is unique for every
-- second purchase too, because a second order carries a different order item —
-- so `ON CONFLICT DO NOTHING` on the grant never had a conflict to suppress,
-- and a buyer could pay twice for one file with nothing anywhere objecting.
--
-- PARTIAL, over `revoked_at IS NULL`. A revoked purchase must not block buying
-- the product again: nothing revokes one today (there are no refunds), but if
-- the owner ever takes access away, taking away the right to buy it again with
-- it would be a second punishment nobody decided on.
--
-- A unique index is the one control that no policy, no trigger ordering and no
-- future code path can talk its way past.
DROP INDEX IF EXISTS "entitlements_live_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_live_unique"
  ON "entitlements" ("customer_id", "product_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint

-- --- 8. AND THE REFUSAL ARRIVES BEFORE THE MONEY DOES ----------------------
--
-- The index above is the guarantee, but it fires at the worst possible moment:
-- when the owner approves a payment the customer has already made. Payment
-- here is MANUAL — an order can wait a day for approval — so a buyer who
-- clicks twice, or returns tomorrow having forgotten, can place a second order
-- and pay for it long before anything collides.
--
-- So the line is refused when it is created. Two conditions, because a
-- purchase is not instant:
--   a. they hold a live entitlement — they already own it;
--   b. they have an order line for it on any order that is not CANCELLED —
--      they are already in the middle of buying it.
--
-- SECURITY INVOKER, deliberately. `entitlements` and `orders` are both FORCE
-- ROW LEVEL SECURITY, which applies to the table owner as well, so SECURITY
-- DEFINER would buy nothing here (see the note in CLAUDE.md). It does not need
-- to: every row this reads belongs to the same customer as the row being
-- inserted, and both the customer and the owner can see their own — the only
-- two actors the insert policy on `order_items` admits at all.
CREATE OR REPLACE FUNCTION order_items_one_purchase_per_product() RETURNS trigger
  LANGUAGE plpgsql AS $$
  DECLARE
    buyer uuid;
  BEGIN
    SELECT o.customer_id INTO buyer FROM orders o WHERE o.id = NEW.order_id;

    IF buyer IS NULL THEN
      -- The order is not visible to this actor, so the insert is about to be
      -- refused by the row policy anyway. Refusing here too would replace a
      -- clean "not yours" with a confusing "already bought".
      RETURN NEW;
    END IF;

    /*
     * SERIALISE THIS BUYER AND THIS PRODUCT BEFORE LOOKING.
     *
     * Both checks below are read-then-write, and under READ COMMITTED neither
     * can see a row a concurrent transaction has inserted but not committed.
     * Two clicks a millisecond apart would therefore both find nothing and
     * both insert — and the buyer could end up paying for two orders the owner
     * can only ever approve one of. The unique index on `entitlements` would
     * still stop the second grant, but by then the money has moved, and this
     * platform has no refund with which to send it back.
     *
     * The lock is transaction-scoped, so the commit or the rollback releases
     * it, and it covers exactly (buyer, product): two different people buying
     * the same file never wait on each other.
     */
    PERFORM pg_advisory_xact_lock(
      hashtext(buyer::text || ':' || NEW.product_id::text)
    );

    IF EXISTS (
      SELECT 1 FROM entitlements e
       WHERE e.customer_id = buyer
         AND e.product_id  = NEW.product_id
         AND e.revoked_at IS NULL
    ) THEN
      RAISE EXCEPTION
        'This customer already owns this product (OPEN-11)'
        USING ERRCODE = 'unique_violation';
    END IF;

    IF EXISTS (
      SELECT 1 FROM order_items oi
        JOIN orders o2 ON o2.id = oi.order_id
       WHERE o2.customer_id = buyer
         AND oi.product_id  = NEW.product_id
         AND oi.id         <> NEW.id
         AND o2.status     <> 'CANCELLED'
    ) THEN
      RAISE EXCEPTION
        'This customer already has a live order for this product (OPEN-11)'
        USING ERRCODE = 'unique_violation';
    END IF;

    RETURN NEW;
  END;
  $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS order_items_single_purchase_guard ON "order_items";
--> statement-breakpoint
CREATE TRIGGER order_items_single_purchase_guard
  BEFORE INSERT ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION order_items_one_purchase_per_product();
--> statement-breakpoint
