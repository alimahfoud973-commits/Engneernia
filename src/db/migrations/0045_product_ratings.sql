-- ============================================================================
-- PRODUCT RATINGS (OPEN-14) — BEHIND A FLAG, SCORE ONLY
-- ============================================================================
-- The owner's decisions: a score from 1 to 5 and no written review in the first
-- release, and the public sees an average and a count — never who rated.
--
-- WHY NO FREE TEXT. A single owner cannot moderate Arabic prose daily, and an
-- unmoderated review lands on an engineer's product page before anybody has
-- read it. The column can be added later on top of this table without touching
-- a row that already exists.
--
-- WHY THE PUBLIC READS AN AGGREGATE AND NOT THE ROWS. A visitor who can list
-- the ratings of a product can list who bought it, which is precisely what
-- OPEN-4 settled must never happen. So `product_ratings` is readable only by
-- the owner and by the person who wrote the row, and the average reaches the
-- catalogue through one SECURITY DEFINER function that returns two numbers.
--
-- WHY THE ENTITLEMENT IS IN THE POLICY. "Only a buyer may rate" is not a rule
-- the application gets to remember: it is written into WITH CHECK, so a rating
-- from someone who never bought the product cannot be inserted from a route, a
-- server action, or a psql prompt holding the application's own credentials.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "product_ratings" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id"  uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- Constrained here as well as in the application: a score of 0 or 9 is not a
  -- value this platform can be talked into storing.
  "score"       smallint NOT NULL CHECK ("score" BETWEEN 1 AND 5),
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One voice per buyer per product. Re-rating updates the row rather than
-- stacking a second opinion on the same purchase.
CREATE UNIQUE INDEX IF NOT EXISTS "product_ratings_one_per_customer"
  ON "product_ratings" ("product_id", "customer_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "product_ratings_product_idx"
  ON "product_ratings" ("product_id");
--> statement-breakpoint

ALTER TABLE "product_ratings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Deliberately NOT forced: the aggregate function below is SECURITY DEFINER and
-- owns this table, and FORCE would disable it for the very query the catalogue
-- depends on. See the note in CLAUDE.md about FORCE and trusted functions.

-- The owner reads every rating; a customer reads their own. Nobody else reads a
-- row at all — not the engineer whose product it is, and not the public.
CREATE POLICY "product_ratings_select" ON "product_ratings" FOR SELECT
  USING (app_is_owner() OR "customer_id" = app_actor_id());
--> statement-breakpoint

-- A rating is only insertable by the person it belongs to, and only for a
-- product they hold a live entitlement to. Both halves matter: the first stops
-- rating on somebody else's behalf, the second stops rating without buying.
CREATE POLICY "product_ratings_insert" ON "product_ratings" FOR INSERT
  WITH CHECK (
    "customer_id" = app_actor_id()
    AND EXISTS (
      SELECT 1 FROM entitlements e
       WHERE e.product_id = product_ratings.product_id
         AND e.customer_id = app_actor_id()
         AND e.revoked_at IS NULL
    )
  );
--> statement-breakpoint

-- Changing your mind is allowed; changing somebody else's is not. The
-- entitlement is re-checked, so a revoked purchase freezes the rating it left
-- behind rather than letting it be edited afterwards.
CREATE POLICY "product_ratings_update" ON "product_ratings" FOR UPDATE
  USING ("customer_id" = app_actor_id())
  WITH CHECK (
    "customer_id" = app_actor_id()
    AND EXISTS (
      SELECT 1 FROM entitlements e
       WHERE e.product_id = product_ratings.product_id
         AND e.customer_id = app_actor_id()
         AND e.revoked_at IS NULL
    )
  );
--> statement-breakpoint

-- Only the owner removes a rating, and only as moderation. A customer who
-- regrets a score edits it.
CREATE POLICY "product_ratings_delete" ON "product_ratings" FOR DELETE
  USING (app_is_owner());
--> statement-breakpoint

