-- ===========================================================================
-- FINANCIAL ADJUSTMENTS (owner decision on OPEN-21)
--
-- "الغرض من ADJUSTMENT هو تسجيل التصحيحات المالية الاستثنائية بطريقة رسمية
--  وقابلة للتدقيق. لا تستخدمها لتعديل أو حذف عمليات البيع الأصلية."
--
-- Hand-written: drizzle-kit wanted an interactive answer about whether the new
-- adjustment_reason enum is a rename of the refund_reason enum dropped in
-- 0035. It is not, and a migration that changes the books is not something to
-- settle by guessing at a prompt.
--
-- THE SHAPE OF THE GUARANTEE
--   The ledger holds the money. This table holds the reason.
--   Neither can exist without the other: financial_adjustments.ledger_transaction_id
--   is NOT NULL and unique, and a CHECK ties the target to the contributor
--   column so an engineer adjustment cannot be saved without naming one.
--   The original sale is untouched — nothing here writes to order_items, and
--   the immutability trigger there would refuse it anyway.
-- ===========================================================================

CREATE TYPE "adjustment_target" AS ENUM ('ENGINEER', 'PLATFORM');--> statement-breakpoint
CREATE TYPE "adjustment_direction" AS ENUM ('INCREASE', 'DECREASE');--> statement-breakpoint
CREATE TYPE "adjustment_reason" AS ENUM (
  'DATA_ENTRY_ERROR',
  'DUPLICATE_PAYMENT_RECEIVED',
  'BANK_FEE_OR_SHORTFALL',
  'AGREED_COMPENSATION',
  'SETTLEMENT_CORRECTION',
  'OTHER'
);--> statement-breakpoint

CREATE TABLE "financial_adjustments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reference" text NOT NULL,
  "target" "adjustment_target" NOT NULL,
  "direction" "adjustment_direction" NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "contributor_id" uuid,
  "contributor_name" text,
  "reason" "adjustment_reason" NOT NULL,
  "note" text NOT NULL,
  "related_type" text,
  "related_id" uuid,
  "ledger_transaction_id" uuid NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_by" uuid,
  "created_by_name" text,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "financial_adjustments_reference_unique"
  ON "financial_adjustments" ("reference");--> statement-breakpoint
-- A double-click, a retried request or a refreshed confirmation page cannot
-- post the same correction twice.
CREATE UNIQUE INDEX "financial_adjustments_idempotency_unique"
  ON "financial_adjustments" ("idempotency_key");--> statement-breakpoint
-- One record per ledger entry, and vice versa.
CREATE UNIQUE INDEX "financial_adjustments_ledger_unique"
  ON "financial_adjustments" ("ledger_transaction_id");--> statement-breakpoint
CREATE INDEX "financial_adjustments_contributor_idx"
  ON "financial_adjustments" ("contributor_id", "occurred_at");--> statement-breakpoint
CREATE INDEX "financial_adjustments_created_idx"
  ON "financial_adjustments" ("occurred_at");--> statement-breakpoint

-- --- validation the owner asked for, as constraints -------------------------
-- "يجب التحقق من صحة المبلغ والعملة والحساب"
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "adjustments_amount_positive"
  CHECK (amount_minor > 0);--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "adjustments_currency_format"
  CHECK (currency ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "adjustments_note_present"
  CHECK (length(trim(note)) >= 10);--> statement-breakpoint
-- An engineer adjustment names an engineer; a platform one must not.
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "adjustments_target_matches_contributor"
  CHECK (
    (target = 'ENGINEER' AND contributor_id IS NOT NULL)
    OR (target = 'PLATFORM' AND contributor_id IS NULL)
  );--> statement-breakpoint
-- A related reference is either complete or absent, never half-written.
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "adjustments_related_complete"
  CHECK ((related_type IS NULL) = (related_id IS NULL));--> statement-breakpoint

-- --- the record is history --------------------------------------------------
-- A correction that can itself be corrected in place is not an audit trail.
-- Getting an adjustment wrong is fixed by posting another one.
CREATE OR REPLACE FUNCTION financial_adjustments_are_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION
      'A financial adjustment is a record of what was done: correct a mistaken one by posting another, never by editing it'
      USING ERRCODE = 'integrity_constraint_violation';
  END;
  $$;--> statement-breakpoint

CREATE TRIGGER financial_adjustments_no_update
  BEFORE UPDATE ON "financial_adjustments"
  FOR EACH ROW EXECUTE FUNCTION financial_adjustments_are_append_only();--> statement-breakpoint
CREATE TRIGGER financial_adjustments_no_delete
  BEFORE DELETE ON "financial_adjustments"
  FOR EACH ROW EXECUTE FUNCTION financial_adjustments_are_append_only();--> statement-breakpoint

-- --- OWNER ONLY -------------------------------------------------------------
-- "ولا يستطيع أي مستخدم غير Owner/Admin رؤية أو إنشاء Adjustment."
--
-- Note what an engineer DOES still see: the ledger line itself, because it
-- carries their contributor id and the ledger's own policy grants it. That is
-- deliberate — a balance that drops with no visible entry is worse than one
-- that drops with a short public reason on it. The internal note, the author
-- and the reference stay here, and here is owner-only.
ALTER TABLE "financial_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "financial_adjustments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "financial_adjustments_owner" ON "financial_adjustments" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE ON "financial_adjustments" FROM app_user;--> statement-breakpoint

-- Human reference: ADJ-000001.
CREATE SEQUENCE IF NOT EXISTS adjustment_reference_seq START WITH 1;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_next_adjustment_reference() RETURNS text
  LANGUAGE sql VOLATILE AS $$
    SELECT 'ADJ-' || lpad(nextval('adjustment_reference_seq')::text, 6, '0');
  $$;--> statement-breakpoint

GRANT USAGE ON SEQUENCE adjustment_reference_seq TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_next_adjustment_reference() TO app_user;
