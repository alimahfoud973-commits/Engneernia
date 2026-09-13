-- ===========================================================================
-- THE PLATFORM HAS A NAME (owner decision on OPEN-8)
--
--   Name:    Enginora  /  إنجينورا
--   Domain:  enginora.com
--
-- 0017 seeded `platform.name` as "Engineernia", taken from the repository the
-- owner had created and marked explicitly as awaiting confirmation. The answer
-- is a different name, so the rows are updated here rather than in 0017: an
-- applied migration is never edited, because Drizzle stores each file's
-- checksum and a later edit leaves every database that already ran it quietly
-- different from the file claiming to describe it.
--
-- UPDATE, NOT INSERT ... ON CONFLICT DO NOTHING. The 0017 rows exist on every
-- deployment, so an insert would do nothing at all and the platform would keep
-- the placeholder name while the migration reported success.
--
-- The name still lives in `settings`, not in code: changing it again is this
-- one row, not a deploy.
-- ===========================================================================

-- `settings` carries FORCE ROW LEVEL SECURITY, so the policies apply to the
-- table owner too and a migration with no actor context is refused. Declaring
-- owner context is what 0017 does for the same reason.
SELECT set_config('app.actor_role', 'OWNER', true);--> statement-breakpoint

UPDATE settings SET value = '"Enginora"'::jsonb, updated_at = now()
 WHERE key = 'platform.name';--> statement-breakpoint

UPDATE settings SET value = '"إنجينورا"'::jsonb, updated_at = now()
 WHERE key = 'platform.nameAr';
