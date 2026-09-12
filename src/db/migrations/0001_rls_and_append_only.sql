-- ===========================================================================
-- AUTHORIZATION AT THE DATABASE LAYER (architecture report §F, layer 3)
--
-- Hand-written, not generated: Row-Level Security is the layer that still
-- protects contributors' private financial data when the application layer
-- has a bug. It is the reason the exit test for this phase runs queries with
-- the policy layer deliberately switched off.
-- ===========================================================================

-- --- Actor context -------------------------------------------------------
-- The application sets these per transaction with `SET LOCAL`, so the context
-- cannot leak between requests sharing a pooled connection.

CREATE OR REPLACE FUNCTION app_actor_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid;
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_actor_role() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(NULLIF(current_setting('app.actor_role', true), ''), 'GUEST');
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_contributor_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.contributor_id', true), '')::uuid;
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_is_owner() RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT app_actor_role() = 'OWNER';
  $$;
--> statement-breakpoint

-- --- users ---------------------------------------------------------------
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- A user may read themselves. The owner may read everyone. Nobody else
-- resolves a single row, with or without a WHERE clause.
CREATE POLICY "users_select" ON "users" FOR SELECT
  USING (app_is_owner() OR "id" = app_actor_id());
--> statement-breakpoint

-- Writes to users are owner-only. Self-service changes (password, locale)
-- go through the narrow SECURITY DEFINER functions below, so that a user can
-- never reach their own `role` or `status` column.
CREATE POLICY "users_insert" ON "users" FOR INSERT WITH CHECK (app_is_owner());--> statement-breakpoint
CREATE POLICY "users_update" ON "users" FOR UPDATE
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint
CREATE POLICY "users_delete" ON "users" FOR DELETE USING (app_is_owner());--> statement-breakpoint

-- --- sessions ------------------------------------------------------------
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "sessions_select" ON "sessions" FOR SELECT
  USING (app_is_owner() OR "user_id" = app_actor_id());
--> statement-breakpoint
CREATE POLICY "sessions_insert" ON "sessions" FOR INSERT
  WITH CHECK (app_is_owner() OR "user_id" = app_actor_id());
--> statement-breakpoint
CREATE POLICY "sessions_update" ON "sessions" FOR UPDATE
  USING (app_is_owner() OR "user_id" = app_actor_id())
  WITH CHECK (app_is_owner() OR "user_id" = app_actor_id());
--> statement-breakpoint
CREATE POLICY "sessions_delete" ON "sessions" FOR DELETE USING (app_is_owner());--> statement-breakpoint

-- --- contributors --------------------------------------------------------
-- ENABLE but deliberately NOT FORCE: the trusted session-resolution function
-- below is owned by `migrator` and must see an inactive contributor's row in
-- order to report `contributor_active = false`. FORCE would hide it and make
-- "inactive" indistinguishable from "not a contributor". The application role
-- is subject to the policies either way, which is the point.
ALTER TABLE "contributors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Public profiles of ACTIVE contributors are public (specification §31).
-- An inactive or unapproved contributor is invisible to everyone but the
-- owner and the contributor themselves.
CREATE POLICY "contributors_select" ON "contributors" FOR SELECT
  USING (
    app_is_owner()
    OR "is_active" = true
    OR "user_id" = app_actor_id()
  );
--> statement-breakpoint
CREATE POLICY "contributors_insert" ON "contributors" FOR INSERT WITH CHECK (app_is_owner());--> statement-breakpoint
CREATE POLICY "contributors_update" ON "contributors" FOR UPDATE
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint
CREATE POLICY "contributors_delete" ON "contributors" FOR DELETE USING (app_is_owner());--> statement-breakpoint

-- --- permission_grants ---------------------------------------------------
ALTER TABLE "permission_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permission_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "permission_grants_owner_all" ON "permission_grants" FOR ALL
  USING (app_is_owner()) WITH CHECK (app_is_owner());
--> statement-breakpoint

-- --- audit_logs ----------------------------------------------------------
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Only the owner reads the audit log (specification §49, owner-only tier).
CREATE POLICY "audit_logs_select" ON "audit_logs" FOR SELECT USING (app_is_owner());--> statement-breakpoint

-- Anyone may APPEND, including an unauthenticated actor: a failed login must
-- be recorded, and at that moment there is no session yet.
CREATE POLICY "audit_logs_insert" ON "audit_logs" FOR INSERT WITH CHECK (true);--> statement-breakpoint

-- No UPDATE or DELETE policy exists, so both are denied to every role that is
-- subject to RLS. The trigger below makes it true even for roles that are not.
CREATE OR REPLACE FUNCTION audit_logs_are_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END;
  $$;
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();
--> statement-breakpoint

-- Belt and braces: the application role is not granted the rights at all.
REVOKE UPDATE, DELETE ON "audit_logs" FROM app_user;--> statement-breakpoint

-- --- rate_limit_buckets --------------------------------------------------
-- Holds only hashed keys and counters, and must be writable before a user is
-- authenticated. RLS is enabled anyway so that "every table has RLS" stays a
-- testable invariant rather than a habit.
ALTER TABLE "rate_limit_buckets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rate_limit_buckets_all" ON "rate_limit_buckets" FOR ALL
  USING (true) WITH CHECK (true);
--> statement-breakpoint

-- ===========================================================================
-- TRUSTED AUTHENTICATION PATH
--
-- Authentication is inherently pre-authorization: to verify a password we must
-- read a user row before any actor context exists. Rather than weakening the
-- policies, these few SECURITY DEFINER functions form a small, auditable
-- trusted surface. Each does exactly one thing and returns only what the
-- caller needs.
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
     WHERE u.email = p_email;
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_auth_record_failure(
  p_user_id uuid, p_max_attempts integer, p_lock_minutes integer
) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE v_locked_until timestamptz;
  BEGIN
    UPDATE users
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= p_max_attempts
               THEN now() + make_interval(mins => p_lock_minutes)
             ELSE locked_until
           END,
           updated_at = now()
     WHERE id = p_user_id
     RETURNING locked_until INTO v_locked_until;
    RETURN v_locked_until;
  END;
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_auth_record_success(p_user_id uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE users
       SET failed_login_count = 0, locked_until = NULL,
           last_login_at = now(), updated_at = now()
     WHERE id = p_user_id;
  $$;
--> statement-breakpoint

-- Resolves a session token to its actor. Returns nothing for a revoked,
-- expired, or disabled-user session — the three revocation paths in one place.
CREATE OR REPLACE FUNCTION app_auth_resolve_session(p_token_hash text)
  RETURNS TABLE (
    session_id uuid,
    user_id uuid,
    role user_role,
    status user_status,
    display_name text,
    locale text,
    contributor_id uuid,
    contributor_active boolean,
    two_factor_verified_at timestamptz,
    totp_enabled_at timestamptz,
    expires_at timestamptz,
    last_used_at timestamptz
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT s.id, u.id, u.role, u.status, u.display_name, u.locale,
           c.id, COALESCE(c.is_active, false),
           s.two_factor_verified_at, u.totp_enabled_at,
           s.expires_at, s.last_used_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN contributors c ON c.user_id = u.id
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.status = 'ACTIVE';
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_auth_create_session(
  p_user_id uuid, p_token_hash text, p_expires_at timestamptz,
  p_ip_hash text, p_user_agent text, p_two_factor_verified boolean
) RETURNS uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    INSERT INTO sessions (user_id, token_hash, expires_at, ip_hash, user_agent,
                          two_factor_verified_at)
    VALUES (p_user_id, p_token_hash, p_expires_at, p_ip_hash, p_user_agent,
            CASE WHEN p_two_factor_verified THEN now() ELSE NULL END)
    RETURNING id;
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_auth_touch_session(p_session_id uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE sessions SET last_used_at = now() WHERE id = p_session_id;
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_auth_mark_two_factor(p_session_id uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE sessions SET two_factor_verified_at = now() WHERE id = p_session_id;
  $$;
--> statement-breakpoint

-- Self-service password change. Scoped to the calling actor by construction:
-- the function ignores any user id the caller might supply.
CREATE OR REPLACE FUNCTION app_change_own_password(p_new_hash text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN
    IF app_actor_id() IS NULL THEN
      RAISE EXCEPTION 'No actor context' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE users SET password_hash = p_new_hash, updated_at = now()
     WHERE id = app_actor_id();
  END;
  $$;
--> statement-breakpoint

-- Revoking a session: the owner may revoke any, a user may revoke their own.
CREATE OR REPLACE FUNCTION app_revoke_sessions(p_user_id uuid, p_reason text)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE v_count integer;
  BEGIN
    IF NOT app_is_owner() AND app_actor_id() IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'Not permitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE sessions SET revoked_at = now(), revoked_reason = p_reason
     WHERE user_id = p_user_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
  END;
  $$;
--> statement-breakpoint

-- The application role may execute the trusted path, but owns none of it.
GRANT EXECUTE ON FUNCTION
  app_auth_lookup_user(text),
  app_auth_record_failure(uuid, integer, integer),
  app_auth_record_success(uuid),
  app_auth_resolve_session(text),
  app_auth_create_session(uuid, text, timestamptz, text, text, boolean),
  app_auth_touch_session(uuid),
  app_auth_mark_two_factor(uuid),
  app_change_own_password(text),
  app_revoke_sessions(uuid, text)
TO app_user;
