-- ===========================================================================
-- CATALOG VISIBILITY (specification §3.3, §10, §12, §28)
--
-- Three tiers, enforced in the database:
--   PUBLIC       — published products, active disciplines and categories.
--   CONTRIBUTOR  — their own products in ANY state, and their own credit rows.
--   OWNER        — everything.
--
-- Note what is deliberately absent from every public policy: price HISTORY,
-- commission, and credit shares. The public reads the current price through a
-- view; it can never see what a product used to cost or how revenue is split.
-- ===========================================================================

ALTER TABLE "disciplines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "disciplines_select" ON "disciplines" FOR SELECT
  USING (app_is_owner() OR "is_active" = true);
--> statement-breakpoint
CREATE POLICY "disciplines_write" ON "disciplines" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "categories_select" ON "categories" FOR SELECT
  USING (app_is_owner() OR "is_active" = true);
--> statement-breakpoint
CREATE POLICY "categories_write" ON "categories" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- --- products -------------------------------------------------------------
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- A product that is not PUBLISHED does not exist as far as the public is
-- concerned. A contributor sees their own regardless of state, so they can
-- work on a draft and watch it move through review.
CREATE POLICY "products_select" ON "products" FOR SELECT
  USING (
    app_is_owner()
    OR "status" = 'PUBLISHED'
    OR EXISTS (
      SELECT 1 FROM product_contributors pc
       WHERE pc.product_id = products.id
         AND pc.contributor_id = app_contributor_id()
    )
  );
--> statement-breakpoint

-- Creation and state changes belong to the owner. A contributor with draft
-- rights submits through a SECURITY DEFINER function (below) that can only
-- move a product they are credited on, and only between the two states a
-- contributor is allowed to touch.
CREATE POLICY "products_write" ON "products" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- --- product_contributors -------------------------------------------------
ALTER TABLE "product_contributors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_contributors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A contributor sees only their OWN credit rows. They never learn who else is
-- credited on a shared product, nor with what share — that is a private
-- financial agreement (specification §12).
CREATE POLICY "product_contributors_select" ON "product_contributors" FOR SELECT
  USING (app_is_owner() OR "contributor_id" = app_contributor_id());
--> statement-breakpoint
CREATE POLICY "product_contributors_write" ON "product_contributors" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- --- product_prices -------------------------------------------------------
ALTER TABLE "product_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_prices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The CURRENT price of a published product is public. Price HISTORY is not:
-- the `effective_to IS NULL` condition is what separates them, and it is
-- enforced here rather than left to a WHERE clause someone might forget.
CREATE POLICY "product_prices_select" ON "product_prices" FOR SELECT
  USING (
    app_is_owner()
    OR EXISTS (
      SELECT 1 FROM product_contributors pc
       WHERE pc.product_id = product_prices.product_id
         AND pc.contributor_id = app_contributor_id()
    )
    OR (
      product_prices.effective_to IS NULL
      AND EXISTS (
        SELECT 1 FROM products p
         WHERE p.id = product_prices.product_id AND p.status = 'PUBLISHED'
      )
    )
  );
--> statement-breakpoint

CREATE POLICY "product_prices_write" ON "product_prices" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- ===========================================================================
-- PRICE CHANGES ARE ATOMIC (specification §34)
--
-- Closing the old row and opening the new one must happen together, or the
-- partial unique index would briefly see two open prices — or worse, none.
-- One function, one transaction, no window in which the price is ambiguous.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_set_product_price(
  p_product_id uuid, p_amount_minor bigint, p_currency text,
  p_changed_by uuid, p_reason text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE v_new_id uuid; v_now timestamptz := now();
  BEGIN
    IF NOT app_is_owner() THEN
      RAISE EXCEPTION 'Only the platform owner may change a price'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_amount_minor < 0 THEN
      RAISE EXCEPTION 'Price cannot be negative' USING ERRCODE = 'check_violation';
    END IF;

    UPDATE product_prices
       SET effective_to = v_now
     WHERE product_id = p_product_id AND effective_to IS NULL;

    INSERT INTO product_prices
      (product_id, amount_minor, currency, effective_from, changed_by, reason)
    VALUES (p_product_id, p_amount_minor, p_currency, v_now, p_changed_by, p_reason)
    RETURNING id INTO v_new_id;

    UPDATE products
       SET is_free = (p_amount_minor = 0), currency = p_currency, updated_at = v_now
     WHERE id = p_product_id;

    RETURN v_new_id;
  END;
  $$;
--> statement-breakpoint

-- ===========================================================================
-- CONTRIBUTOR DRAFT SUBMISSION (specification §3.2)
--
-- The only write a contributor can make to a product, and only when the owner
-- has granted `can_submit_drafts`. It cannot reach any other column, cannot
-- touch a product they are not credited on, and cannot move a product into
-- any state except SUBMITTED.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_submit_product_for_review(p_product_id uuid)
  RETURNS product_status
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE v_status product_status; v_allowed boolean;
  BEGIN
    SELECT EXISTS (
      SELECT 1
        FROM product_contributors pc
        JOIN contributors c ON c.id = pc.contributor_id
       WHERE pc.product_id = p_product_id
         AND pc.contributor_id = app_contributor_id()
         AND c.is_active = true
         AND c.can_submit_drafts = true
    ) INTO v_allowed;

    IF NOT v_allowed THEN
      RAISE EXCEPTION 'Not permitted to submit this product'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT status INTO v_status FROM products WHERE id = p_product_id;

    IF v_status NOT IN ('DRAFT', 'REVISION_REQUESTED') THEN
      RAISE EXCEPTION 'A product in state % cannot be submitted for review', v_status
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE products SET status = 'SUBMITTED', updated_at = now() WHERE id = p_product_id;
    RETURN 'SUBMITTED'::product_status;
  END;
  $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  app_set_product_price(uuid, bigint, text, uuid, text),
  app_submit_product_for_review(uuid)
TO app_user;
