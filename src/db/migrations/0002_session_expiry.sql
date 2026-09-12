-- ---------------------------------------------------------------------------
-- Separates two things that look alike but are not:
--
--   REVOCATION is a decision — a user logs out, the owner disables an account.
--   It must be authorised, and app_revoke_sessions() checks the actor.
--
--   EXPIRY is bookkeeping — a session went idle past its timeout. It happens
--   during session resolution, BEFORE any actor context exists, so an actor
--   check there would be checking an actor that has not been established yet.
--
-- Expiry is safe without an actor check because it only ever narrows access,
-- and the caller already proved possession of the session by resolving it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_expire_session(p_session_id uuid, p_reason text)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE sessions
       SET revoked_at = now(), revoked_reason = p_reason
     WHERE id = p_session_id AND revoked_at IS NULL;
  $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_expire_session(uuid, text) TO app_user;
