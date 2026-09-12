-- ---------------------------------------------------------------------------
-- The customer's path to the original file (specification §41).
--
-- Phase P3 left this deliberately closed: entitlements did not exist yet, so
-- rather than write a permissive placeholder policy that someone would later
-- have to remember to tighten, there was simply NO path from a customer to an
-- original. This opens exactly one, and only through a live entitlement.
--
-- "Live" means granted and not revoked. A refund revokes the row rather than
-- deleting it (§37), and the file closes the moment it does.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "product_files_select" ON "product_files";--> statement-breakpoint

CREATE POLICY "product_files_select" ON "product_files" FOR SELECT
  USING (
    app_is_owner()
    -- A credited contributor may reach their own product's original.
    OR EXISTS (
      SELECT 1 FROM product_contributors pc
       WHERE pc.product_id = product_files.product_id
         AND pc.contributor_id = app_contributor_id()
    )
    -- A customer who owns it, for as long as they own it.
    OR EXISTS (
      SELECT 1 FROM entitlements e
       WHERE e.product_id = product_files.product_id
         AND e.customer_id = app_actor_id()
         AND e.revoked_at IS NULL
    )
    -- Previews and thumbnails of a published product are public.
    OR (
      product_files.role IN ('PREVIEW', 'THUMBNAIL')
      AND EXISTS (
        SELECT 1 FROM products p
         WHERE p.id = product_files.product_id AND p.status = 'PUBLISHED'
      )
    )
  );
--> statement-breakpoint

-- Counting a download is the one field a customer's own action changes on
-- their entitlement. Kept as a function so the update cannot be widened into
-- "a customer may edit their entitlement".
CREATE OR REPLACE FUNCTION app_record_entitlement_download(p_entitlement_id uuid)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE v_count integer;
  BEGIN
    UPDATE entitlements
       SET download_count = download_count + 1,
           last_downloaded_at = now()
     WHERE id = p_entitlement_id
       AND revoked_at IS NULL
       AND (max_downloads IS NULL OR download_count < max_downloads)
     RETURNING download_count INTO v_count;

    IF v_count IS NULL THEN
      RAISE EXCEPTION 'Entitlement is revoked or its download allowance is spent'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN v_count;
  END;
  $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_record_entitlement_download(uuid) TO app_user;
