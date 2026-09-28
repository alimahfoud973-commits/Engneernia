-- ===========================================================================
-- STAGE 5 — THE OWNER'S FINAL DECISIONS (2026-09-28)
--
--   1. A deactivated engineer's products stay on the platform, unsellable,
--      for ONE MONTH from the deactivation; only then may the owner delete
--      (archive) them. Deleting a product never deletes a sale, a snapshot,
--      an entitlement, a statement or an audit row.
--   2. The price is the final price, tax included — already how the system
--      works (OPEN-9, `extractTax`); nothing here changes it.
--   3. FIXED_BOTH: a fixed amount for the engineer AND one for the platform,
--      each scaled by the discount, with what was paid divided between the
--      two in the ratio of those amounts.
--
-- Written after 0062 was applied and pushed, so 0062 is not edited: its two
-- model-shape constraints are replaced here (CLAUDE.md, migration rule).
--
-- ALTER TYPE ... ADD VALUE runs inside the migrator's transaction, where the
-- new value may not yet be USED. The constraints below therefore compare the
-- model as text, which names the value without using it.
-- ===========================================================================

ALTER TYPE "commission_model" ADD VALUE IF NOT EXISTS 'FIXED_BOTH';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. FIXED_BOTH — the agreement carries both amounts; their sum is positive,
--    because a pot is divided in their ratio.
-- ---------------------------------------------------------------------------
ALTER TABLE commission_agreements DROP CONSTRAINT IF EXISTS commission_agreements_model_shape;--> statement-breakpoint
ALTER TABLE commission_agreements
  ADD CONSTRAINT commission_agreements_model_shape CHECK (
       (model::text = 'PERCENTAGE' AND engineer_bp IS NOT NULL
          AND engineer_fixed_minor IS NULL AND platform_fixed_minor IS NULL)
    OR (model::text = 'FIXED_ENGINEER' AND engineer_fixed_minor IS NOT NULL AND engineer_fixed_minor >= 0
          AND engineer_bp IS NULL AND platform_fixed_minor IS NULL)
    OR (model::text = 'FIXED_PLATFORM' AND platform_fixed_minor IS NOT NULL AND platform_fixed_minor >= 0
          AND engineer_bp IS NULL AND engineer_fixed_minor IS NULL)
    OR (model::text = 'FIXED_BOTH'
          AND engineer_fixed_minor IS NOT NULL AND engineer_fixed_minor >= 0
          AND platform_fixed_minor IS NOT NULL AND platform_fixed_minor >= 0
          AND engineer_fixed_minor + platform_fixed_minor > 0
          AND engineer_bp IS NULL)
  );--> statement-breakpoint

-- The frozen per-engineer row: the same four shapes (0050's constraint, with
-- FIXED_BOTH added). Existing rows keep satisfying it unchanged.
ALTER TABLE order_item_contributors DROP CONSTRAINT IF EXISTS order_item_contributors_model_shape;--> statement-breakpoint
ALTER TABLE order_item_contributors
  ADD CONSTRAINT order_item_contributors_model_shape CHECK (
       commission_model IS NULL
    OR (commission_model::text = 'PERCENTAGE' AND engineer_bp IS NOT NULL
          AND engineer_bp >= 0 AND engineer_bp <= 10000)
    OR (commission_model::text = 'FIXED_ENGINEER' AND engineer_fixed_minor IS NOT NULL)
    OR (commission_model::text = 'FIXED_PLATFORM' AND platform_fixed_minor IS NOT NULL)
    OR (commission_model::text = 'FIXED_BOTH'
          AND engineer_fixed_minor IS NOT NULL AND platform_fixed_minor IS NOT NULL)
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. WHEN WAS THIS ENGINEER DEACTIVATED?
--
-- Kept by the database: set when is_active turns false, cleared when it
-- turns true, and otherwise left as it was — so the one-month clock cannot
-- be moved by writing the column, only by the deactivation itself. (The
-- integration suite's superuser purge flag may set it, to test a month
-- without waiting one.)
-- ---------------------------------------------------------------------------
ALTER TABLE contributors ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;--> statement-breakpoint

-- Engineers already inactive are dated from the audit log: the moment the
-- owner last deactivated them. One with no such row (created inactive, the
-- default, and never switched) starts its clock now — the conservative
-- answer: a month from today, never earlier. Done BEFORE the trigger below
-- exists, which would otherwise keep the column as it was.
UPDATE contributors c
   SET deactivated_at = COALESCE(
         (SELECT MAX(a.created_at) FROM audit_logs a
           WHERE a.action = 'CONTRIBUTOR_DEACTIVATED'
             AND a.entity_type = 'contributor'
             AND a.entity_id = c.id::text),
         now())
 WHERE NOT c.is_active AND c.deactivated_at IS NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION contributors_track_deactivation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
  BEGIN
    IF app_financial_purge_requested() THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW.deactivated_at := CASE WHEN NEW.is_active THEN NULL ELSE NEW.deactivated_at END;
      RETURN NEW;
    END IF;
    IF OLD.is_active AND NOT NEW.is_active THEN
      NEW.deactivated_at := now();
    ELSIF NOT OLD.is_active AND NEW.is_active THEN
      NEW.deactivated_at := NULL;
    ELSE
      NEW.deactivated_at := OLD.deactivated_at;
    END IF;
    RETURN NEW;
  END;
$$;--> statement-breakpoint

CREATE TRIGGER contributors_track_deactivation BEFORE INSERT OR UPDATE ON contributors
  FOR EACH ROW EXECUTE FUNCTION contributors_track_deactivation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. IS THIS PRODUCT ON HOLD — credited to a deactivated engineer?
--
-- One yes/no answer about one product, and nothing else. SECURITY DEFINER BY
-- NECESSITY: the question is asked for a buyer or a guest — to write their
-- order line (0062) and to show "not available" instead of a buy button that
-- fails — and neither may read the credits (0049) or an inactive profile.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_product_on_hold(p_product_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM product_contributors pc
      JOIN contributors c ON c.id = pc.contributor_id
     WHERE pc.product_id = p_product_id
       AND NOT c.is_active
  );
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_product_on_hold(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_product_on_hold(uuid) TO app_user;--> statement-breakpoint

-- The order-line guard of 0062 asks the same function, so the page and the
-- database cannot disagree about what is on hold.
CREATE OR REPLACE FUNCTION order_items_credits_active() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  BEGIN
    IF app_product_on_hold(NEW.product_id) THEN
      RAISE EXCEPTION 'This product is credited to a deactivated engineer and cannot be sold (D-05)'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_credits_active';
    END IF;
    RETURN NEW;
  END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. NO DELETION WITHIN THE MONTH.
--
-- "Deleting" a product is archiving it: the product leaves the platform, and
-- every sale, snapshot, entitlement (with its six-month download window —
-- Stage 4), statement and audit row stays, as the 0062 guards require. The
-- move to ARCHIVED is the owner's alone already (the transition table and
-- the products write policy); this adds the month.
--
-- Invoker's rights: only the owner can reach this UPDATE, and the owner
-- reads every credit and profile.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION products_hold_period_before_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
  DECLARE
    until timestamptz;
  BEGIN
    IF NEW.status::text <> 'ARCHIVED' OR OLD.status::text = 'ARCHIVED' THEN
      RETURN NEW;
    END IF;
    SELECT MAX(c.deactivated_at) + interval '1 month' INTO until
      FROM product_contributors pc
      JOIN contributors c ON c.id = pc.contributor_id
     WHERE pc.product_id = NEW.id
       AND NOT c.is_active;
    IF until IS NOT NULL AND until > now() THEN
      RAISE EXCEPTION 'A deactivated engineer''s product stays on the platform for one month; it may be deleted from %', until
        USING ERRCODE = 'check_violation', CONSTRAINT = 'products_hold_period';
    END IF;
    RETURN NEW;
  END;
$$;--> statement-breakpoint

CREATE TRIGGER products_hold_period_before_delete BEFORE UPDATE OF status ON products
  FOR EACH ROW EXECUTE FUNCTION products_hold_period_before_delete();
