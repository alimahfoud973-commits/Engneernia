-- ===========================================================================
-- WHAT MAKES THE LEDGER TRUSTWORTHY (specification §14, §17, §37, §48, §49)
--
-- Hand-written. None of this can be generated from a schema definition,
-- and all of it is the point:
--
--   1. the chart of accounts, so a posting cannot name an account that has
--      no agreed meaning;
--   2. ONE way in — a function that refuses an entry which does not balance,
--      with the application role holding no INSERT privilege at all;
--   3. a hash chain, so editing history with direct database access is
--      detectable rather than merely discouraged;
--   4. append-only enforcement;
--   5. row-level security, so a contributor reading the ledger sees the lines
--      that are owed to them and nothing else — not the platform's revenue,
--      not a co-author's share on their own product.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The accounting timezone, named ONCE for the database.
--
-- decisions §8 fixes it at Asia/Damascus. `src/lib/time/period.ts` holds the
-- same constant for the application, and a test asserts the two agree — a
-- month boundary computed two different ways is a settlement dispute waiting
-- to happen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_accounting_timezone() RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT 'Asia/Damascus'::text $$;
--> statement-breakpoint

/*
 * Why period_key is a trigger and not a GENERATED column: PostgreSQL requires
 * a generation expression to be IMMUTABLE, and converting a timestamptz to a
 * named zone is only STABLE (the zone database can change under it). A BEFORE
 * INSERT trigger gives the same guarantee where it matters — the value is
 * computed by the database from occurred_at, and whatever the caller passed is
 * discarded.
 */
CREATE OR REPLACE FUNCTION ledger_set_period_key() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    NEW.period_key := to_char(
      timezone(app_accounting_timezone(), NEW.occurred_at), 'YYYY-MM');
    RETURN NEW;
  END;
  $$;
--> statement-breakpoint

CREATE TRIGGER ledger_transactions_period_key
  BEFORE INSERT ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION ledger_set_period_key();
--> statement-breakpoint
CREATE TRIGGER ledger_lines_period_key
  BEFORE INSERT ON "ledger_lines"
  FOR EACH ROW EXECUTE FUNCTION ledger_set_period_key();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- THE CHART OF ACCOUNTS
--
-- Six accounts, each with a reason to exist:
--
--   PLATFORM_CASH              what the platform actually holds.
--   ENGINEER_PAYABLE           what is owed to a named engineer. This account
--                              IS the monthly settlement balance (§15).
--   PLATFORM_REVENUE           commission earned.
--   PLATFORM_REVENUE_REVERSED  commission given back on a refund. Kept
--                              separate from PLATFORM_REVENUE so that gross
--                              earnings and reversals are both reportable;
--                              netting them into one account would answer
--                              "how much did we keep" while destroying "how
--                              much did we have to give back", which is the
--                              more interesting question.
--   CUSTOMER_REFUNDS_PAYABLE   approved but not yet transferred. On a manual
--                              payment method those are days apart, and a
--                              ledger that pretends otherwise is wrong for
--                              exactly as long as the gap lasts.
--   PAYMENT_FEES               transfer costs, recorded where known. Who
--                              ultimately bears them is OPEN-2 and is NOT
--                              decided by this table.
-- ---------------------------------------------------------------------------
INSERT INTO "ledger_accounts"
  ("code", "type", "normal_balance", "name_ar", "description_ar", "requires_contributor", "sort_order")
VALUES
  ('PLATFORM_CASH', 'ASSET', 'DEBIT', 'نقدية المنصة',
   'ما استلمته المنصة فعلياً من المشترين وما زال بحوزتها.', false, 10),
  ('ENGINEER_PAYABLE', 'LIABILITY', 'CREDIT', 'مستحقات المهندسين',
   'ما تدين به المنصة لمهندس بعينه. رصيد هذا الحساب هو رصيد التسوية الشهرية.', true, 20),
  ('PLATFORM_REVENUE', 'INCOME', 'CREDIT', 'إيراد المنصة',
   'عمولة المنصة المحققة من المبيعات.', false, 30),
  ('PLATFORM_REVENUE_REVERSED', 'CONTRA_INCOME', 'DEBIT', 'إيراد معكوس',
   'حصة المنصة المعادة عند الاسترجاع. تُفصل عن الإيراد ليبقى الإجمالي والمعكوس ظاهرين.', false, 40),
  ('CUSTOMER_REFUNDS_PAYABLE', 'LIABILITY', 'CREDIT', 'استرجاعات مستحقة للعملاء',
   'استرجاع وافق عليه المالك ولم يُحوَّل بعد.', false, 50),
  ('PAYMENT_FEES', 'EXPENSE', 'DEBIT', 'رسوم التحويل',
   'تكلفة التحويل حيث تكون معروفة. من يتحملها نهائياً قرار معلّق (OPEN-2).', false, 60)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- INTEGRITY CONSTRAINTS
-- ---------------------------------------------------------------------------
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_tx_currency_format"
  CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_tx_period_format"
  CHECK (period_key ~ '^\d{4}-(0[1-9]|1[0-2])$');
--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_tx_hash_format"
  CHECK (prev_hash ~ '^[0-9a-f]{64}$'
     AND payload_hash ~ '^[0-9a-f]{64}$'
     AND entry_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint

-- A zero line carries no information and would let an "entry" balance
-- trivially with nothing in it.
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_amount_non_zero"
  CHECK (amount_minor <> 0);
--> statement-breakpoint
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_currency_format"
  CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_line_no_positive"
  CHECK (line_no >= 1);
--> statement-breakpoint

ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_amount_positive"
  CHECK (amount_minor > 0);
--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_currency_format"
  CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
-- A decision is a decision: an approved or rejected request names who decided
-- and when. Half-recorded decisions are how disputes become unanswerable.
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_decision_complete"
  CHECK (
    status IN ('REQUESTED', 'WITHDRAWN')
    OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
  );
--> statement-breakpoint
-- An approved refund must name the ledger entry that reversed it. There is no
-- such thing as an approved refund the books do not know about.
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_approved_has_reversal"
  CHECK (status NOT IN ('APPROVED', 'PAID') OR reversal_transaction_id IS NOT NULL);
--> statement-breakpoint

ALTER TABLE "refund_request_items" ADD CONSTRAINT "refund_items_amounts_balance"
  CHECK (
    gross_minor > 0
    AND engineer_amount_minor >= 0
    AND platform_amount_minor >= 0
    AND engineer_amount_minor + platform_amount_minor = gross_minor
  );
--> statement-breakpoint

-- One line can be refunded once. A second approved refund of the same sale
-- would pay the customer twice and claw back the engineer twice.
CREATE UNIQUE INDEX "order_items_one_refund"
  ON "order_items" ("id") WHERE refunded_at IS NOT NULL;
--> statement-breakpoint

-- Human-facing refund reference, e.g. RF-000042.
CREATE SEQUENCE IF NOT EXISTS refund_reference_seq START WITH 1;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_next_refund_reference() RETURNS text
  LANGUAGE sql VOLATILE AS $$
    SELECT 'RF-' || lpad(nextval('refund_reference_seq')::text, 6, '0');
  $$;
--> statement-breakpoint

-- ===========================================================================
-- THE ONLY WAY INTO THE LEDGER
--
-- SECURITY DEFINER, because the application role deliberately holds NO insert
-- privilege on the ledger tables. Every posting is validated here or it does
-- not happen: application code cannot write an unbalanced entry, an entry
-- with one line, an entry on an unknown account, or an entry outside the
-- hash chain — not through a bug, and not through an injection.
--
-- search_path is pinned: a SECURITY DEFINER function that resolves names
-- through the caller's search_path is a privilege-escalation primitive.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_post_ledger_transaction(
  p_kind            text,
  p_currency        text,
  p_occurred_at     timestamptz,
  p_reference_type  text,
  p_reference_id    uuid,
  p_memo            text,
  p_lines           jsonb
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE
    v_tx_id        uuid := gen_random_uuid();
    v_prev_hash    text;
    v_payload      text;
    v_payload_hash text;
    v_entry_hash   text;
    v_period_key   text;
    v_total        bigint := 0;
    v_count        int := 0;
    v_line         jsonb;
    v_line_no      int := 0;
    v_amount       bigint;
    v_account      text;
    v_contributor  uuid;
    v_requires     boolean;
    v_actor        uuid := app_actor_id();
    v_lines_canon  text := '';
  BEGIN
    IF NOT app_is_owner() THEN
      -- Posting to the ledger is the platform acting as itself. Every caller
      -- today is an owner-authorised flow; this is the backstop that keeps it
      -- that way if a future caller forgets.
      RAISE EXCEPTION 'Only the platform owner may post to the ledger'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_currency !~ '^[A-Z]{3}$' THEN
      RAISE EXCEPTION 'Ledger currency must be a three-letter code, got %', p_currency
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF jsonb_typeof(p_lines) <> 'array' THEN
      RAISE EXCEPTION 'Ledger lines must be a JSON array'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_period_key := to_char(timezone(app_accounting_timezone(), p_occurred_at), 'YYYY-MM');

    -- Serialise the chain. A hash chain is inherently sequential: two
    -- concurrent postings reading the same predecessor would fork it. The
    -- lock is transaction-scoped, so it releases on commit or rollback
    -- without a cleanup path.
    PERFORM pg_advisory_xact_lock(4_872_001_553_990_117);

    SELECT entry_hash INTO v_prev_hash
      FROM ledger_transactions ORDER BY seq DESC LIMIT 1;
    v_prev_hash := COALESCE(v_prev_hash, repeat('0', 64));

    -- --- validate and canonicalise the lines ---------------------------------
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      v_line_no := v_line_no + 1;
      v_count   := v_count + 1;

      v_account := v_line ->> 'account';
      -- Amounts travel as TEXT, never as JSON numbers: a JSON number is a
      -- double on the way through JavaScript, and a double silently loses
      -- integer precision above 2^53.
      v_amount  := (v_line ->> 'amountMinor')::bigint;
      v_contributor := NULLIF(v_line ->> 'contributorId', '')::uuid;

      IF v_amount = 0 THEN
        RAISE EXCEPTION 'Ledger line % has a zero amount', v_line_no
          USING ERRCODE = 'invalid_parameter_value';
      END IF;

      SELECT requires_contributor INTO v_requires
        FROM ledger_accounts WHERE code = v_account;

      IF v_requires IS NULL THEN
        RAISE EXCEPTION 'Unknown ledger account %', v_account
          USING ERRCODE = 'invalid_parameter_value';
      END IF;

      IF v_requires AND v_contributor IS NULL THEN
        RAISE EXCEPTION 'Account % requires a contributor, none given on line %',
          v_account, v_line_no USING ERRCODE = 'invalid_parameter_value';
      END IF;

      IF NOT v_requires AND v_contributor IS NOT NULL THEN
        RAISE EXCEPTION 'Account % must not name a contributor (line %)',
          v_account, v_line_no USING ERRCODE = 'invalid_parameter_value';
      END IF;

      v_total := v_total + v_amount;

      v_lines_canon := v_lines_canon
        || v_line_no::text || '|' || v_account || '|'
        || COALESCE(v_contributor::text, '') || '|' || v_amount::text || E'\n';

      INSERT INTO ledger_lines (
        transaction_id, line_no, account_code, contributor_id, amount_minor,
        currency, occurred_at, period_key, kind, memo
      ) VALUES (
        v_tx_id, v_line_no, v_account, v_contributor, v_amount,
        p_currency, p_occurred_at, v_period_key, p_kind::ledger_transaction_kind,
        v_line ->> 'memo'
      );
    END LOOP;

    -- --- the rule the whole system rests on ---------------------------------
    IF v_count < 2 THEN
      RAISE EXCEPTION 'A ledger transaction needs at least two lines, got %', v_count
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_total <> 0 THEN
      RAISE EXCEPTION
        'Ledger transaction does not balance: lines sum to % in %', v_total, p_currency
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- --- the chain -----------------------------------------------------------
    v_payload :=
         p_kind || '|' || p_currency || '|'
      || to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '|'
      || v_period_key || '|' || p_reference_type || '|'
      || COALESCE(p_reference_id::text, '') || '|'
      || COALESCE(p_memo, '') || '|' || COALESCE(v_actor::text, '') || E'\n'
      || v_lines_canon;

    v_payload_hash := encode(sha256(convert_to(v_payload, 'UTF8')), 'hex');
    v_entry_hash   := encode(
      sha256(convert_to(v_prev_hash || ':' || v_payload_hash, 'UTF8')), 'hex');

    INSERT INTO ledger_transactions (
      id, kind, currency, occurred_at, period_key, reference_type, reference_id,
      memo, actor_user_id, prev_hash, payload_hash, entry_hash
    ) VALUES (
      v_tx_id, p_kind::ledger_transaction_kind, p_currency, p_occurred_at, v_period_key,
      p_reference_type, p_reference_id, p_memo, v_actor,
      v_prev_hash, v_payload_hash, v_entry_hash
    );

    RETURN v_tx_id;
  END;
  $$;
--> statement-breakpoint

-- ===========================================================================
-- VERIFICATION
--
-- Recomputes every hash from the stored rows and compares. This is what turns
-- "we believe nobody edited the books" into a statement that can be checked,
-- including against someone holding the migrator password.
--
-- Returns one row per problem, in chain order. An empty result means the
-- ledger is intact.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_verify_ledger_chain()
  RETURNS TABLE (seq bigint, transaction_id uuid, problem text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE
    v_row          record;
    v_expect_prev  text := repeat('0', 64);
    v_payload      text;
    v_payload_hash text;
    v_entry_hash   text;
    v_lines_canon  text;
  BEGIN
    IF NOT app_is_owner() THEN
      RAISE EXCEPTION 'Ledger verification is owner-only'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    FOR v_row IN SELECT * FROM ledger_transactions t ORDER BY t.seq ASC LOOP
      SELECT COALESCE(string_agg(
               l.line_no::text || '|' || l.account_code || '|'
               || COALESCE(l.contributor_id::text, '') || '|' || l.amount_minor::text || E'\n',
               '' ORDER BY l.line_no), '')
        INTO v_lines_canon
        FROM ledger_lines l WHERE l.transaction_id = v_row.id;

      v_payload :=
           v_row.kind::text || '|' || v_row.currency || '|'
        || to_char(v_row.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '|'
        || v_row.period_key || '|' || v_row.reference_type || '|'
        || COALESCE(v_row.reference_id::text, '') || '|'
        || COALESCE(v_row.memo, '') || '|' || COALESCE(v_row.actor_user_id::text, '') || E'\n'
        || v_lines_canon;

      v_payload_hash := encode(sha256(convert_to(v_payload, 'UTF8')), 'hex');
      v_entry_hash   := encode(
        sha256(convert_to(v_row.prev_hash || ':' || v_payload_hash, 'UTF8')), 'hex');

      IF v_row.prev_hash <> v_expect_prev THEN
        seq := v_row.seq; transaction_id := v_row.id;
        problem := 'broken link: prev_hash does not match the previous entry';
        RETURN NEXT;
      END IF;

      IF v_payload_hash <> v_row.payload_hash THEN
        seq := v_row.seq; transaction_id := v_row.id;
        problem := 'content altered: the stored rows no longer hash to payload_hash';
        RETURN NEXT;
      END IF;

      IF v_entry_hash <> v_row.entry_hash THEN
        seq := v_row.seq; transaction_id := v_row.id;
        problem := 'entry_hash does not match prev_hash and payload_hash';
        RETURN NEXT;
      END IF;

      v_expect_prev := v_row.entry_hash;
    END LOOP;

    RETURN;
  END;
  $$;
--> statement-breakpoint

-- Every currency must net to zero across the whole ledger. A non-zero row
-- means money was created or destroyed.
CREATE OR REPLACE FUNCTION app_ledger_balance_check()
  RETURNS TABLE (currency text, total_minor bigint, line_count bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  BEGIN
    IF NOT app_is_owner() THEN
      RAISE EXCEPTION 'Ledger balance check is owner-only'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN QUERY
      SELECT l.currency, SUM(l.amount_minor)::bigint, COUNT(*)::bigint
        FROM ledger_lines l
       GROUP BY l.currency
       ORDER BY l.currency;
  END;
  $$;
--> statement-breakpoint

-- ===========================================================================
-- APPEND-ONLY
-- ===========================================================================
CREATE OR REPLACE FUNCTION ledger_is_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION
      '% is append-only: correct a mistake by posting a reversing entry, never by editing one (specification 14)',
      TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END;
  $$;
--> statement-breakpoint

CREATE TRIGGER ledger_transactions_no_update
  BEFORE UPDATE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_no_delete
  BEFORE DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_lines_no_update
  BEFORE UPDATE ON "ledger_lines"
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_lines_no_delete
  BEFORE DELETE ON "ledger_lines"
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();
--> statement-breakpoint

-- ===========================================================================
-- ROW-LEVEL SECURITY
--
-- NOT forced. FORCE applies row-level security to the table owner as well,
-- which is exactly what would stop app_post_ledger_transaction — a
-- SECURITY DEFINER function running as that owner — from writing at all.
-- This is the fourth table group where that trade-off appears; the pattern is
-- recorded in CLAUDE.md.
--
-- Leaving FORCE off costs nothing here, because the application role is not
-- the owner and is therefore subject to these policies unconditionally, and
-- because it has no INSERT, UPDATE or DELETE privilege on these tables to
-- begin with.
-- ===========================================================================
ALTER TABLE "ledger_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- The chart of accounts is a dictionary, not data. Any authenticated reader
-- may resolve a code to a name; it discloses nothing about any amount.
CREATE POLICY "ledger_accounts_select" ON "ledger_accounts" FOR SELECT
  USING (app_actor_id() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY "ledger_accounts_write" ON "ledger_accounts" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

ALTER TABLE "ledger_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- A contributor may see the HEADER of a transaction that credits or debits
-- them — the date, the kind, the reference — because that is the statement
-- line they are entitled to explain. The amounts live in ledger_lines, which
-- is filtered separately and far more tightly.
CREATE POLICY "ledger_transactions_select" ON "ledger_transactions" FOR SELECT
  USING (
    app_is_owner()
    OR (app_contributor_id() IS NOT NULL AND EXISTS (
          SELECT 1 FROM ledger_lines l
           WHERE l.transaction_id = ledger_transactions.id
             AND l.contributor_id = app_contributor_id()))
  );
--> statement-breakpoint

ALTER TABLE "ledger_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- THE PRIVACY RULE OF §12 AND §49, AS A DATABASE POLICY.
--
-- A contributor sees a ledger line only if it is theirs. Not the platform's
-- revenue on their own sale, not a co-author's share of the same product, not
-- the cash account. There is no query — through the application, through a
-- forgotten WHERE clause, through a crafted parameter — that returns another
-- party's financial line to them.
CREATE POLICY "ledger_lines_select" ON "ledger_lines" FOR SELECT
  USING (
    app_is_owner()
    OR (app_contributor_id() IS NOT NULL AND "contributor_id" = app_contributor_id())
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- PRIVILEGES
--
-- The application role may READ the ledger (filtered by the policies above)
-- and may not write it by any route other than the posting function. This is
-- stronger than a policy: there is no INSERT grant to authorise.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "ledger_transactions" FROM app_user;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "ledger_lines" FROM app_user;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "ledger_accounts" FROM app_user;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs" FROM app_user;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "order_events" FROM app_user;
--> statement-breakpoint

GRANT USAGE ON SEQUENCE refund_reference_seq TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  app_accounting_timezone(),
  app_next_refund_reference(),
  app_post_ledger_transaction(text, text, timestamptz, text, uuid, text, jsonb),
  app_verify_ledger_chain(),
  app_ledger_balance_check()
TO app_user;
--> statement-breakpoint

-- ===========================================================================
-- REFUND VISIBILITY (specification §17, §49)
-- ===========================================================================
ALTER TABLE "refund_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Owner and the customer who asked. NOT the contributor: a refund request
-- names a buyer and quotes their complaint about a product. The engineer sees
-- the financial CONSEQUENCE in their own ledger line, not the customer's words.
CREATE POLICY "refund_requests_select" ON "refund_requests" FOR SELECT
  USING (app_is_owner() OR "customer_id" = app_actor_id());
--> statement-breakpoint
CREATE POLICY "refund_requests_insert" ON "refund_requests" FOR INSERT
  WITH CHECK (app_is_owner() OR "customer_id" = app_actor_id());
--> statement-breakpoint
-- A customer may only withdraw their own request while it is still pending.
-- Approving, rejecting and marking paid are the owner's, without exception.
CREATE POLICY "refund_requests_update" ON "refund_requests" FOR UPDATE
  USING (
    app_is_owner()
    OR ("customer_id" = app_actor_id() AND "status" = 'REQUESTED')
  )
  WITH CHECK (
    app_is_owner()
    OR ("customer_id" = app_actor_id() AND "status" IN ('REQUESTED', 'WITHDRAWN'))
  );
--> statement-breakpoint
CREATE POLICY "refund_requests_delete" ON "refund_requests" FOR DELETE
  USING (app_is_owner());
--> statement-breakpoint

ALTER TABLE "refund_request_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_request_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "refund_request_items_select" ON "refund_request_items" FOR SELECT
  USING (
    app_is_owner()
    OR EXISTS (SELECT 1 FROM refund_requests r
                WHERE r.id = refund_request_items.refund_request_id
                  AND r.customer_id = app_actor_id())
  );
--> statement-breakpoint
CREATE POLICY "refund_request_items_insert" ON "refund_request_items" FOR INSERT
  WITH CHECK (
    app_is_owner()
    OR EXISTS (SELECT 1 FROM refund_requests r
                WHERE r.id = refund_request_items.refund_request_id
                  AND r.customer_id = app_actor_id()
                  AND r.status = 'REQUESTED')
  );
--> statement-breakpoint
CREATE POLICY "refund_request_items_write" ON "refund_request_items" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- New audit actions for this phase. Added with IF NOT EXISTS because a failed
-- ALTER TYPE aborts the entire migration (see CLAUDE.md).
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'REFUND_REQUESTED';--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'REFUND_REJECTED';--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'REFUND_WITHDRAWN';--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'REFUND_PAID';--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'LEDGER_ADJUSTMENT_POSTED';
