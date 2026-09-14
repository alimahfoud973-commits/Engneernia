-- ===========================================================================
-- TAX AND LEGAL INVOICING (owner decision on OPEN-9)
--
-- Three decisions, and every line below follows from them:
--
--   1. THE DISPLAYED PRICE INCLUDES THE TAX. What the customer sees is what
--      they pay. Nothing in the catalogue changes value, and the number on a
--      bank transfer still matches the number on the page — which matters
--      because most payment here is manual.
--   2. THE ENGINEER'S SHARE IS COMPUTED ON THE NET. Tax comes out first; the
--      remainder is split. Tax is not income to anybody — it is money held
--      for the state — so it is not in the pot that gets divided.
--   3. IT SHIPS DISABLED, AT RATE ZERO. Invoices are issued from day one so
--      every sale is documented; the tax line on them is zero until the owner
--      sets a rate. No tax is charged before the platform is liable for it.
--
-- AT RATE ZERO THIS MIGRATION CHANGES NO NUMBER ANYWHERE. tax = 0 and
-- net = gross, so the split, the ledger and every existing test see exactly
-- what they saw before. That is the property the tests assert, not a hope.
-- ===========================================================================

-- --- 1. the account tax is held in -----------------------------------------
-- A LIABILITY, deliberately, not income: this money is collected on behalf of
-- the state and owed onward. Putting it in PLATFORM_REVENUE would overstate
-- earnings and inflate every report the owner reads.
INSERT INTO ledger_accounts (code, type, normal_balance, name_ar, description_ar, requires_contributor, sort_order)
VALUES ('TAX_PAYABLE', 'LIABILITY', 'CREDIT', 'ضريبة مستحقة',
        'ضريبة محصَّلة من العملاء ومستحقة للجهة الضريبية. ليست إيراداً للمنصة.',
        false, 25)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- --- 2. the tax figures, frozen onto the sale ------------------------------
-- Part of the financial snapshot, so a rate changed next year cannot rewrite
-- what was charged last year.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "tax_bp" integer;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "tax_minor" bigint;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "net_minor" bigint;--> statement-breakpoint

-- The immutability trigger must learn about them IN THE SAME MIGRATION that
-- adds them. A snapshot column the trigger does not name is a snapshot column
-- anybody can rewrite — which is exactly the guarantee §13 calls mandatory.
CREATE OR REPLACE FUNCTION order_items_snapshot_is_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.snapshot_taken_at IS NULL THEN
      RETURN NEW;  -- the sale is being recorded for the first time
    END IF;

    IF NEW.unit_price_minor   IS DISTINCT FROM OLD.unit_price_minor
    OR NEW.currency           IS DISTINCT FROM OLD.currency
    OR NEW.commission_model   IS DISTINCT FROM OLD.commission_model
    OR NEW.engineer_bp        IS DISTINCT FROM OLD.engineer_bp
    OR NEW.engineer_amount_minor  IS DISTINCT FROM OLD.engineer_amount_minor
    OR NEW.platform_amount_minor  IS DISTINCT FROM OLD.platform_amount_minor
    OR NEW.tax_bp             IS DISTINCT FROM OLD.tax_bp
    OR NEW.tax_minor          IS DISTINCT FROM OLD.tax_minor
    OR NEW.net_minor          IS DISTINCT FROM OLD.net_minor
    OR NEW.agreement_id       IS DISTINCT FROM OLD.agreement_id
    OR NEW.price_row_id       IS DISTINCT FROM OLD.price_row_id
    OR NEW.snapshot_taken_at  IS DISTINCT FROM OLD.snapshot_taken_at
    THEN
      RAISE EXCEPTION
        'The financial snapshot on an order item is immutable once taken (specification 13)'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
  END;
  $$;--> statement-breakpoint

-- The tax and the net must re-add to what the customer paid. Checked by the
-- database so an arithmetic slip cannot be committed, on any code path.
--
-- `tax_minor IS NULL` is permitted for rows sold BEFORE this migration: their
-- price was never divided this way, and a constraint that refused them would
-- make this migration fail on any database that has taken a single sale.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tax_split_adds_up"
  CHECK (
    snapshot_taken_at IS NULL
    OR tax_minor IS NULL
    OR (net_minor IS NOT NULL
        AND tax_minor >= 0 AND net_minor >= 0
        AND tax_minor + net_minor = unit_price_minor)
  );--> statement-breakpoint

-- ===========================================================================
-- AND THE SPLIT NOW BALANCES AGAINST THE NET, NOT THE PRICE
--
-- 0020 checks `engineer + platform = unit_price_minor`. That was the whole
-- truth until tax existed; it is now false by exactly the tax, and a sale at
-- any non-zero rate is refused by it.
--
-- Replaced rather than dropped: this is, in 0020's own words, "the one
-- invariant the whole settlement system rests on". With both constraints in
-- force the database still proves the complete equation —
--     engineer + platform + tax = unit_price_minor
-- — as two halves that cannot be satisfied separately.
--
-- COALESCE keeps every sale made before today valid: their `net_minor` is
-- NULL and their split balanced against the price, which it still does.
-- ===========================================================================
ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_split_balances";--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_split_balances"
  CHECK (
    snapshot_taken_at IS NULL
    OR (engineer_amount_minor >= 0
        AND platform_amount_minor >= 0
        AND engineer_amount_minor + platform_amount_minor
            = COALESCE(net_minor, unit_price_minor))
  );--> statement-breakpoint

-- --- 3. invoice numbering — GAPLESS, unlike order numbers ------------------
-- `order_number_seq` is a PostgreSQL sequence, and a sequence leaves gaps when
-- a transaction rolls back. For an order reference that is harmless.
--
-- A TAX INVOICE IS DIFFERENT: a missing number in a numbered series is the
-- first thing an auditor asks about, and "the transaction rolled back" is not
-- an answer anyone has to accept. So the counter is a row, taken with
-- FOR UPDATE inside the same transaction as the sale: if the sale rolls back
-- the number is returned with it, and the series has no holes.
--
-- The cost is that concurrent invoice issuance serialises. At this volume that
-- is nothing, and it is bought with the one property that matters here.
CREATE TABLE IF NOT EXISTS "invoice_counters" (
  "year" integer PRIMARY KEY,
  "next_number" integer NOT NULL DEFAULT 1
);--> statement-breakpoint

ALTER TABLE "invoice_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "invoice_counters" FROM app_user;--> statement-breakpoint
CREATE POLICY "invoice_counters_deny_all" ON "invoice_counters"
  FOR ALL USING (false) WITH CHECK (false);--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_next_invoice_number(p_prefix text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE
    v_year integer;
    v_number integer;
  BEGIN
    -- The platform's own year, not the server's: an invoice issued at 01:30
    -- Damascus time on the first of January belongs to the new year, and UTC
    -- would still say December.
    v_year := EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Damascus'))::integer;

    INSERT INTO invoice_counters (year, next_number) VALUES (v_year, 1)
    ON CONFLICT (year) DO NOTHING;

    -- FOR UPDATE: the second caller waits here rather than reading the same
    -- number. This is the whole mechanism.
    SELECT next_number INTO v_number
      FROM invoice_counters WHERE year = v_year FOR UPDATE;

    UPDATE invoice_counters SET next_number = next_number + 1 WHERE year = v_year;

    RETURN p_prefix || '-' || v_year::text || '-' || lpad(v_number::text, 5, '0');
  END;
  $$;--> statement-breakpoint

-- --- 4. the invoices themselves --------------------------------------------
-- Everything on an invoice is FROZEN AT ISSUE: the rate, the tax's legal name,
-- the seller's details, the buyer's, and the lines. A settings row edited next
-- month must not silently rewrite a document already given to a customer and
-- possibly filed with an authority.
CREATE TABLE IF NOT EXISTS "invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "invoice_number" text NOT NULL,
  -- NO FOREIGN KEYS, deliberately — the rule for append-only records in this
  -- project (CLAUDE.md, database rules). An invoice is a permanent document,
  -- so a foreign key from it would make deleting the order, and therefore the
  -- customer's account, impossible forever. Referential correctness is checked
  -- WHEN THE ROW IS WRITTEN, inside the same transaction as the sale, and the
  -- document then stands alone: the buyer's name, their address, the seller's
  -- details and the lines are all copied onto it, so it renders years later
  -- without joining anything.
  --
  -- Found the honest way: the integration suite could no longer delete a test
  -- order, which is what a foreign key from an undeletable row does.
  "order_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,

  "issued_at" timestamp with time zone NOT NULL DEFAULT now(),
  "currency" text NOT NULL,

  "gross_minor" bigint NOT NULL,
  "tax_minor" bigint NOT NULL,
  "net_minor" bigint NOT NULL,
  "tax_bp" integer NOT NULL,

  -- Frozen copies of what were settings at the moment of issue.
  "tax_name_ar" text NOT NULL,
  "tax_registration" text,
  "seller_name_ar" text NOT NULL,
  "seller_address_ar" text,
  "buyer_name" text NOT NULL,
  "buyer_email" text NOT NULL,

  -- The line items as they read on the document, so rendering it again years
  -- later cannot depend on a product that has since been renamed or deleted.
  "lines" jsonb NOT NULL,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "invoices_number_unique" ON "invoices" ("invoice_number");--> statement-breakpoint
-- One invoice per order. A second approval attempt must not mint a second
-- document for the same sale.
CREATE UNIQUE INDEX "invoices_order_unique" ON "invoices" ("order_id");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" ("customer_id", "issued_at");--> statement-breakpoint
CREATE INDEX "invoices_issued_idx" ON "invoices" ("issued_at");--> statement-breakpoint

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts_add_up"
  CHECK (tax_minor >= 0 AND net_minor >= 0 AND tax_minor + net_minor = gross_minor);--> statement-breakpoint

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- The buyer and the owner. NOT the contributor: an invoice carries the buyer's
-- name and address, and who bought a product is the customer's business, not
-- the seller's (the same rule as `orders`, OPEN-4).
CREATE POLICY "invoices_select" ON "invoices" FOR SELECT
  USING (app_is_owner() OR "customer_id" = app_actor_id());--> statement-breakpoint
CREATE POLICY "invoices_insert" ON "invoices" FOR INSERT
  WITH CHECK (app_is_owner());--> statement-breakpoint

-- APPEND-ONLY, like the ledger and for the same reason: an invoice that can be
-- edited after it was handed to a customer is not a record of anything. A
-- correction is a new document, never a rewrite.
CREATE OR REPLACE FUNCTION invoices_are_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION
      'An invoice is append-only: issue a correcting document, never edit one (OPEN-9)'
      USING ERRCODE = 'integrity_constraint_violation';
  END;
  $$;--> statement-breakpoint

CREATE TRIGGER invoices_no_update BEFORE UPDATE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION invoices_are_append_only();--> statement-breakpoint
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION invoices_are_append_only();--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_next_invoice_number(text) TO app_user;--> statement-breakpoint

-- --- 5. the policy numbers, as settings ------------------------------------
-- Not constants in code. The rate especially: it is a legal figure that will
-- change without the platform changing, and the owner must be able to set it
-- without a deploy.
SELECT set_config('app.actor_role', 'OWNER', true);--> statement-breakpoint

INSERT INTO settings (key, value, description_ar, is_public) VALUES
  ('tax.rateBp', '0'::jsonb,
   'نسبة الضريبة بنقاط الأساس (١٥٪ = 1500). صفر = لا ضريبة', false),
  ('tax.nameAr', '"ضريبة القيمة المضافة"'::jsonb,
   'اسم الضريبة كما يظهر على الفاتورة', false),
  ('tax.registration', '""'::jsonb,
   'الرقم الضريبي للمنصة، يظهر على الفاتورة إن وُجد', false),
  ('invoice.prefix', '"INV"'::jsonb,
   'بادئة رقم الفاتورة', false),
  ('invoice.sellerNameAr', '"إنجينورا"'::jsonb,
   'اسم البائع القانوني على الفاتورة', false),
  ('invoice.sellerAddressAr', '""'::jsonb,
   'عنوان البائع على الفاتورة', false)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

-- Issuing an invoice is a financial act and is audited like one.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'INVOICE_ISSUED';
