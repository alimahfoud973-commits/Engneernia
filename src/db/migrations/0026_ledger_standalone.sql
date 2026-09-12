-- ===========================================================================
-- THE LEDGER MUST OUTLIVE WHAT IT DESCRIBES
--
-- ledger_lines referenced contributors with ON DELETE RESTRICT, which made
-- deleting a contributor impossible the moment they were credited with
-- anything. That is arguably correct accounting, and it is still the wrong
-- constraint: it makes the ledger a reason not to be able to erase a person,
-- when the ledger's actual requirement is only that the RECORD survive.
--
-- The same tension was resolved the same way in migration 0013 for
-- download_events and in 0019 for order_events. The rule the project now
-- follows:
--
--   an append-only trail holds identifiers, not foreign keys, and carries
--   enough context to be read on its own. Deleting an account removes the
--   identity; it does not remove the history.
--
-- Referential correctness is not abandoned — it moves from a constraint that
-- lasts forever to a CHECK at the moment of writing: the posting function
-- verifies the contributor exists before it books anything against them. A
-- mistyped id still cannot enter the books; a deleted contributor no longer
-- holds the books hostage.
--
-- NOTE: the function below names a column that does not exist
-- (contributors.display_name_ar; the column is display_name). It is left
-- exactly as it was applied. Migration 0027 replaces the function.
-- An applied migration is append-only: drizzle records a hash of each file,
-- and editing one in place leaves every database that already ran it
-- disagreeing with the file that claims to describe it.
-- ===========================================================================

ALTER TABLE "ledger_lines"
  DROP CONSTRAINT IF EXISTS "ledger_lines_contributor_id_contributors_id_fk";
--> statement-breakpoint

-- Read on its own: a settlement statement printed in five years should still
-- name a person, not only a uuid whose row has since been removed.
ALTER TABLE "ledger_lines" ADD COLUMN IF NOT EXISTS "contributor_name" text;
--> statement-breakpoint

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
      -- Amounts travel as TEXT: a JSON number is a double by the time it has
      -- passed through JavaScript, and a double loses integer precision above
      -- 2^53 silently, for the largest amounts only.
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

      -- Referential correctness, checked once, at write time. This replaces
      -- the foreign key that used to make contributors undeletable.
      IF v_contributor IS NOT NULL THEN
        SELECT display_name_ar INTO v_contrib_name
          FROM contributors WHERE id = v_contributor;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Cannot book against contributor % — no such contributor',
            v_contributor USING ERRCODE = 'foreign_key_violation';
        END IF;
      END IF;

      v_total := v_total + v_amount;

      -- The contributor's NAME is deliberately absent from the hashed payload.
      -- It is a display convenience that may legitimately be corrected or
      -- erased later; the identifier and the amount are the financial facts,
      -- and those are what the chain protects.
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
