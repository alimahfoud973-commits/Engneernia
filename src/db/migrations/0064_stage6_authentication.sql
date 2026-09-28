-- ===========================================================================
-- STAGE 6 — AUTHENTICATION, THE OWNER'S FINAL MODEL (2026-09-28)
--
--   * A SUBSCRIBER (customer) registers with a name, a phone and an email, and
--     is an ACTIVE CUSTOMER from the first moment — no approval, no PENDING,
--     no password, no confirmation link. They sign in with the phone AND the
--     email together; both must belong to the same account.
--   * An ENGINEER is a subscriber the owner promoted, and signs in the same way.
--   * The OWNER signs in with a username and the password set when the owner
--     account was created. No second factor of any kind.
--
-- THE RISK THE OWNER ACCEPTED. Neither a phone number nor an email address is
-- a secret: whoever knows both can sign in as that subscriber. The owner chose
-- this over a password, a code or a link (DECISIONS.md, Stage 6). What this
-- migration can still guarantee is that the path is narrow — it never reaches
-- the owner, never reaches a password, and is rate limited in the application.
--
-- Everything the old model needed and the new one forbids is REMOVED, not
-- left dormant, so no old path can bypass the new one:
--   * the email-verification table and its three functions — the consume
--     function turned PENDING into ACTIVE, a bypass of any approval step;
--   * TOTP: the two user columns, the session column, and the function that
--     marked a session as having passed the challenge;
--   * `app_change_own_password`, which let ANY signed-in user write a password
--     hash onto their own row — subscribers have no password;
--   * the lookup-by-email and lookup-by-id functions the password/TOTP login
--     used.
--
-- Financial and historical rows are untouched: no user row is deleted, no id
-- changes, and the audit enum keeps its old values for the rows that use them.
--
-- Every SECURITY DEFINER function of the authentication path now pins
-- `search_path = public, pg_temp` (the gap 0060 left for this stage): without
-- pg_temp last, a caller's temporary table named `users` or `sessions` would be
-- resolved FIRST inside a definer function.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. EMAIL VERIFICATION — removed.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_consume_email_verification(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS app_reissue_email_verification(text, text, timestamptz);--> statement-breakpoint
DROP FUNCTION IF EXISTS app_prune_email_verification_tokens(integer);--> statement-breakpoint
DROP TABLE IF EXISTS email_verification_tokens;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. THE OLD LOGIN PATH AND THE SECOND FACTOR — removed.
--    Functions first: they read the columns dropped below.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_auth_lookup_user(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS app_auth_lookup_user_by_id(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS app_auth_mark_two_factor(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS app_change_own_password(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS app_auth_resolve_session(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS app_auth_create_session(uuid, text, timestamptz, text, text, boolean);--> statement-breakpoint
DROP FUNCTION IF EXISTS app_register_customer(text, text, text, text);--> statement-breakpoint

ALTER TABLE users DROP COLUMN IF EXISTS totp_secret_encrypted;--> statement-breakpoint
ALTER TABLE users DROP COLUMN IF EXISTS totp_enabled_at;--> statement-breakpoint
ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at;--> statement-breakpoint
ALTER TABLE sessions DROP COLUMN IF EXISTS two_factor_verified_at;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. THE IDENTITY COLUMNS.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS username citext;--> statement-breakpoint

-- E.164: a plus, a non-zero country digit, 8 to 15 digits in all. Stored in
-- exactly this form, so uniqueness is uniqueness of the number, not of the
-- way it was typed (the application normalises Arabic digits, spaces, 00).
ALTER TABLE users ADD CONSTRAINT users_phone_e164
  CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone);--> statement-breakpoint

ALTER TABLE users ADD CONSTRAINT users_username_format
  CHECK (username IS NULL OR username::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username);--> statement-breakpoint

-- The owner may have no email; a subscriber has no password.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;--> statement-breakpoint
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;--> statement-breakpoint
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'ACTIVE';--> statement-breakpoint

-- `users` has row security enabled; declaring owner context keeps these
-- UPDATEs valid should it ever be forced (as 0017 and 0056 do).
SELECT set_config('app.actor_role', 'OWNER', true);--> statement-breakpoint

-- No PENDING account exists or may exist.
UPDATE users SET status = 'ACTIVE', updated_at = now() WHERE status::text = 'PENDING';--> statement-breakpoint

-- Subscribers and engineers no longer have passwords. A hash left behind is
-- a credential nothing may use; removing it is the honest state.
UPDATE users SET password_hash = NULL, updated_at = now()
 WHERE role <> 'OWNER' AND password_hash IS NOT NULL;--> statement-breakpoint

-- The existing owner gets a username so the owner can still sign in: the part
-- of the address before '@', reduced to the allowed characters, or 'owner'
-- when that leaves too little. Reported to the owner; `bootstrap:owner`
-- documents it.
UPDATE users
   SET username = CASE
         WHEN regexp_replace(lower(split_part(email::text, '@', 1)), '[^a-z0-9._-]', '', 'g')
              ~ '^[a-z0-9][a-z0-9._-]{2,31}$'
           THEN regexp_replace(lower(split_part(email::text, '@', 1)), '[^a-z0-9._-]', '', 'g')
         ELSE 'owner'
       END,
       updated_at = now()
 WHERE role = 'OWNER' AND username IS NULL;--> statement-breakpoint

SELECT set_config('app.actor_role', '', true);--> statement-breakpoint

-- `status` is compared as text: a value named in a CHECK is not "used".
ALTER TABLE users ADD CONSTRAINT users_no_pending CHECK (status::text <> 'PENDING');--> statement-breakpoint

-- The owner can always sign in: an OWNER row without a username or a password
-- is refused by the database — including a transfer of ownership to an
-- account that has neither (app_transfer_ownership fails as a whole).
ALTER TABLE users ADD CONSTRAINT users_owner_credentials
  CHECK (role <> 'OWNER' OR (username IS NOT NULL AND password_hash IS NOT NULL));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. REGISTRATION — name, phone, email. ACTIVE CUSTOMER at once.
--
-- The role and status are written here, never taken from the caller. The
-- database validates the three fields itself (the form did too — this is the
-- second line, not the only one). An existing phone or email is never touched
-- and never named: the answer is ALREADY_EXISTS with no id, for either.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_register_customer(
  p_display_name text,
  p_phone text,
  p_email text,
  p_locale text
) RETURNS TABLE (user_id uuid, outcome text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE
    v_id uuid;
    v_name text := btrim(coalesce(p_display_name, ''));
    v_email text := lower(btrim(coalesce(p_email, '')));
  BEGIN
    IF char_length(v_name) < 2 OR char_length(v_name) > 80 THEN
      RAISE EXCEPTION 'Invalid display name' USING ERRCODE = 'check_violation';
    END IF;
    IF p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{7,14}$' THEN
      RAISE EXCEPTION 'Invalid phone number' USING ERRCODE = 'check_violation';
    END IF;
    IF char_length(v_email) > 254 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
      RAISE EXCEPTION 'Invalid email address' USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (SELECT 1 FROM users u WHERE u.phone = p_phone OR u.email = v_email::citext) THEN
      RETURN QUERY SELECT NULL::uuid, 'ALREADY_EXISTS'::text;
      RETURN;
    END IF;

    INSERT INTO users (email, phone, password_hash, role, status, display_name, locale)
    VALUES (v_email, p_phone, NULL, 'CUSTOMER', 'ACTIVE', v_name, coalesce(p_locale, 'ar'))
    RETURNING id INTO v_id;

    RETURN QUERY SELECT v_id, 'CREATED'::text;
  EXCEPTION
    -- Two registrations with the same phone (or email) at the same moment:
    -- the unique index decides, and the loser is answered like any existing one.
    WHEN unique_violation THEN
      RETURN QUERY SELECT NULL::uuid, 'ALREADY_EXISTS'::text;
  END;
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_register_customer(text, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_register_customer(text, text, text, text) TO app_user;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. SUBSCRIBER / ENGINEER SIGN-IN — phone AND email, one account.
--
-- Returns a row only when BOTH match the same account, and only for a
-- CUSTOMER or CONTRIBUTOR: this path can never reach the owner, whatever
-- phone or address the owner's row carries. Nothing about a phone that
-- exists with a different email comes back — there is no half-match.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_auth_lookup_member(p_phone text, p_email text)
  RETURNS TABLE (id uuid, role user_role, status user_status, display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.id, u.role, u.status, u.display_name
      FROM users u
     WHERE u.phone = p_phone
       AND u.email = p_email::citext
       AND u.role IN ('CUSTOMER', 'CONTRIBUTOR');
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_auth_lookup_member(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_auth_lookup_member(text, text) TO app_user;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. OWNER SIGN-IN — username and password, the owner row only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_auth_lookup_owner(p_username text)
  RETURNS TABLE (
    id uuid,
    password_hash text,
    role user_role,
    status user_status,
    display_name text,
    locked_until timestamptz,
    failed_login_count integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.id, u.password_hash, u.role, u.status, u.display_name,
           u.locked_until, u.failed_login_count
      FROM users u
     WHERE u.username = p_username::citext
       AND u.role = 'OWNER';
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_auth_lookup_owner(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_auth_lookup_owner(text) TO app_user;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. SESSIONS — the same rules as 0001, without the second factor.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_auth_resolve_session(p_token_hash text)
  RETURNS TABLE (
    session_id uuid,
    user_id uuid,
    role user_role,
    status user_status,
    display_name text,
    locale text,
    contributor_id uuid,
    contributor_active boolean,
    expires_at timestamptz,
    last_used_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT s.id, u.id, u.role, u.status, u.display_name, u.locale,
           c.id, COALESCE(c.is_active, false),
           s.expires_at, s.last_used_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN contributors c ON c.user_id = u.id
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.status = 'ACTIVE';
  $$;--> statement-breakpoint

CREATE FUNCTION app_auth_create_session(
  p_user_id uuid, p_token_hash text, p_expires_at timestamptz,
  p_ip_hash text, p_user_agent text
) RETURNS uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    INSERT INTO sessions (user_id, token_hash, expires_at, ip_hash, user_agent)
    VALUES (p_user_id, p_token_hash, p_expires_at, p_ip_hash, p_user_agent)
    RETURNING id;
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_auth_resolve_session(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_auth_create_session(uuid, text, timestamptz, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  app_auth_resolve_session(text),
  app_auth_create_session(uuid, text, timestamptz, text, text)
TO app_user;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. pg_temp for the authentication functions that stay as they are.
-- ---------------------------------------------------------------------------
ALTER FUNCTION app_auth_record_failure(uuid, integer, integer) SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION app_auth_record_success(uuid) SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION app_auth_touch_session(uuid) SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION app_expire_session(uuid, text) SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION app_revoke_sessions(uuid, text) SET search_path = public, pg_temp;
