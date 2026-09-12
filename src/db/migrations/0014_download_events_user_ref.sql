-- ---------------------------------------------------------------------------
-- The same conflict, one level up: ON DELETE SET NULL performs an UPDATE, and
-- the download trail is append-only, so deleting a user was refused too.
--
-- The reference to the user therefore becomes a plain value, exactly as
-- audit_logs.actor_user_id already is.
--
-- This also lands in a defensible place for privacy: deleting an account
-- removes the person's identity, while the trail keeps a pseudonymous id that
-- no longer resolves to a name or an email. Forensics survives; the identity
-- does not.
-- ---------------------------------------------------------------------------

ALTER TABLE "download_events"
  DROP CONSTRAINT IF EXISTS "download_events_user_id_users_id_fk";
