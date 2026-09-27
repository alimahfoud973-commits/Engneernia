-- ===========================================================================
-- PRODUCT VERSIONS, THE SIX-MONTH DOWNLOAD WINDOW, AND UPGRADES
-- (Stage 4 repair — S4-03, S4-04, S4-05, S4-06, S4-09, S4-10; owner decisions)
--
-- What the owner decided:
--   * A purchase grants the right to download for SIX MONTHS from the purchase
--     date — every purchase, the ones already made included. Unpublishing,
--     archiving, replacing or deleting the file does not shorten it; after it,
--     the platform no longer has to provide the file.
--   * A file replaced on a product is a NEW VERSION. The version a customer
--     bought stays theirs (and stays stored) for their window; the new one is
--     not on sale until it passes the same checks as a first publication.
--   * A buyer of an earlier version may buy the current one at a discount —
--     50 % today, a setting, not a number in code — at any time.
--   * A version is still bought once (OPEN-11), now per version.
--   * Only the owner deletes a file. Deleting the version on sale takes the
--     product off sale. No purchase, order, payment or ledger row is touched.
--
-- Policy numbers are settings rows (CLAUDE.md): `downloads.entitlementMonths`
-- and `catalog.upgradeDiscountBp`. Both are public: a customer is told both.
-- ===========================================================================

-- --- settings ---------------------------------------------------------------
-- `settings` is FORCE ROW LEVEL SECURITY; owner context as 0017/0055 declare it.
SELECT set_config('app.actor_role', 'OWNER', true);--> statement-breakpoint

INSERT INTO "settings" ("key", "value", "description_ar", "is_public") VALUES
  ('downloads.entitlementMonths', '6', 'مدة حق التنزيل بالأشهر، من تاريخ الشراء', true),
  ('catalog.upgradeDiscountBp', '5000', 'خصم مشتري إصدار سابق عند شراء الإصدار الحالي، بنقاط الأساس من سعره', true)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

SELECT set_config('app.actor_role', '', true);--> statement-breakpoint

-- The window's length, read where every grant passes. No default: a missing
-- setting refuses the grant rather than inventing a period.
CREATE OR REPLACE FUNCTION app_entitlement_months() RETURNS integer
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
  DECLARE v integer;
  BEGIN
    SELECT (s.value #>> '{}')::integer INTO v FROM settings s WHERE s.key = 'downloads.entitlementMonths';
    IF v IS NULL OR v <= 0 THEN
      RAISE EXCEPTION 'downloads.entitlementMonths is not set to a positive number of months'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN v;
  END;
  $$;--> statement-breakpoint

-- --- product_versions ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS "product_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "version_no" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- The moment it went on sale; NULL while it waits for the owner's release.
  "activated_at" timestamp with time zone,
  -- The moment a newer version replaced it on sale.
  "superseded_at" timestamp with time zone,
  -- Owner deletion. The row stays: buyers' windows and history point at it.
  "deleted_at" timestamp with time zone,
  "deleted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- Its stored objects were removed once nobody could still claim them.
  "files_purged_at" timestamp with time zone,
  CONSTRAINT "product_versions_number_positive" CHECK ("version_no" > 0),
  CONSTRAINT "product_versions_purged_after_retired"
    CHECK ("files_purged_at" IS NULL OR "deleted_at" IS NOT NULL OR "superseded_at" IS NOT NULL OR "activated_at" IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_versions_number_unique" ON "product_versions" ("product_id", "version_no");--> statement-breakpoint

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "current_version_id" uuid
  REFERENCES "product_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "product_files" ADD COLUMN IF NOT EXISTS "version_id" uuid
  REFERENCES "product_versions"("id") ON DELETE CASCADE;--> statement-breakpoint

-- Every product that already has files gets one version holding them, on sale
-- if the product was ever published.
INSERT INTO "product_versions" ("product_id", "version_no", "created_at", "created_by", "activated_at")
SELECT f."product_id", 1, min(f."created_at"), (array_agg(f."uploaded_by" ORDER BY f."created_at"))[1],
       CASE WHEN p."published_at" IS NOT NULL THEN min(f."created_at") END
  FROM "product_files" f
  JOIN "products" p ON p."id" = f."product_id"
 WHERE NOT EXISTS (SELECT 1 FROM "product_versions" v WHERE v."product_id" = f."product_id")
 GROUP BY f."product_id", p."published_at";--> statement-breakpoint

UPDATE "product_files" f SET "version_id" = v."id", "version" = v."version_no"
  FROM "product_versions" v WHERE v."product_id" = f."product_id" AND f."version_id" IS NULL;--> statement-breakpoint
UPDATE "products" p SET "current_version_id" = v."id"
  FROM "product_versions" v WHERE v."product_id" = p."id" AND p."current_version_id" IS NULL;--> statement-breakpoint

ALTER TABLE "product_files" ALTER COLUMN "version_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "product_files_role_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_files_version_role_unique" ON "product_files" ("version_id", "role");--> statement-breakpoint

-- A version's files belong to the version's product.
CREATE OR REPLACE FUNCTION product_files_version_matches() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM product_versions v WHERE v.id = NEW.version_id AND v.product_id = NEW.product_id) THEN
      RAISE EXCEPTION 'A product file must belong to a version of its own product'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END;
  $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS product_files_version_guard ON "product_files";--> statement-breakpoint
CREATE TRIGGER product_files_version_guard BEFORE INSERT OR UPDATE ON "product_files"
  FOR EACH ROW EXECUTE FUNCTION product_files_version_matches();--> statement-breakpoint

-- The version on sale belongs to the product it is on sale for.
CREATE OR REPLACE FUNCTION products_current_version_matches() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
  BEGIN
    IF NEW.current_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM product_versions v WHERE v.id = NEW.current_version_id AND v.product_id = NEW.id AND v.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'The current version must be a live version of this product'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END;
  $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS products_current_version_guard ON "products";--> statement-breakpoint
CREATE TRIGGER products_current_version_guard BEFORE INSERT OR UPDATE OF "current_version_id" ON "products"
  FOR EACH ROW EXECUTE FUNCTION products_current_version_matches();--> statement-breakpoint

-- The version on sale cannot be taken away while the product is on sale: a
-- deletion must take the product off sale in the same transaction (S4-10,
-- owner decision), so nothing is left PUBLISHED with nothing to deliver.
-- Moving to PUBLISHED stays the application's gate (publishBlockers).
CREATE OR REPLACE FUNCTION products_published_keeps_version() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
  BEGIN
    IF NEW.status = 'PUBLISHED' AND NEW.current_version_id IS NULL AND OLD.current_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'A published product cannot lose its version on sale — unpublish it first'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END;
  $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS products_published_version_guard ON "products";--> statement-breakpoint
CREATE TRIGGER products_published_version_guard BEFORE UPDATE OF "status", "current_version_id" ON "products"
  FOR EACH ROW EXECUTE FUNCTION products_published_keeps_version();--> statement-breakpoint

-- --- what was sold: the version, and whether it was an upgrade ---------------
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "version_id" uuid
  REFERENCES "product_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "is_upgrade" boolean DEFAULT false NOT NULL;--> statement-breakpoint

SELECT set_config('app.actor_role', 'OWNER', true);--> statement-breakpoint
UPDATE "order_items" oi SET "version_id" = p."current_version_id"
  FROM "products" p WHERE p."id" = oi."product_id" AND oi."version_id" IS NULL;--> statement-breakpoint
SELECT set_config('app.actor_role', '', true);--> statement-breakpoint

-- Which version a line sold, and whether it was sold as an upgrade, is fixed
-- when the line is written: the discount and the grant both follow from it.
CREATE OR REPLACE FUNCTION order_items_version_is_fixed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
  BEGIN
    IF NEW.is_upgrade IS DISTINCT FROM OLD.is_upgrade
       OR (NEW.version_id IS DISTINCT FROM OLD.version_id AND NEW.version_id IS NOT NULL) THEN
      RAISE EXCEPTION 'The version sold on an order line is fixed once written'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END;
  $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS order_items_version_guard ON "order_items";--> statement-breakpoint
CREATE TRIGGER order_items_version_guard BEFORE UPDATE ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION order_items_version_is_fixed();--> statement-breakpoint

-- --- entitlements: per version, with an end -----------------------------------
ALTER TABLE "entitlements" ADD COLUMN IF NOT EXISTS "version_id" uuid
  REFERENCES "product_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint

UPDATE "entitlements" e SET "version_id" = COALESCE(
    (SELECT oi."version_id" FROM "order_items" oi WHERE oi."id" = e."order_item_id"),
    (SELECT p."current_version_id" FROM "products" p WHERE p."id" = e."product_id"))
 WHERE e."version_id" IS NULL;--> statement-breakpoint
-- Owner decision: purchases made before this change end six months after THEIR
-- purchase date too.
UPDATE "entitlements" SET "expires_at" = "granted_at" + make_interval(months => app_entitlement_months())
 WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_window_after_grant" CHECK ("expires_at" > "granted_at");--> statement-breakpoint

DROP INDEX IF EXISTS "entitlements_live_unique";--> statement-breakpoint
-- Bought once per version (OPEN-11, owner decision on versions). A grant on a
-- product that never had a file (no version) keeps the per-product rule.
CREATE UNIQUE INDEX IF NOT EXISTS "entitlements_live_unique"
  ON "entitlements" ("customer_id", "version_id") WHERE "revoked_at" IS NULL AND "version_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entitlements_live_unversioned_unique"
  ON "entitlements" ("customer_id", "product_id") WHERE "revoked_at" IS NULL AND "version_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entitlements_customer_product_idx" ON "entitlements" ("customer_id", "product_id");--> statement-breakpoint

-- Every grant — the paid path in the application and the free path in
-- app_complete_free_order (0054) — passes here: the version comes from the
-- order line, the end from the purchase date and the setting.
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
    NEW.granted_at := COALESCE(NEW.granted_at, now());
    IF NEW.expires_at IS NULL THEN
      NEW.expires_at := NEW.granted_at + make_interval(months => app_entitlement_months());
    END IF;
    RETURN NEW;
  END;
  $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS entitlements_fill_guard ON "entitlements";--> statement-breakpoint
CREATE TRIGGER entitlements_fill_guard BEFORE INSERT ON "entitlements"
  FOR EACH ROW EXECUTE FUNCTION entitlements_fill_version_and_window();--> statement-breakpoint

-- What a grant says it is for, and until when, does not move afterwards.
CREATE OR REPLACE FUNCTION entitlements_terms_are_fixed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
  BEGIN
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR (NEW.version_id IS DISTINCT FROM OLD.version_id AND NEW.version_id IS NOT NULL) THEN
      RAISE EXCEPTION 'The buyer, product, version and window of an entitlement are fixed once granted'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END;
  $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS entitlements_terms_guard ON "entitlements";--> statement-breakpoint
CREATE TRIGGER entitlements_terms_guard BEFORE UPDATE ON "entitlements"
  FOR EACH ROW EXECUTE FUNCTION entitlements_terms_are_fixed();--> statement-breakpoint

-- --- bought once, per version (replaces 0048's per-product guard) -------------
CREATE OR REPLACE FUNCTION order_items_one_purchase_per_product() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
  DECLARE
    buyer uuid;
  BEGIN
    SELECT o.customer_id INTO buyer FROM orders o WHERE o.id = NEW.order_id;
    IF buyer IS NULL THEN
      RETURN NEW;
    END IF;
    -- Serialise this buyer and this version (or product, for a line with no
    -- version) before looking — 0048 explains why a read-then-write needs it.
    PERFORM pg_advisory_xact_lock(
      hashtext(buyer::text || ':' || COALESCE(NEW.version_id::text, NEW.product_id::text))
    );
    IF EXISTS (
      SELECT 1 FROM entitlements e
       WHERE e.customer_id = buyer
         AND e.revoked_at IS NULL
         AND ((NEW.version_id IS NOT NULL AND e.version_id = NEW.version_id)
              OR (NEW.version_id IS NULL AND e.product_id = NEW.product_id))
    ) THEN
      RAISE EXCEPTION 'This customer already owns this version (OPEN-11)'
        USING ERRCODE = 'unique_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM order_items oi
        JOIN orders o2 ON o2.id = oi.order_id
       WHERE o2.customer_id = buyer
         AND oi.id <> NEW.id
         AND o2.status <> 'CANCELLED'
         AND ((NEW.version_id IS NOT NULL AND oi.version_id = NEW.version_id)
              OR (NEW.version_id IS NULL AND oi.product_id = NEW.product_id))
    ) THEN
      RAISE EXCEPTION 'This customer already has a live order for this version (OPEN-11)'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
  END;
  $$;--> statement-breakpoint

ALTER TABLE "product_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Not FORCE: the grant trigger and delivery read it under the caller.
CREATE POLICY "product_versions_select" ON "product_versions" FOR SELECT
  USING (
    app_is_owner()
    OR app_is_credited_on(product_id)
    OR EXISTS (SELECT 1 FROM entitlements e
                WHERE e.version_id = product_versions.id
                  AND e.customer_id = app_actor_id()
                  AND e.revoked_at IS NULL)
    OR EXISTS (SELECT 1 FROM products p
                WHERE p.id = product_versions.product_id
                  AND p.status = 'PUBLISHED'
                  AND p.current_version_id = product_versions.id)
  );--> statement-breakpoint
CREATE POLICY "product_versions_write" ON "product_versions" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());--> statement-breakpoint

-- --- who may read a product and its files -------------------------------------
-- A buyer keeps reading the product they bought after it leaves the catalogue:
-- their purchase stays in their account (S4-03). Catalogue queries name
-- PUBLISHED explicitly, so nothing unpublished reaches a listing through this.
DROP POLICY IF EXISTS "products_select" ON "products";--> statement-breakpoint
CREATE POLICY "products_select" ON "products" FOR SELECT
  USING (
    app_is_owner()
    OR status = 'PUBLISHED'
    OR app_is_credited_on(id)
    OR EXISTS (SELECT 1 FROM entitlements e
                WHERE e.product_id = products.id
                  AND e.customer_id = app_actor_id()
                  AND e.revoked_at IS NULL)
  );--> statement-breakpoint

-- The original of a version reaches its buyer while their window is open,
-- whatever the product's status and whether or not the version was deleted
-- from sale. A preview is public only for the version on sale.
DROP POLICY IF EXISTS "product_files_select" ON "product_files";--> statement-breakpoint
CREATE POLICY "product_files_select" ON "product_files" FOR SELECT
  USING (
    app_is_owner()
    OR app_is_credited_on(product_id)
    OR EXISTS (SELECT 1 FROM entitlements e
                WHERE e.customer_id = app_actor_id()
                  AND e.revoked_at IS NULL
                  AND e.expires_at > now()
                  AND (e.version_id = product_files.version_id
                       OR (e.version_id IS NULL AND e.product_id = product_files.product_id)))
    OR (role IN ('PREVIEW', 'THUMBNAIL')
        AND EXISTS (SELECT 1 FROM products p
                     WHERE p.id = product_files.product_id
                       AND p.status = 'PUBLISHED'
                       AND p.current_version_id = product_files.version_id))
  );--> statement-breakpoint

-- --- S4-06: a product always has a title ---------------------------------------
ALTER TABLE "products" ADD CONSTRAINT "products_title_present" CHECK ("title_ar" ~ '[^[:space:]]');
