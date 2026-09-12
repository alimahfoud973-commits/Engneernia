-- Specification §33: notifications are addressed, never broadcast.
-- A user reads their own and no one else's. Only the owner may create one,
-- and the producers that do so always resolve a single recipient first.
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "notifications_select" ON "notifications" FOR SELECT
  USING (app_is_owner() OR "user_id" = app_actor_id());
--> statement-breakpoint

-- Marking one's own notification as read is the only write a recipient makes.
CREATE POLICY "notifications_update_own" ON "notifications" FOR UPDATE
  USING (app_is_owner() OR "user_id" = app_actor_id())
  WITH CHECK (app_is_owner() OR "user_id" = app_actor_id());
--> statement-breakpoint

CREATE POLICY "notifications_insert" ON "notifications" FOR INSERT
  WITH CHECK (app_is_owner());
--> statement-breakpoint

CREATE POLICY "notifications_delete" ON "notifications" FOR DELETE USING (app_is_owner());
