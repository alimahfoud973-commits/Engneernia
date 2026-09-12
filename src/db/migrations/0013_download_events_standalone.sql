-- ---------------------------------------------------------------------------
-- The download trail must outlive what it describes.
--
-- A foreign key with ON DELETE CASCADE meant that deleting a product erased
-- the record of who had downloaded it — which is exactly the trail someone
-- would want gone. And the append-only trigger correctly refused the cascade,
-- so the two rules were in direct conflict.
--
-- Resolution: the download record stands ALONE. It keeps the file id as a
-- plain value with no referential action, and carries enough denormalised
-- context to stay meaningful after the file row is gone — the same shape the
-- audit log already uses for the same reason.
-- ---------------------------------------------------------------------------

ALTER TABLE "download_events"
  DROP CONSTRAINT IF EXISTS "download_events_product_file_id_product_files_id_fk";
--> statement-breakpoint

ALTER TABLE "download_events" ADD COLUMN IF NOT EXISTS "product_id" uuid;--> statement-breakpoint
ALTER TABLE "download_events" ADD COLUMN IF NOT EXISTS "product_slug" text;--> statement-breakpoint
ALTER TABLE "download_events" ADD COLUMN IF NOT EXISTS "filename" text;--> statement-breakpoint
ALTER TABLE "download_events" ADD COLUMN IF NOT EXISTS "storage_key" text;--> statement-breakpoint

-- The user reference may become null when an account is removed; the event
-- itself never disappears.
ALTER TABLE "download_events"
  DROP CONSTRAINT IF EXISTS "download_events_user_id_users_id_fk";
--> statement-breakpoint

ALTER TABLE "download_events"
  ADD CONSTRAINT "download_events_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "download_events_product_idx"
  ON "download_events" ("product_id", "created_at");
