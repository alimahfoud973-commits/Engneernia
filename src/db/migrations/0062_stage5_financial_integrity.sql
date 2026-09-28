-- ===========================================================================
-- STAGE 5 REPAIR — FINANCIAL INTEGRITY, ENGINEER ISOLATION, OWNER DECISIONS
--
-- One migration for every database-level part of the Stage 5 repair, each
-- section named after the finding or owner decision it answers:
--
--   S5-08  SETTLEMENT_CANCELLED in the audit vocabulary
--   S5-02  the amount a capped fixed agreement asked for is recorded
--   D-01   the engineer's own sale rows carry the product title as sold
--   D-05   a deactivated engineer keeps READ-ONLY access to their own money
--   S5-11  engineers and the public read only the columns they need
--   S5-03  historical financial rows cannot be deleted (D-06 for engineers)
--   S5-04  a closed commission agreement cannot be edited
--   S5-06  the shapes the application validates are also database rules
--   D-05   a deactivated engineer is not credited on a new sale
--
-- Nothing here rewrites a figure on an existing sale, statement or ledger
-- line. The columns added are NULL on existing rows, and every constraint was
-- checked against the existing data before being written (see §S5-06).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- S5-08 — a cancelled statement was audited as SETTLEMENT_GENERATED because
-- the vocabulary had no word for it. Appended, as every ADD VALUE is.
-- Historical rows keep the label they were written with: audit_logs is
-- append-only, and those rows carry `after.status = 'CANCELLED'`, which
-- already identifies them.
-- ---------------------------------------------------------------------------
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'SETTLEMENT_CANCELLED';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- S5-02 and D-01 — two columns on the per-engineer sale row, both written at
-- payment approval and frozen with the rest of the row by
-- order_item_contributors_guard. NULL on rows written before this migration.
-- ---------------------------------------------------------------------------
ALTER TABLE order_item_contributors
  ADD COLUMN IF NOT EXISTS commission_requested_minor bigint,
  ADD COLUMN IF NOT EXISTS product_title text;--> statement-breakpoint

ALTER TABLE order_item_contributors
  ADD CONSTRAINT order_item_contributors_requested_non_negative
  CHECK (commission_requested_minor IS NULL OR commission_requested_minor >= 0);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- D-05 — READ-ONLY FINANCIAL HISTORY FOR A DEACTIVATED ENGINEER.
--
-- `app.contributor_id` is empty for a deactivated engineer, which is what
-- takes away every working power (drafts, credited products, the console).
-- The owner's decision is that it must NOT take away their record of money
-- earned and owed. So a second, narrower identity is declared: the engineer's
-- contributor id whether active or not, used ONLY by the SELECT policies on
-- their own financial rows below. Every write policy on these tables remains
-- owner-only, so this grants reading and nothing else.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_financial_contributor_id() RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.financial_contributor_id', true), '')::uuid;
$$;--> statement-breakpoint

DROP POLICY IF EXISTS order_item_contributors_select ON order_item_contributors;--> statement-breakpoint
CREATE POLICY order_item_contributors_select ON order_item_contributors FOR SELECT
  USING (app_is_owner() OR contributor_id = app_financial_contributor_id());--> statement-breakpoint

DROP POLICY IF EXISTS settlements_select ON settlements;--> statement-breakpoint
CREATE POLICY settlements_select ON settlements FOR SELECT
  USING (app_is_owner() OR contributor_id = app_financial_contributor_id());--> statement-breakpoint

DROP POLICY IF EXISTS settlement_lines_select ON settlement_lines;--> statement-breakpoint
CREATE POLICY settlement_lines_select ON settlement_lines FOR SELECT
  USING (
    app_is_owner()
    OR EXISTS (
      SELECT 1 FROM settlements s
       WHERE s.id = settlement_lines.settlement_id
         AND s.contributor_id = app_financial_contributor_id()
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS commission_agreements_select ON commission_agreements;--> statement-breakpoint
CREATE POLICY commission_agreements_select ON commission_agreements FOR SELECT
  USING (app_is_owner() OR contributor_id = app_financial_contributor_id());--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- S5-11 — THE LEDGER, AS AN ENGINEER MAY SEE IT.
--
-- Row policies cannot hide columns. An engineer reading their own ledger
-- lines also read `seq` (a platform-wide sequence), `transaction_id`, and the
-- memo, which names the order number — together, the platform's total order
-- volume. Their own balance needs none of it.
--
-- So engineers lose direct access to the ledger tables, and read a view that
-- exposes the seven columns a balance and a monthly breakdown are made of,
-- for their own contributor id only (active or not — D-05). The view runs
-- with its owner's rights (the table owner, and the ledger is NO FORCE), and
-- its WHERE clause is the whole of its authorisation; security_barrier keeps
-- a caller's predicate from being evaluated before it.
--
-- The memo is kept on ADJUSTMENT lines only. There it is the explanation
-- written FOR the engineer — the adjustment's reference and its public
-- reason (OPEN-21) — and a balance that moves with no visible reason is what
-- adjustments exist to prevent. On a sale line it is an order number.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS ledger_lines_select ON ledger_lines;--> statement-breakpoint
CREATE POLICY ledger_lines_select ON ledger_lines FOR SELECT
  USING (app_is_owner());--> statement-breakpoint

DROP POLICY IF EXISTS ledger_transactions_select ON ledger_transactions;--> statement-breakpoint
CREATE POLICY ledger_transactions_select ON ledger_transactions FOR SELECT
  USING (app_is_owner());--> statement-breakpoint

CREATE OR REPLACE VIEW contributor_ledger_lines WITH (security_barrier = true) AS
  SELECT contributor_id, account_code, kind, amount_minor, currency, period_key, occurred_at,
         CASE WHEN kind = 'ADJUSTMENT' THEN memo END AS memo
    FROM ledger_lines
   WHERE contributor_id IS NOT NULL
     AND (app_is_owner() OR contributor_id = app_financial_contributor_id());--> statement-breakpoint

REVOKE ALL ON contributor_ledger_lines FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON contributor_ledger_lines TO app_user;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- S5-11 — THE PUBLIC PROFILE, AS ANYONE MAY SEE IT.
--
-- Every role — a guest included — could read every column of every active
-- engineer's row: `user_id` (their account), `settlement_code`, the approving
-- owner's id, draft rights. None of it is shown by the application, but row
-- policies cannot hide columns, so it was one query away.
--
-- The full row is now the owner's and the engineer's own. The public reads a
-- view of the public columns of ACTIVE profiles — exactly what the profile
-- page, the directory and the sitemap use.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS contributors_select ON contributors;--> statement-breakpoint
CREATE POLICY contributors_select ON contributors FOR SELECT
  USING (app_is_owner() OR user_id = app_actor_id());--> statement-breakpoint

CREATE OR REPLACE VIEW public_contributors WITH (security_barrier = true) AS
  SELECT id, public_slug, display_name, discipline_id, specialization, bio, updated_at
    FROM contributors
   WHERE is_active = true;--> statement-breakpoint

REVOKE ALL ON public_contributors FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON public_contributors TO app_user;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- S5-03 / D-06 — HISTORICAL FINANCIAL ROWS CANNOT BE DELETED.
--
-- The guards on these tables covered UPDATE only, and the foreign keys
-- cascade: deleting a COMPLETED order removed its lines and every engineer's
-- frozen split, and a PAID statement could be deleted outright. No
-- application path does either — but CLAUDE.md rule 1 says the database
-- protects the snapshot, not the absence of a code path.
--
-- A cascade fires the child's triggers, so a guard on each child also stops
-- a delete that starts at its parent. What stays deletable is what has no
-- financial meaning yet: a DRAFT order, an unsnapshotted line, an unapproved
-- payment, a PENDING statement, an engineer with no history at all.
--
-- THE ONE EXCEPTION is explicit and cannot be reached by the application: a
-- SUPERUSER session that sets `app.financial_purge = 'on'` in its own
-- transaction. The integration suite uses it to clean up the fixtures it
-- created. The application connects as app_user, which is not a superuser
-- and cannot become one; and a superuser can disable any trigger anyway —
-- the flag only makes that power explicit rather than silent.
-- ---------------------------------------------------------------------------
-- `session_user`, not `current_user`: a cascade runs its child deletes as the
-- table's OWNER, so current_user is the migrator there even when a superuser
-- started it. session_user is who logged in, and only a superuser can change
-- it (SET SESSION AUTHORIZATION).
CREATE OR REPLACE FUNCTION app_financial_purge_requested() RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT current_setting('app.financial_purge', true) = 'on'
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper);
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION financial_history_is_not_deleted() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
  DECLARE
    protected boolean := false;
    what text;
  BEGIN
    IF app_financial_purge_requested() THEN
      RETURN OLD;
    END IF;

    CASE TG_TABLE_NAME
      WHEN 'orders' THEN
        what := 'a paid or completed order';
        protected := OLD.status IN ('PAID', 'COMPLETED', 'REFUNDED')
          OR OLD.paid_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM order_items oi
                      WHERE oi.order_id = OLD.id AND oi.snapshot_taken_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM payments p
                      WHERE p.order_id = OLD.id AND p.status = 'APPROVED');
      WHEN 'order_items' THEN
        what := 'a sale line with a financial snapshot';
        protected := OLD.snapshot_taken_at IS NOT NULL;
      WHEN 'order_item_contributors' THEN
        what := 'an engineer''s frozen share of a sale';
        protected := true;
      WHEN 'payments' THEN
        what := 'an approved payment';
        protected := OLD.status = 'APPROVED';
      WHEN 'settlements' THEN
        what := 'an issued settlement statement';
        protected := OLD.status <> 'PENDING';
      WHEN 'settlement_lines' THEN
        what := 'a line of an issued settlement statement';
        -- Reached by a cascade from a PENDING statement, the parent is
        -- already gone; its own guard decided.
        protected := EXISTS (SELECT 1 FROM settlements s
                              WHERE s.id = OLD.settlement_id AND s.status <> 'PENDING');
      WHEN 'commission_agreements' THEN
        what := 'commission terms a sale was booked under';
        protected := EXISTS (SELECT 1 FROM order_items oi WHERE oi.agreement_id = OLD.id)
          OR EXISTS (SELECT 1 FROM order_item_contributors oic WHERE oic.agreement_id = OLD.id);
      WHEN 'contributors' THEN
        -- D-06: an engineer with financial history is deactivated, never
        -- deleted. The ledger and statements carry their id without a
        -- foreign key, so no constraint would have stopped this.
        what := 'an engineer with financial history';
        protected := EXISTS (SELECT 1 FROM commission_agreements a WHERE a.contributor_id = OLD.id)
          OR EXISTS (SELECT 1 FROM product_contributors pc WHERE pc.contributor_id = OLD.id)
          OR EXISTS (SELECT 1 FROM order_item_contributors oic WHERE oic.contributor_id = OLD.id)
          OR EXISTS (SELECT 1 FROM settlements s WHERE s.contributor_id = OLD.id)
          OR EXISTS (SELECT 1 FROM ledger_lines l WHERE l.contributor_id = OLD.id)
          OR EXISTS (SELECT 1 FROM financial_adjustments f WHERE f.contributor_id = OLD.id);
      ELSE
        RAISE EXCEPTION 'financial_history_is_not_deleted() is not defined for %', TG_TABLE_NAME;
    END CASE;

    IF protected THEN
      RAISE EXCEPTION 'Deleting % is not allowed: financial history is permanent (Stage 5, S5-03)', what
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END;
$$;--> statement-breakpoint

CREATE TRIGGER orders_no_financial_delete BEFORE DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION financial_history_is_not_deleted();--> statement-breakpoint
CREATE TRIGGER order_items_no_financial_delete BEFORE DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION financial_history_is_not_deleted();--> statement-breakpoint
CREATE TRIGGER order_item_contributors_no_delete BEFORE DELETE ON order_item_contributors
  FOR EACH ROW EXECUTE FUNCTION financial_history_is_not_deleted();--> statement-breakpoint
CREATE TRIGGER payments_no_financial_delete BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION financial_history_is_not_deleted();--> statement-breakpoint
CREATE TRIGGER settlements_no_financial_delete BEFORE DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION financial_history_is_not_deleted();--> statement-breakpoint
CREATE TRIGGER settlement_lines_no_financial_delete BEFORE DELETE ON settlement_lines
  FOR EACH ROW EXECUTE FUNCTION financial_history_is_not_deleted();--> statement-breakpoint
CREATE TRIGGER commission_agreements_no_financial_delete BEFORE DELETE ON commission_agreements
  FOR EACH ROW EXECUTE FUNCTION financial_history_is_not_deleted();--> statement-breakpoint
CREATE TRIGGER contributors_no_financial_delete BEFORE DELETE ON contributors
  FOR EACH ROW EXECUTE FUNCTION financial_history_is_not_deleted();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- S5-04 — A CLOSED AGREEMENT IS HISTORY.
--
-- Agreements are temporal: a change closes the open row and opens a new one
-- (`setCommissionAgreement`). Nothing stopped an UPDATE of a closed row's
-- rate, which rewrote what the terms "were" on every past date — the audit
-- changed one and the row moved. Sales already carry their own frozen copy;
-- this protects the record of terms itself, which the owner's commission
-- history reads.
--
-- The only UPDATE allowed is the one the temporal model needs: closing the
-- open row, and nothing else on it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION commission_agreements_close_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
  BEGIN
    IF app_financial_purge_requested() THEN
      RETURN NEW;
    END IF;
    IF OLD.effective_to IS NOT NULL THEN
      RAISE EXCEPTION 'A closed commission agreement cannot be changed (S5-04)'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.contributor_id IS DISTINCT FROM OLD.contributor_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.model IS DISTINCT FROM OLD.model
       OR NEW.engineer_bp IS DISTINCT FROM OLD.engineer_bp
       OR NEW.engineer_fixed_minor IS DISTINCT FROM OLD.engineer_fixed_minor
       OR NEW.platform_fixed_minor IS DISTINCT FROM OLD.platform_fixed_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Commission terms are never edited in place: close the agreement and open a new one (S5-04)'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END;
$$;--> statement-breakpoint

CREATE TRIGGER commission_agreements_close_only BEFORE UPDATE ON commission_agreements
  FOR EACH ROW EXECUTE FUNCTION commission_agreements_close_only();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- S5-06 — VALIDATION THE DATABASE NOW ENFORCES ITSELF.
--
-- Checked against the existing data first: every agreement row matches its
-- model's shape with non-negative amounts, every credited product's shares
-- total 100%, and every per-engineer split re-adds to its line. A database
-- where that is not true fails this migration by name instead of carrying
-- the inconsistency forward.
-- ---------------------------------------------------------------------------
ALTER TABLE commission_agreements
  ADD CONSTRAINT commission_agreements_model_shape CHECK (
       (model = 'PERCENTAGE' AND engineer_bp IS NOT NULL
          AND engineer_fixed_minor IS NULL AND platform_fixed_minor IS NULL)
    OR (model = 'FIXED_ENGINEER' AND engineer_fixed_minor IS NOT NULL AND engineer_fixed_minor >= 0
          AND engineer_bp IS NULL AND platform_fixed_minor IS NULL)
    OR (model = 'FIXED_PLATFORM' AND platform_fixed_minor IS NOT NULL AND platform_fixed_minor >= 0
          AND engineer_bp IS NULL AND engineer_fixed_minor IS NULL)
  );--> statement-breakpoint

ALTER TABLE commission_agreements
  ADD CONSTRAINT commission_agreements_currency_format CHECK (currency ~ '^[A-Z]{3}$');--> statement-breakpoint

ALTER TABLE order_items
  ADD CONSTRAINT order_items_engineer_bp_range
  CHECK (engineer_bp IS NULL OR (engineer_bp >= 0 AND engineer_bp <= 10000));--> statement-breakpoint

-- A product's credits total exactly 100% whenever it has any. Checked at
-- COMMIT, because `setProductContributors` replaces the set in two statements
-- and the total is only whole again after the second.
CREATE OR REPLACE FUNCTION product_contributors_total_is_whole() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
  DECLARE
    target uuid := COALESCE(NEW.product_id, OLD.product_id);
    total bigint;
  BEGIN
    SELECT SUM(share_bp) INTO total FROM product_contributors WHERE product_id = target;
    IF total IS NOT NULL AND total <> 10000 THEN
      RAISE EXCEPTION 'The engineers credited on a product must share exactly 100%% (product %, total % bp)',
        target, total
        USING ERRCODE = 'check_violation', CONSTRAINT = 'product_contributors_total_whole';
    END IF;
    RETURN NULL;
  END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER product_contributors_total_whole
  AFTER INSERT OR UPDATE OR DELETE ON product_contributors
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION product_contributors_total_is_whole();--> statement-breakpoint

-- Every engineer's split of a sale re-adds to the line it belongs to: slices
-- to the line's net, their pay to its engineer total, the platform's cuts to
-- its platform total, and their credits to 100%. Rows from before migration
-- 0050 carry no slice and are left as they are.
CREATE OR REPLACE FUNCTION order_item_contributors_add_up() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
  DECLARE
    line record;
    sums record;
  BEGIN
    SELECT oi.id, COALESCE(oi.net_minor, oi.unit_price_minor - oi.discount_minor) AS net,
           oi.engineer_amount_minor, oi.platform_amount_minor
      INTO line
      FROM order_items oi WHERE oi.id = NEW.order_item_id;
    SELECT COUNT(*) AS n, COUNT(slice_minor) AS sliced,
           SUM(slice_minor) AS slices, SUM(amount_minor) AS engineers,
           SUM(platform_amount_minor) AS platform, SUM(share_bp) AS shares
      INTO sums
      FROM order_item_contributors WHERE order_item_id = NEW.order_item_id;
    IF sums.sliced < sums.n THEN
      RETURN NULL;
    END IF;
    IF sums.shares <> 10000
       OR sums.slices <> line.net
       OR sums.engineers <> line.engineer_amount_minor
       OR sums.platform <> line.platform_amount_minor THEN
      RAISE EXCEPTION 'The engineers'' splits do not add up to their sale line (order item %)', NEW.order_item_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'order_item_contributors_add_up';
    END IF;
    RETURN NULL;
  END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER order_item_contributors_add_up
  AFTER INSERT ON order_item_contributors
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION order_item_contributors_add_up();--> statement-breakpoint

-- The existing data, checked by the same rules the triggers apply from now on.
DO $$
  DECLARE
    bad bigint;
  BEGIN
    SELECT COUNT(*) INTO bad FROM (
      SELECT product_id FROM product_contributors GROUP BY product_id HAVING SUM(share_bp) <> 10000
    ) x;
    IF bad > 0 THEN
      RAISE EXCEPTION 'S5-06: % product(s) have credits that do not total 100%%', bad;
    END IF;

    SELECT COUNT(*) INTO bad FROM (
      SELECT oic.order_item_id
        FROM order_item_contributors oic
        JOIN order_items oi ON oi.id = oic.order_item_id
       GROUP BY oic.order_item_id, oi.net_minor, oi.unit_price_minor, oi.discount_minor,
                oi.engineer_amount_minor, oi.platform_amount_minor
      HAVING COUNT(oic.slice_minor) = COUNT(*)
         AND (SUM(oic.share_bp) <> 10000
              OR SUM(oic.slice_minor) <> COALESCE(oi.net_minor, oi.unit_price_minor - oi.discount_minor)
              OR SUM(oic.amount_minor) <> oi.engineer_amount_minor
              OR SUM(oic.platform_amount_minor) <> oi.platform_amount_minor)
    ) x;
    IF bad > 0 THEN
      RAISE EXCEPTION 'S5-06: % sale line(s) whose engineer splits do not add up', bad;
    END IF;
  END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- D-05 — A DEACTIVATED ENGINEER IS NOT CREDITED ON A NEW SALE.
--
-- Their credit stays on the product (the owner's decision: deactivation does
-- not strip attribution), so the product cannot be bought until the owner
-- reactivates them or changes the credits. Refused when the order line is
-- written, so no order path can forget it.
--
-- SECURITY DEFINER BY NECESSITY: the row being inserted is the BUYER's, and
-- a buyer can read neither the credits (owner-only since 0049) nor a
-- deactivated engineer's profile (S5-11 above). The function answers one
-- yes/no question about the product being ordered and returns nothing else.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION order_items_credits_active() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM product_contributors pc
        JOIN contributors c ON c.id = pc.contributor_id
       WHERE pc.product_id = NEW.product_id
         AND NOT c.is_active
    ) THEN
      RAISE EXCEPTION 'This product is credited to a deactivated engineer and cannot be sold (D-05)'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'order_items_credits_active';
    END IF;
    RETURN NEW;
  END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION order_items_credits_active() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER order_items_credits_active BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_credits_active();
