-- ===========================================================================
-- A DOWNLOAD IS COUNTED ONLY INSIDE THE SIX-MONTH WINDOW (S4-03, S4-07)
--
-- Delivery authorises, reads the object, then counts (S4-07). Between the
-- first and the last step a grant's window can close; the counter must then
-- refuse like it refuses a revoked grant, so nothing is sent on a right that
-- has just ended. Row-Level Security already hides an expired buyer's file
-- (migration 0059); this is the same rule where the count is written.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_record_entitlement_download(p_entitlement_id uuid)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE v_count integer;
  BEGIN
    UPDATE entitlements
       SET download_count = download_count + 1,
           last_downloaded_at = now()
     WHERE id = p_entitlement_id
       AND revoked_at IS NULL
       AND expires_at > now()
       AND (max_downloads IS NULL OR download_count < max_downloads)
     RETURNING download_count INTO v_count;

    IF v_count IS NULL THEN
      RAISE EXCEPTION 'Entitlement is revoked, past its download window, or its allowance is spent'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN v_count;
  END;
  $$;
--> statement-breakpoint

-- ===========================================================================
-- THE WINDOW IS COMPUTED, NEVER SUPPLIED
--
-- 0059's grant trigger kept a caller's `expires_at` when one was given, so a
-- direct insert could grant a window of any length, and a future `granted_at`
-- could stretch it the same way. The end of the window is now always the
-- purchase date plus the setting, and the purchase date is never later than
-- the moment of the grant.
-- ===========================================================================
CREATE OR REPLACE FUNCTION entitlements_fill_version_and_window() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
  BEGIN
    IF NEW.version_id IS NULL AND NEW.order_item_id IS NOT NULL THEN
      SELECT oi.version_id INTO NEW.version_id FROM order_items oi WHERE oi.id = NEW.order_item_id;
    END IF;
    IF NEW.version_id IS NULL THEN
      SELECT p.current_version_id INTO NEW.version_id FROM products p WHERE p.id = NEW.product_id;
    END IF;
    IF NEW.version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM product_versions v WHERE v.id = NEW.version_id AND v.product_id = NEW.product_id
    ) THEN
      RAISE EXCEPTION 'An entitlement must name a version of its own product'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.granted_at := LEAST(COALESCE(NEW.granted_at, now()), now());
    NEW.expires_at := NEW.granted_at + make_interval(months => app_entitlement_months());
    RETURN NEW;
  END;
  $$;
