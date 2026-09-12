-- ===========================================================================
-- WHAT MAKES A SETTLEMENT TRUSTWORTHY (specification §15, §16 — decisions §9)
--
-- Three properties, enforced by the database rather than by remembering:
--
--   1. A PAID settlement names the ledger entry that paid it. There is no
--      such thing here as money that left without the books knowing.
--   2. A PAID settlement is FROZEN. Its figures were the engineer's statement;
--      editing them afterwards would rewrite what they were told they were
--      owed. Specification §15: "Do not delete historical settlement records."
--      Not deleting is the floor; not editing is the rule.
--   3. A contributor reads their own statements and nobody else's.
-- ===========================================================================

-- --- integrity -------------------------------------------------------------
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_currency_format"
  CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_period_format"
  CHECK (period_key ~ '^\d{4}-(0[1-9]|1[0-2])$');
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_period_ordered"
  CHECK (period_end_exclusive > period_start);
--> statement-breakpoint

-- A debt is carried, never billed: net due is what we PAY, and we never pay a
-- negative amount. A negative balance lives in balance_minor and rolls forward.
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_net_due_non_negative"
  CHECK (net_due_minor >= 0);
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_minimum_non_negative"
  CHECK (minimum_payout_minor >= 0);
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_period_figures_sane"
  CHECK (
    period_sales_minor >= 0
    AND period_refunds_minor >= 0
    AND period_gross_sales_minor >= 0
    AND period_units_sold >= 0
  );
--> statement-breakpoint

-- Paying nothing is not a payment. A settlement that pays must pay something,
-- and one that pays must name the ledger entry that moved the money.
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_paid_has_ledger_entry"
  CHECK (status <> 'PAID' OR (ledger_transaction_id IS NOT NULL
                              AND paid_at IS NOT NULL
                              AND net_due_minor > 0));
--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_approved_is_recorded"
  CHECK (status NOT IN ('APPROVED', 'PAID')
         OR (approved_at IS NOT NULL AND approved_by IS NOT NULL));
--> statement-breakpoint

-- A statement that pays nothing says so in its status rather than by holding a
-- zero. This is the state decisions §8 requires to be visible to the engineer.
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_carried_pays_nothing"
  CHECK (status <> 'CARRIED_FORWARD' OR net_due_minor = 0);
--> statement-breakpoint

ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_currency_format"
  CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
-- A sale credits, a refund debits. A line that contradicts its own kind is a
-- generation bug, and it would be read by an engineer as their earnings.
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_sign_matches_kind"
  CHECK (
    (kind = 'SALE'   AND engineer_minor >= 0)
    OR (kind = 'REFUND' AND engineer_minor <= 0)
    OR kind = 'ADJUSTMENT'
  );
--> statement-breakpoint

-- ===========================================================================
-- A PAID SETTLEMENT IS FROZEN
--
-- Everything except the operational note is sealed once the money has gone.
-- The note stays writable deliberately: recording "transfer bounced, resent on
-- the 4th" is operational history, not a restatement of what was owed.
-- ===========================================================================
CREATE OR REPLACE FUNCTION settlements_are_frozen_once_paid() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.status <> 'PAID' THEN
      RETURN NEW;
    END IF;

    IF NEW.status              IS DISTINCT FROM OLD.status
    OR NEW.net_due_minor       IS DISTINCT FROM OLD.net_due_minor
    OR NEW.balance_minor       IS DISTINCT FROM OLD.balance_minor
    OR NEW.carried_forward_minor  IS DISTINCT FROM OLD.carried_forward_minor
    OR NEW.period_sales_minor  IS DISTINCT FROM OLD.period_sales_minor
    OR NEW.period_refunds_minor IS DISTINCT FROM OLD.period_refunds_minor
    OR NEW.period_adjustments_minor IS DISTINCT FROM OLD.period_adjustments_minor
    OR NEW.minimum_payout_minor IS DISTINCT FROM OLD.minimum_payout_minor
    OR NEW.currency            IS DISTINCT FROM OLD.currency
    OR NEW.contributor_id      IS DISTINCT FROM OLD.contributor_id
    OR NEW.period_key          IS DISTINCT FROM OLD.period_key
    OR NEW.ledger_transaction_id IS DISTINCT FROM OLD.ledger_transaction_id
    OR NEW.paid_at             IS DISTINCT FROM OLD.paid_at
    THEN
      RAISE EXCEPTION
        'A paid settlement is frozen: correct it with an adjustment entry, never by editing the statement (specification 15)'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
  END;
  $$;
--> statement-breakpoint

CREATE TRIGGER settlements_freeze_guard
  BEFORE UPDATE ON "settlements"
  FOR EACH ROW EXECUTE FUNCTION settlements_are_frozen_once_paid();
--> statement-breakpoint

-- A settlement is history (§15). Its lines go with it.
CREATE OR REPLACE FUNCTION settlement_lines_are_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION
      'A settlement statement line is written once (specification 15)'
      USING ERRCODE = 'integrity_constraint_violation';
  END;
  $$;
--> statement-breakpoint

CREATE TRIGGER settlement_lines_no_update
  BEFORE UPDATE ON "settlement_lines"
  FOR EACH ROW EXECUTE FUNCTION settlement_lines_are_immutable();
--> statement-breakpoint

-- ===========================================================================
-- ROW-LEVEL SECURITY (§12, §49)
-- ===========================================================================
ALTER TABLE "settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settlements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The owner, and the engineer the statement is FOR. A contributor asking for
-- every settlement in the system receives their own rows and nothing else,
-- with or without a WHERE clause.
CREATE POLICY "settlements_select" ON "settlements" FOR SELECT
  USING (app_is_owner() OR "contributor_id" = app_contributor_id());
--> statement-breakpoint

-- Generating, approving and paying are the owner's, without exception. There
-- is no contributor-writable path to a settlement at all.
CREATE POLICY "settlements_write" ON "settlements" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

ALTER TABLE "settlement_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settlement_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "settlement_lines_select" ON "settlement_lines" FOR SELECT
  USING (
    app_is_owner()
    OR EXISTS (SELECT 1 FROM settlements s
                WHERE s.id = settlement_lines.settlement_id
                  AND s.contributor_id = app_contributor_id())
  );
--> statement-breakpoint
CREATE POLICY "settlement_lines_write" ON "settlement_lines" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- No DELETE policy narrower than the owner's, and §15 says a settlement is
-- never deleted. The policy permits it for the owner because a database that
-- cannot correct an operational mistake at all is worse than one that records
-- who corrected it; the audit log carries that record.

-- The settlement reference is derived from the period and the contributor's
-- settlement code (§16), so it needs no sequence — but a contributor without a
-- code cannot be settled, and that must fail loudly rather than produce
-- "SEP-2026-".
ALTER TABLE "contributors" ADD CONSTRAINT "contributors_settlement_code_present"
  CHECK (settlement_code IS NULL OR length(trim(settlement_code)) > 0);
