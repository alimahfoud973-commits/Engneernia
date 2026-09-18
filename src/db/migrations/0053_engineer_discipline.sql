-- ===========================================================================
-- 0053 — AN ENGINEER'S DISCIPLINE IS THE DISCIPLINE TABLE, NOT A SECOND LIST
-- ===========================================================================
--
-- The owner's requirement is "تحديد تخصص المهندس (كهرباء/ميكانيك/مدني/عمارة)".
-- Those four are already rows in `disciplines` — the same four the catalogue
-- files every product under, seeded in migration 0002 and read by the public
-- browse pages, the revenue-by-discipline report and the sitemap.
--
-- So this is a foreign key, not a new enum and not a fifth spelling of the
-- same four words. Two lists of disciplines drift the day somebody renames one
-- of them, and then "الهندسة المدنية" on a product page and "مدني" on an
-- engineer page are, to every query in the system, different things.
--
-- `specialization` STAYS, and is not touched. It is free text for the narrower
-- line an engineer actually works in — "تمديدات صحية", "أنظمة إنذار" — which
-- is a different question from which of the four disciplines they belong to.
-- Dropping it would delete what the seeded profiles already say.
--
-- NULLABLE, because every contributor that exists predates this column and a
-- default would be an invented fact about a real person. The admin screen
-- shows «غير محدّد» and the owner sets it.
-- ===========================================================================

ALTER TABLE "contributors"
  ADD COLUMN IF NOT EXISTS "discipline_id" uuid
  REFERENCES "disciplines"("id") ON DELETE SET NULL;
--> statement-breakpoint

COMMENT ON COLUMN "contributors"."discipline_id" IS
  'Which of the platform''s four disciplines this engineer belongs to. NULL until the owner sets it.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "contributors_discipline_idx"
  ON "contributors" ("discipline_id");
