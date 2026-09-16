-- ===========================================================================
-- OPEN-4 / decisions §6 — A CREDIT SHARE IS A TERM, NOT A FACT TO PUBLISH
-- ===========================================================================
-- `product_contributors_select` let a contributor read their own credit row.
-- The row carries `share_bp`, and on a CO-AUTHORED product that one number
-- turns the engineer's own pay into everybody else's:
--
--     pot            = my amount x 10000 / my share_bp
--     others' total  = pot - my amount
--
-- Exact to the minor unit, because `distributeEngineerAmount` divides strictly
-- in proportion and the shares total exactly 10000 by constraint. On a
-- two-author product "others' total" is one named person's pay — precisely
-- what decisions §6 says an engineer must never learn.
--
-- WHAT THIS DOES AND DOES NOT CLOSE. Measured, not assumed, in
-- `src/authz/contributor-isolation.itest.ts`:
--
--   CLOSED — the MINORITY co-author's only route. They do not know the
--   governing commission rate (on a co-authored product it is the PRIMARY
--   author's, and §12 keeps it private), so scaling their own pay by their own
--   credit share was the one way to reach the pot. It is now gone.
--
--   STILL OPEN — the PRIMARY co-author. Their own agreement governs the sale,
--   they are a party to it, and the price is public on the product page:
--   pot = (price - tax) x their own rate, with no reference to this table at
--   all. No policy anywhere closes that; it needs a commission rate per
--   co-author, which is OPEN-15 and an undecided business rule. Recorded as
--   KI-3 in docs/KNOWN-ISSUES.md.
--
-- NOTHING LOSES ACCESS THAT WAS USING IT — the same test 0043 had to pass.
-- `share_bp` is read by exactly three paths, all of them the owner's: the sale
-- resolver, the publish-readiness count, and the owner's own editor. No
-- contributor-facing screen displays a credit share, so no screen changes.
--
-- If the owner later wants an engineer to see their own credit percentage,
-- that is a product decision that re-opens the inference above for every
-- co-author, not only the primary. It belongs with OPEN-15, not here.
-- ===========================================================================


-- --- 1. the question the other policies actually ask -----------------------
--
-- Three policies reference `product_contributors`, and none of them wants a
-- share: they want to know WHETHER this actor is credited on this product, so
-- that an engineer can still reach their own unpublished product, its price
-- and its files. That is a boolean, and a boolean discloses nothing.
--
-- SECURITY DEFINER, because the policies below must keep working after the
-- table's own policy stops admitting contributors. A policy expression is
-- evaluated as the querying user, and row-level security on a table named
-- INSIDE a policy still applies — so without this the three policies would
-- silently narrow to the owner and every engineer would lose their own drafts.
--
-- Safe to define this way for the usual two reasons: `product_contributors` is
-- deliberately NOT `FORCE ROW LEVEL SECURITY` (CLAUDE.md records why), and the
-- function returns one boolean about the CALLER — it takes no contributor id,
-- so there is no argument that makes it answer about somebody else.
CREATE OR REPLACE FUNCTION app_is_credited_on(p_product_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT app_contributor_id() IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM product_contributors pc
        WHERE pc.product_id = p_product_id
          AND pc.contributor_id = app_contributor_id()
     );
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_is_credited_on(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_is_credited_on(uuid) TO app_user;
--> statement-breakpoint


-- --- 2. the three dependent policies, unchanged in meaning -----------------
-- Each `EXISTS (SELECT 1 FROM product_contributors ...)` becomes the call.
-- Every other branch is copied across character for character: a contributor
-- keeps their drafts, a customer keeps the files they are entitled to, and the
-- public keeps published products, current prices and previews.

DROP POLICY IF EXISTS "products_select" ON "products";
--> statement-breakpoint
CREATE POLICY "products_select" ON "products" FOR SELECT
  USING (
    app_is_owner()
    OR status = 'PUBLISHED'
    OR app_is_credited_on(products.id)
  );
--> statement-breakpoint

DROP POLICY IF EXISTS "product_prices_select" ON "product_prices";
--> statement-breakpoint
CREATE POLICY "product_prices_select" ON "product_prices" FOR SELECT
  USING (
    app_is_owner()
    OR app_is_credited_on(product_prices.product_id)
    OR (effective_to IS NULL
        AND EXISTS (SELECT 1 FROM products p
                     WHERE p.id = product_prices.product_id
                       AND p.status = 'PUBLISHED'))
  );
--> statement-breakpoint

DROP POLICY IF EXISTS "product_files_select" ON "product_files";
--> statement-breakpoint
CREATE POLICY "product_files_select" ON "product_files" FOR SELECT
  USING (
    app_is_owner()
    OR app_is_credited_on(product_files.product_id)
    OR EXISTS (SELECT 1 FROM entitlements e
                WHERE e.product_id = product_files.product_id
                  AND e.customer_id = app_actor_id()
                  AND e.revoked_at IS NULL)
    OR (role IN ('PREVIEW', 'THUMBNAIL')
        AND EXISTS (SELECT 1 FROM products p
                     WHERE p.id = product_files.product_id
                       AND p.status = 'PUBLISHED'))
  );
--> statement-breakpoint


-- --- 3. and the share itself becomes the owner's alone ---------------------
-- The write policy was already owner-only; this is the read half catching up.
DROP POLICY IF EXISTS "product_contributors_select" ON "product_contributors";
--> statement-breakpoint
CREATE POLICY "product_contributors_select" ON "product_contributors" FOR SELECT
  USING (app_is_owner());
--> statement-breakpoint
