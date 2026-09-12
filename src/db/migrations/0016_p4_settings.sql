-- Only the settings table is new here.
--
-- Drizzle's generated diff also proposed re-applying everything from the
-- hand-written migrations 0012-0015 (the ARCHIVE enum value, the download
-- trail's detached keys, the search vector), because its snapshots do not
-- know about migrations written by hand. Those statements were removed: they
-- are already applied, and re-running ALTER TYPE ... ADD VALUE would abort
-- the whole migration.
CREATE TABLE IF NOT EXISTS "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description_ar" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
