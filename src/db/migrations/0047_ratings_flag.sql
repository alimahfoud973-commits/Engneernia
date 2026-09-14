-- ============================================================================
-- THE RATINGS FLAG (OPEN-14)
-- ============================================================================
-- Off. A flag is a row, not a constant, so turning ratings on later is an
-- UPDATE rather than an edit and a deploy.
--
-- `is_public` matters: the storefront reads settings as a GUEST, and
-- `settings_select` admits only the owner or a public row. A private flag would
-- be invisible to the very page it governs, and the feature would look broken
-- rather than disabled.
-- ============================================================================

-- FORCE ROW LEVEL SECURITY applies to the table owner too, so a migration with
-- no actor context is refused — correctly, and silently enough that the first
-- three attempts here looked like a broken migration tool rather than a policy
-- doing its job. Declare what this seed is, exactly as 0028 does.
SELECT set_config('app.actor_role', 'OWNER', true);
--> statement-breakpoint

INSERT INTO settings (key, value, description_ar, is_public) VALUES
  ('catalog.ratingsEnabled', 'false'::jsonb, 'إظهار متوسط التقييم وقبول تقييم جديد (OPEN-14)', true);
