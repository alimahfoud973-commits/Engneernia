-- ============================================================================
-- THE SECOND-FACTOR CHALLENGE NEEDS A TRUSTED LOOKUP BY ID
-- ============================================================================
-- `verifyLoginTotp` resolved the account like this:
--
--     SELECT * FROM app_auth_lookup_user(
--       (SELECT email FROM users WHERE id = $1)
--     )
--
-- The inner SELECT is an ordinary query on `users`, and it ran on a connection
-- with NO actor context. `app_actor_id()` is empty there, `users_select` admits
-- nothing, the subquery yielded NULL, and the trusted function was handed NULL
-- — so the whole thing answered FALSE for every code ever submitted. The second
-- factor could not be passed at all. Nothing caught it: there was no screen
-- that reached this code, and no test called it.
--
-- Nor can the caller simply read the address itself. A session that has not yet
-- answered its factor is announced to PostgreSQL as a GUEST (see
-- `actorDatabaseContext`), which is the point of that rule — so it cannot read
-- its own row either, and passing the email in from the action fails for the
-- same reason one layer up.
--
-- Hence a trusted lookup by id, mirroring the one by email exactly. It returns
-- the same columns and is reached the same way: this is the login path, where
-- the caller is by definition not yet anybody.
-- ============================================================================

CREATE OR REPLACE FUNCTION app_auth_lookup_user_by_id(p_user_id uuid)
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
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.id, u.password_hash, u.role, u.status, u.display_name,
           u.locked_until, u.failed_login_count,
           u.totp_secret_encrypted, u.totp_enabled_at
      FROM users u
     WHERE u.id = p_user_id;
  $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_auth_lookup_user_by_id(uuid) TO app_user;
