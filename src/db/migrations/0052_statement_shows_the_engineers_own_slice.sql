-- ===========================================================================
-- 0052 — THE STATEMENT SHOWS THE ENGINEER'S OWN SLICE, NOT THE WHOLE PRICE
-- ===========================================================================
--
-- What was wrong, and it was wrong only on SHARED products:
--
--   `settlement_lines.gross_minor` was written from `order_items.unit_price_minor`
--   — the product's full list price — and the statement printed the sum of it
--   as «إجمالي قيمتها» beside the engineer's own earnings. On a product with
--   one author that reads correctly. On a product with two, the engineer was
--   shown a number that was never theirs: half of it belongs to a colleague.
--
--   The statement therefore invited exactly the subtraction OPEN-4 forbids —
--   "the price was 100, I earned 30, so the rest went somewhere" — and, worse
--   for the engineer reading it honestly, made their own commission rate look
--   half what it is.
--
-- What this migration does, and just as importantly what it does NOT do:
--
--   It adds ONE descriptive column to each of the two tables and nothing else.
--   No amount that decides a payment changes: `engineer_minor`,
--   `period_sales_minor`, `net_due_minor`, `balance_minor` and every ledger
--   line are untouched, and the settlement arithmetic is not read or rewritten
--   by this file. The slice is what the engineer's agreed rate was applied to
--   — it is already frozen on `order_item_contributors.slice_minor` since
--   migration 0050 — copied onto the statement so the document can say
--   «قيمة حصتي من المبيعات» instead of a price that is not the engineer's.
--
-- BOTH COLUMNS ARE NULLABLE, AND STAY NULL ON EVERY EXISTING ROW.
--
--   `settlement_lines` carries no `product_id` — only `product_title` — so a
--   backfill would have to match statements to sales by TITLE, and a title is
--   neither unique nor stable. Guessing a financial figure onto an issued
--   document is worse than leaving it absent: an issued statement is a frozen
--   document (0032), and rewriting one silently is the thing that rule exists
--   to prevent. Absent means the reader falls back to the old wording, which
--   is what those documents actually said.
-- ===========================================================================

ALTER TABLE "settlement_lines"
  ADD COLUMN IF NOT EXISTS "slice_minor" bigint;
--> statement-breakpoint

COMMENT ON COLUMN "settlement_lines"."slice_minor" IS
  'The engineer''s own slice of the sale''s net — what their agreed rate was applied to. NULL on adjustment lines and on every line written before migration 0052.';
--> statement-breakpoint

-- A slice belongs to a SALE and to nothing else, it is never negative, and it
-- can never exceed what the customer paid for the product. The bound is what
-- makes a swapped-argument bug at the write site fail here instead of printing.
ALTER TABLE "settlement_lines"
  ADD CONSTRAINT "settlement_lines_slice_shape" CHECK (
    "slice_minor" IS NULL
    OR ("kind" = 'SALE' AND "slice_minor" >= 0 AND "slice_minor" <= "gross_minor")
  );
--> statement-breakpoint

ALTER TABLE "settlements"
  ADD COLUMN IF NOT EXISTS "period_slice_sales_minor" bigint;
--> statement-breakpoint

COMMENT ON COLUMN "settlements"."period_slice_sales_minor" IS
  'Sum of the period''s slice_minor — the engineer''s own share of the sales value. NULL when any sale in the period predates migration 0052.';
--> statement-breakpoint

ALTER TABLE "settlements"
  ADD CONSTRAINT "settlements_period_slice_shape" CHECK (
    "period_slice_sales_minor" IS NULL
    OR ("period_slice_sales_minor" >= 0
        AND "period_slice_sales_minor" <= "period_gross_sales_minor")
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The freeze guard enumerates the columns a paid settlement may not change.
-- A column added without being named there is a column a paid statement CAN
-- be rewritten in — the guard does not fail open loudly, it just stops
-- covering the new field. So it is replaced here with the new column named,
-- and nothing else about it altered.
-- ---------------------------------------------------------------------------
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
    OR NEW.period_gross_sales_minor IS DISTINCT FROM OLD.period_gross_sales_minor
    OR NEW.period_slice_sales_minor IS DISTINCT FROM OLD.period_slice_sales_minor
    OR NEW.period_units_sold   IS DISTINCT FROM OLD.period_units_sold
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
