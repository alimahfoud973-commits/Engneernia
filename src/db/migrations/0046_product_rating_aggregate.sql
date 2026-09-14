-- ============================================================================
-- THE ONLY THING THE PUBLIC LEARNS ABOUT RATINGS, AND THE FLAG THAT GOVERNS IT
-- ============================================================================
-- Split from 0045 because 0045 was already applied. An applied migration is
-- never edited — the same rule that produced 0026 → 0027.
--
-- A visitor who can list the ratings of a product can list who bought it, which
-- is what OPEN-4 settled must never happen. So `product_ratings` stays readable
-- only by its author and the owner, and the catalogue reaches an average
-- through this function alone.
-- ============================================================================

CREATE OR REPLACE FUNCTION app_product_rating(p_product_id uuid)
  RETURNS TABLE (rating_count integer, score_sum integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COUNT(*)::integer, COALESCE(SUM(r.score), 0)::integer
      FROM product_ratings r
     WHERE r.product_id = p_product_id;
  $$;
--> statement-breakpoint

-- The SUM and the COUNT, not the average: a rounded average computed in SQL and
-- one computed in TypeScript disagree eventually, and the display rounding
-- belongs with the display.
GRANT EXECUTE ON FUNCTION app_product_rating(uuid) TO app_user;
--> statement-breakpoint

-- Off. A flag is a row, not a constant, so turning ratings on later is an
-- UPDATE rather than an edit and a deploy.
--
-- `is_public` matters: the storefront reads settings as a GUEST, and
-- `settings_select` admits only the owner or a public row. A private flag would
-- be invisible to the very page it governs, and the feature would look broken
-- rather than disabled.
