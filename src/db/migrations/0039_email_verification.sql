-- ===========================================================================
-- SELF-REGISTRATION WITH EMAIL VERIFICATION (owner decision on OPEN-23)
--
-- The owner chose: customers create their own accounts and must prove control
-- of the address before the account becomes usable. That decision changes the
-- attack surface, so the whole path lives behind SECURITY DEFINER functions
-- and the token table is readable by nobody.
--
-- Hand-written rather than generated: drizzle-kit produces the table, but not
-- one line of what actually makes this safe — the revoked grants, the empty
-- policy set, and the three functions that are the only way in.
--
-- FOUR PROPERTIES THIS FILE GUARANTEES
--
--   1. THE TOKEN IS NEVER STORED. Only its SHA-256 hash is. A dump of this
--      table hands the attacker nothing they can put in a URL — the same
--      decision already taken for session tokens in 0000.
--
--   2. ONE USE, AND THE DATABASE ENFORCES IT. Consumption is a single
--      conditional UPDATE on `consumed_at`; two concurrent requests with the
--      same link cannot both win, because the second one matches no row.
--
--   3. AN UNVERIFIED ACCOUNT BELONGS TO NOBODY. Registering again over a
--      PENDING address replaces the password and invalidates every
--      outstanding token. Without this, anyone could squat on a stranger's
--      address and hold it forever; with it, whoever proves control of the
--      mailbox gets the account, which is the only defensible rule.
--
--   4. THE ANSWER IS THE SAME EITHER WAY. The functions return an outcome the
--      caller uses to decide WHICH EMAIL to send — never what to tell the
--      browser. The registration form must not become a way to ask whether an
--      address has an account here (§36).
--
-- EVERY EMAIL COMPARISON IS CAST TO citext, EXPLICITLY
--
--   `users.email` is citext, but `u.email = p_email` with a text parameter is
--   NOT case-insensitive: PostgreSQL resolves it by casting the citext side
--   DOWN to text, so 'ABC'::citext = 'abc'::text is false. The unique index,
--   being citext, disagrees. Written without the cast, this function looked up
--   'ZAIN@example.com', found nothing, took the insert branch, and died on
--   `users_email_unique` — which is how it was found: by running it, not by
--   reading it. The cast makes the lookup agree with the constraint.
-- ===========================================================================

-- Two new audit actions. Self-registration is the first way an account can come
-- into existence without the owner doing it, so it gets its own entry rather
-- than hiding inside USER_CREATED alongside accounts the owner made.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'USER_REGISTERED';--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'USER_EMAIL_VERIFIED';--> statement-breakpoint

CREATE TABLE "email_verification_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "email_verification_tokens_hash_unique"
  ON "email_verification_tokens" ("token_hash");--> statement-breakpoint
CREATE INDEX "email_verification_tokens_user_idx"
  ON "email_verification_tokens" ("user_id");--> statement-breakpoint
-- Housekeeping reads this: spent and expired rows are prunable.
CREATE INDEX "email_verification_tokens_expiry_idx"
  ON "email_verification_tokens" ("expires_at");--> statement-breakpoint

-- --- nobody reads this table ----------------------------------------------
-- Three independent refusals, because each covers what the others miss:
--
--   REVOKE      removes the grant the default privileges hand out, so the
--               refusal happens before RLS is even consulted. This is the one
--               that actually fires: PostgreSQL answers "permission denied".
--
--   RLS + a     an explicit USING (false) rather than an empty policy set.
--   false       Both deny everything, but they read differently to whoever
--   policy      comes next: no policies is indistinguishable from a table
--               where somebody enabled RLS and forgot, and the suite's
--               "every RLS-enabled table has at least one policy" invariant
--               exists precisely to catch that mistake. Saying `false` out
--               loud keeps the invariant meaningful instead of carving out an
--               exception to it.
--
--   NO FORCE    deliberately, so the definer functions below — owned by
--               `migrator` — remain the one way through.
ALTER TABLE "email_verification_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "email_verification_tokens" FROM app_user;--> statement-breakpoint
CREATE POLICY "email_verification_tokens_deny_all" ON "email_verification_tokens"
  FOR ALL USING (false) WITH CHECK (false);--> statement-breakpoint

-- ===========================================================================
-- app_register_customer
--
-- Returns the user and an outcome that tells the caller which mail to send:
--
--   CREATED           a new account; send the verification link.
--   PENDING_REPLACED  the address had an unverified account; its password was
--                     replaced and older tokens were killed. Send the link.
--   ALREADY_VERIFIED  a real account exists. NO token is issued and nothing is
--                     changed; the caller sends a "you already have an
--                     account" mail to the address itself. This is what keeps
--                     the form silent while still telling the actual owner
--                     that somebody tried.
--
-- The role is hard-coded CUSTOMER. Self-registration must never be able to
-- ask for a role, and passing one in would make that a single missing
-- validation away (§32, §46: contributors are created by the owner).
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_register_customer(
  p_email text,
  p_password_hash text,
  p_display_name text,
  p_locale text,
  p_token_hash text,
  p_expires_at timestamptz
) RETURNS TABLE (user_id uuid, outcome text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE
    v_user users%ROWTYPE;
  BEGIN
    SELECT * INTO v_user FROM users u WHERE u.email = p_email::citext;

    IF FOUND AND v_user.email_verified_at IS NOT NULL THEN
      RETURN QUERY SELECT v_user.id, 'ALREADY_VERIFIED'::text;
      RETURN;
    END IF;

    IF FOUND THEN
      -- Unverified. Nobody owns it yet, so the newest applicant takes it.
      -- A DISABLED account is left alone: that status is the owner's decision
      -- and must not be reversible by re-registering.
      IF v_user.status = 'DISABLED' THEN
        RETURN QUERY SELECT v_user.id, 'ALREADY_VERIFIED'::text;
        RETURN;
      END IF;

      UPDATE users
         SET password_hash = p_password_hash,
             display_name = p_display_name,
             locale = p_locale,
             failed_login_count = 0,
             locked_until = NULL,
             updated_at = now()
       WHERE id = v_user.id;

      UPDATE email_verification_tokens
         SET consumed_at = now()
       WHERE email_verification_tokens.user_id = v_user.id
         AND consumed_at IS NULL;

      INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
      VALUES (v_user.id, p_token_hash, p_expires_at);

      RETURN QUERY SELECT v_user.id, 'PENDING_REPLACED'::text;
      RETURN;
    END IF;

    INSERT INTO users (email, password_hash, role, status, display_name, locale)
    VALUES (p_email, p_password_hash, 'CUSTOMER', 'PENDING', p_display_name, p_locale)
    RETURNING * INTO v_user;

    INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
    VALUES (v_user.id, p_token_hash, p_expires_at);

    RETURN QUERY SELECT v_user.id, 'CREATED'::text;
  END;
  $$;
--> statement-breakpoint

-- ===========================================================================
-- app_consume_email_verification
--
-- Outcomes: VERIFIED | ALREADY_VERIFIED | EXPIRED_OR_SPENT | INVALID.
--
-- EXPIRED_OR_SPENT covers three cases the reader must not have to guess at:
-- a link past its expiry, a link already redeemed, and a link superseded by
-- a newer one. They are one outcome because the remedy is one — ask for a
-- fresh link — and naming it for only the first would mislead whoever reads
-- it in a log.
--
-- The single-use guarantee is the `consumed_at IS NULL` predicate inside the
-- UPDATE, not a prior SELECT. Checking first and updating second is the
-- classic race that lets a double-clicked link be redeemed twice.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_consume_email_verification(p_token_hash text)
  RETURNS TABLE (user_id uuid, outcome text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE
    v_token email_verification_tokens%ROWTYPE;
    v_claimed uuid;
  BEGIN
    SELECT * INTO v_token
      FROM email_verification_tokens t
     WHERE t.token_hash = p_token_hash;

    IF NOT FOUND THEN
      RETURN QUERY SELECT NULL::uuid, 'INVALID'::text;
      RETURN;
    END IF;

    -- An already-verified account reaching here is a link opened twice, or
    -- pre-fetched by a mail client. That is not an error to show anyone.
    IF EXISTS (
      SELECT 1 FROM users u
       WHERE u.id = v_token.user_id AND u.email_verified_at IS NOT NULL
    ) THEN
      RETURN QUERY SELECT v_token.user_id, 'ALREADY_VERIFIED'::text;
      RETURN;
    END IF;

    UPDATE email_verification_tokens
       SET consumed_at = now()
     WHERE token_hash = p_token_hash
       AND consumed_at IS NULL
       AND expires_at > now()
    RETURNING email_verification_tokens.user_id INTO v_claimed;

    IF v_claimed IS NULL THEN
      RETURN QUERY SELECT v_token.user_id, 'EXPIRED_OR_SPENT'::text;
      RETURN;
    END IF;

    -- PENDING becomes ACTIVE. A DISABLED account stays disabled: verifying an
    -- address must never undo the owner's decision to switch someone off.
    UPDATE users
       SET email_verified_at = now(),
           status = CASE WHEN status = 'PENDING' THEN 'ACTIVE' ELSE status END,
           updated_at = now()
     WHERE id = v_claimed;

    RETURN QUERY SELECT v_claimed, 'VERIFIED'::text;
  END;
  $$;
--> statement-breakpoint

-- ===========================================================================
-- app_reissue_email_verification
--
-- The "send it again" path. Returns no row when the address is unknown or
-- already verified, so the caller cannot turn it into an existence oracle.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_reissue_email_verification(
  p_email text,
  p_token_hash text,
  p_expires_at timestamptz
) RETURNS TABLE (user_id uuid, display_name text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE
    v_user users%ROWTYPE;
  BEGIN
    SELECT * INTO v_user
      FROM users u
     WHERE u.email = p_email::citext
       AND u.email_verified_at IS NULL
       AND u.status = 'PENDING';

    IF NOT FOUND THEN
      RETURN;
    END IF;

    UPDATE email_verification_tokens
       SET consumed_at = now()
     WHERE email_verification_tokens.user_id = v_user.id
       AND consumed_at IS NULL;

    INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
    VALUES (v_user.id, p_token_hash, p_expires_at);

    RETURN QUERY SELECT v_user.id, v_user.display_name;
  END;
  $$;
--> statement-breakpoint

-- Housekeeping. Spent and long-expired rows carry no meaning.
CREATE OR REPLACE FUNCTION app_prune_email_verification_tokens(p_older_than_days integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE v_deleted integer;
  BEGIN
    DELETE FROM email_verification_tokens
     WHERE expires_at < now() - make_interval(days => p_older_than_days);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
  END;
  $$;
--> statement-breakpoint

-- ===========================================================================
-- THE SAME DEFECT, IN THE LOGIN LOOKUP — repaired here rather than left.
--
-- app_auth_lookup_user has compared `u.email = p_email` since 0001, with the
-- same text coercion and therefore the same case sensitivity. It has never
-- misbehaved because every caller lowercases the address first, and because
-- nothing could create a user with a capital letter in it: accounts came only
-- from bootstrap-owner.ts, which lowercases too.
--
-- Self-registration ends that. The registration path normalises as well, so
-- this is belt and braces — but a latent trap that only stays harmless while
-- every future caller remembers to lowercase is not one to leave behind while
-- adding the very feature that arms it.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_auth_lookup_user(p_email text)
  RETURNS TABLE (
    id uuid,
    password_hash text,
    role user_role,
    status user_status,
    display_name text,
    locked_until timestamptz,
    failed_login_count integer,
    totp_secret_encrypted text,
    totp_enabled_at timestamptz
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT u.id, u.password_hash, u.role, u.status, u.display_name,
           u.locked_until, u.failed_login_count,
           u.totp_secret_encrypted, u.totp_enabled_at
      FROM users u
     WHERE u.email = p_email::citext;
  $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  app_register_customer(text, text, text, text, text, timestamptz),
  app_consume_email_verification(text),
  app_reissue_email_verification(text, text, timestamptz),
  app_prune_email_verification_tokens(integer)
TO app_user;
