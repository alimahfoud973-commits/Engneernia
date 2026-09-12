-- ---------------------------------------------------------------------------
-- A contributor's public profile lists their published work (specification
-- §31). The link between a contributor and a product lives in
-- product_contributors, which is invisible to the public because the same row
-- carries the revenue share (§12).
--
-- Same seam as app_public_product_authors: one narrow function that returns
-- the PRODUCTS and never the share.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_public_contributor_products(p_contributor_slug text)
  RETURNS TABLE (
    slug text,
    title_ar text,
    subtitle_ar text,
    discipline_slug text,
    discipline_name_ar text,
    category_name_ar text,
    file_type text,
    level text,
    is_free boolean,
    price_minor bigint,
    currency text,
    published_at timestamptz
  )
  LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
    SELECT p.slug, p.title_ar, p.subtitle_ar,
           d.slug, d.name_ar, c.name_ar,
           p.file_type::text, p.level::text, p.is_free,
           pr.amount_minor, p.currency, p.published_at
      FROM product_contributors pc
      JOIN contributors ct ON ct.id = pc.contributor_id
      JOIN products p ON p.id = pc.product_id
      JOIN disciplines d ON d.id = p.discipline_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN product_prices pr
             ON pr.product_id = p.id AND pr.effective_to IS NULL
     WHERE ct.public_slug = p_contributor_slug
       AND ct.is_active = true
       AND p.status = 'PUBLISHED'
     ORDER BY p.published_at DESC;
  $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_public_contributor_products(text) TO app_user;
