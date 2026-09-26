-- ===========================================================================
-- SIGN-UP WITHOUT EMAIL CONFIRMATION (owner decision, reversing OPEN-23)
--
-- 0039 created every self-registered account PENDING and `attemptLogin`
-- refused PENDING until a link sent by email was opened. The owner decided
-- that signing in needs only the address and the password: no confirmation
-- step, no mail at registration. So:
--
--   1. `app_register_customer` now creates the account ACTIVE and issues no
--      token. Its signature changes (the token arguments are gone), so the
--      old function is dropped rather than replaced.
--
--   2. AN EXISTING ADDRESS IS NEVER TOUCHED. 0039 let the newest applicant
--      replace the password of an account nobody had verified yet. That was
--      safe only while such an account could not sign in; with accounts
--      ACTIVE from the first moment it would be a takeover of a working
--      account. Any existing row — ACTIVE, DISABLED, or PENDING from before
--      this migration — returns ALREADY_EXISTS and nothing changes.
--
--   3. The role is still hard-coded CUSTOMER; nothing on this path names one.
--
--   4. Accounts left PENDING by 0039 are activated, so the people who signed
--      up and never opened the link can sign in. `email_verified_at` stays
--      NULL for them — the address was not proven, and nothing reads it as a
--      gate. DISABLED accounts are not touched.
--
-- The verification link machinery (0039's tokens, consume function and
-- /verify-email page) stays: links already in inboxes still work, and it
-- changes nothing for an account that is already ACTIVE.
-- ===========================================================================

DROP FUNCTION IF EXISTS app_register_customer(text, text, text, text, text, timestamptz);--> statement-breakpoint

CREATE FUNCTION app_register_customer(
  p_email text,
  p_password_hash text,
  p_display_name text,
  p_locale text
) RETURNS TABLE (user_id uuid, outcome text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE
    v_id uuid;
  BEGIN
    SELECT u.id INTO v_id FROM users u WHERE u.email = p_email::citext;
    IF FOUND THEN
      RETURN QUERY SELECT v_id, 'ALREADY_EXISTS'::text;
      RETURN;
    END IF;

    INSERT INTO users (email, password_hash, role, status, display_name, locale)
    VALUES (p_email, p_password_hash, 'CUSTOMER', 'ACTIVE', p_display_name, p_locale)
    RETURNING id INTO v_id;

    RETURN QUERY SELECT v_id, 'CREATED'::text;
  EXCEPTION
    -- Two sign-ups for the same address at the same moment: the loser sees
    -- the winner's row, and is answered exactly like any existing address.
    WHEN unique_violation THEN
      SELECT u.id INTO v_id FROM users u WHERE u.email = p_email::citext;
      RETURN QUERY SELECT v_id, 'ALREADY_EXISTS'::text;
  END;
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_register_customer(text, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_register_customer(text, text, text, text) TO app_user;--> statement-breakpoint

-- `users` has row security enabled; declaring owner context keeps this
-- UPDATE valid should it ever be forced, as 0017 does for `settings`.
SELECT set_config('app.actor_role', 'OWNER', true);--> statement-breakpoint

UPDATE users SET status = 'ACTIVE', updated_at = now() WHERE status = 'PENDING';--> statement-breakpoint

SELECT set_config('app.actor_role', '', true);
