-- ---------------------------------------------------------------------------
-- Specification §28 wants the public product page to show the author's name.
-- Specification §12 forbids the public from seeing how revenue is split.
--
-- Those are two different facts about the same table, so RLS alone cannot
-- serve both: the credit rows are hidden from the public entirely, which is
-- correct for the share and wrong for the name.
--
-- This function is the seam. It returns display names of ACTIVE contributors
-- credited on a PUBLISHED product — and nothing else. There is no code path
-- through which share_bp reaches an unauthenticated caller.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_public_product_authors(p_product_id uuid)
  RETURNS TABLE (contributor_slug text, display_name text, specialization text)
  LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
    SELECT c.public_slug, COALESCE(pc.credit_label, c.display_name), c.specialization
      FROM product_contributors pc
      JOIN contributors c ON c.id = pc.contributor_id
      JOIN products p ON p.id = pc.product_id
     WHERE pc.product_id = p_product_id
       AND c.is_active = true
       AND p.status = 'PUBLISHED'
     ORDER BY pc.share_bp DESC, c.display_name;
  $$;
--> statement-breakpoint

-- Published counts for a contributor's public profile (specification §31).
CREATE OR REPLACE FUNCTION app_public_contributor_product_count(p_contributor_slug text)
  RETURNS integer
  LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
    SELECT count(*)::int
      FROM product_contributors pc
      JOIN contributors c ON c.id = pc.contributor_id
      JOIN products p ON p.id = pc.product_id
     WHERE c.public_slug = p_contributor_slug
       AND c.is_active = true
       AND p.status = 'PUBLISHED';
  $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  app_public_product_authors(uuid),
  app_public_contributor_product_count(text)
TO app_user;
