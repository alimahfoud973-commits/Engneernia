-- ===========================================================================
-- OWNER DECISION: THE PLATFORM ISSUES NO REFUNDS
--
-- "لا اريد أن يكون هناك نظام استرجاع في المنصة
--  الكتاب الذي يباع لا يسترد أمواله لأي سبب"
--
-- This revokes decisions §7, which had asked for a manual, owner-reviewed
-- refund for exceptional cases. The feature built for it in P6 is removed
-- here rather than disabled, because the instruction is that the system must
-- not EXIST — and a disabled refund system is still a refund system, with
-- rows, policies and an off switch somebody can flip by accident.
--
-- THE ONE CASE THIS DOES NOT LEAVE UNCOVERED is a duplicate transfer, which
-- decisions §7 had listed. It needs no refund: the owner simply does not
-- approve the second payment, so no sale is recorded, no entitlement is
-- granted, and the money never enters the books as revenue. That path already
-- exists and is unchanged.
--
-- WHAT IS DESTRUCTIVE HERE, stated plainly: two tables, two enum types, a
-- sequence, a function, two columns on order_items and two settings rows are
-- DROPPED. In this project they hold test data only; there is no production
-- deployment yet. A database that did hold real refund records must not run
-- this migration without exporting them first.
-- ===========================================================================

-- --- the feature's own storage ---------------------------------------------
DROP TABLE IF EXISTS "refund_request_items";--> statement-breakpoint
DROP TABLE IF EXISTS "refund_requests";--> statement-breakpoint
DROP TYPE IF EXISTS "refund_reason";--> statement-breakpoint
DROP TYPE IF EXISTS "refund_status";--> statement-breakpoint
DROP FUNCTION IF EXISTS app_next_refund_reference();--> statement-breakpoint
DROP SEQUENCE IF EXISTS refund_reference_seq;--> statement-breakpoint

-- --- the marks a refund used to leave on a sale -----------------------------
DROP INDEX IF EXISTS "order_items_one_refund";--> statement-breakpoint
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "refunded_at";--> statement-breakpoint
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "refund_request_id";--> statement-breakpoint

-- --- the policy settings the feature read -----------------------------------
SELECT set_config('app.actor_role', 'OWNER', true);--> statement-breakpoint
DELETE FROM settings WHERE key IN ('refunds.requestWindowDays', 'refunds.blockAfterDownload');
--> statement-breakpoint
UPDATE settings
   SET value = '"المنتجات رقمية، ولا يوجد استرجاع بعد إتمام الشراء."'::jsonb,
       description_ar = 'سياسة الاسترجاع المعروضة للعملاء. قرار المالك: لا استرجاع لأي سبب.'
 WHERE key = 'refund.policyAr';
--> statement-breakpoint

-- ===========================================================================
-- AND THE BOOKS REFUSE TO RECORD ONE
--
-- Deleting the application code is not the same as making the thing
-- impossible. The ledger's REFUND and REFUND_PAYOUT kinds cannot be removed
-- from the enum — lines written before this decision reference them, and the
-- ledger is append-only — so the posting function refuses them instead.
--
-- After this, there is no route by which a refund can reach the books: not
-- through application code, not through a future caller that forgets, not
-- through a hand-written statement in a console.
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
    v_contrib_name text;
    v_requires     boolean;
    v_actor        uuid := app_actor_id();
    v_lines_canon  text := '';
  BEGIN
    IF NOT app_is_owner() THEN
      RAISE EXCEPTION 'Only the platform owner may post to the ledger'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- The owner's decision, enforced where it cannot be bypassed.
    IF p_kind IN ('REFUND', 'REFUND_PAYOUT') THEN
      RAISE EXCEPTION
        'This platform issues no refunds: a completed sale is final. Correct an error with an ADJUSTMENT entry instead.'
        USING ERRCODE = 'check_violation';
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

    PERFORM pg_advisory_xact_lock(4_872_001_553_990_117);

    SELECT entry_hash INTO v_prev_hash
      FROM ledger_transactions ORDER BY seq DESC LIMIT 1;
    v_prev_hash := COALESCE(v_prev_hash, repeat('0', 64));

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      v_line_no := v_line_no + 1;
      v_count   := v_count + 1;

      v_account := v_line ->> 'account';
      v_amount  := (v_line ->> 'amountMinor')::bigint;
      v_contributor := NULLIF(v_line ->> 'contributorId', '')::uuid;
      v_contrib_name := NULL;

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

      IF v_contributor IS NOT NULL THEN
        SELECT display_name INTO v_contrib_name
          FROM contributors WHERE id = v_contributor;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Cannot book against contributor % — no such contributor',
            v_contributor USING ERRCODE = 'foreign_key_violation';
        END IF;
      END IF;

      v_total := v_total + v_amount;

      v_lines_canon := v_lines_canon
        || v_line_no::text || '|' || v_account || '|'
        || COALESCE(v_contributor::text, '') || '|' || v_amount::text || E'\n';

      INSERT INTO ledger_lines (
        transaction_id, line_no, account_code, contributor_id, contributor_name,
        amount_minor, currency, occurred_at, period_key, kind, memo
      ) VALUES (
        v_tx_id, v_line_no, v_account, v_contributor, v_contrib_name,
        v_amount, p_currency, p_occurred_at, v_period_key,
        p_kind::ledger_transaction_kind, v_line ->> 'memo'
      );
    END LOOP;

    IF v_count < 2 THEN
      RAISE EXCEPTION 'A ledger transaction needs at least two lines, got %', v_count
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_total <> 0 THEN
      RAISE EXCEPTION
        'Ledger transaction does not balance: lines sum to % in %', v_total, p_currency
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

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
