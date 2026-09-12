-- ===========================================================================
-- FULL-TEXT SEARCH (specification §30)
-- ===========================================================================
-- §30 requires search to work at the scale of "hundreds or thousands of
-- products". A LIKE '%...%' scan cannot use an index and degrades linearly,
-- so the searchable text is materialised into a tsvector column and indexed.
--
-- The config is cast to regconfig deliberately: to_tsvector(text, text) is
-- only STABLE, which a generated column rejects, while the regconfig overload
-- is IMMUTABLE.
--
-- The 'arabic' configuration is used because PostgreSQL ships an Arabic
-- stemmer: it resolves الكهربائية and الكهربائي to the same root, so a search
-- for one finds the other. Without stemming, Arabic search is nearly useless —
-- every inflection would be a separate term.
--
-- Weights carry relevance: a match in the TITLE outranks one in the body.
--   A = title, B = subtitle, C = description
--
-- Software tags are deliberately NOT in this vector: array_to_string is only
-- STABLE, which a generated column rejects. They do not need to be here
-- either — software is a FACET, answered by the GIN index on the array below,
-- not a free-text term.
-- ===========================================================================

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('arabic'::regconfig, coalesce(title_ar, '')), 'A') ||
    setweight(to_tsvector('arabic'::regconfig, coalesce(title_en, '')), 'A') ||
    setweight(to_tsvector('arabic'::regconfig, coalesce(subtitle_ar, '')), 'B') ||
    setweight(to_tsvector('arabic'::regconfig, coalesce(description_ar, '')), 'C')
  ) STORED;
--> statement-breakpoint

-- GIN is the right index for tsvector: fast lookup, slower writes, and this
-- catalogue is read far more than it is written.
CREATE INDEX IF NOT EXISTS "products_search_idx" ON "products" USING GIN ("search_vector");
--> statement-breakpoint

-- Trigram index for partial-word matching, which stemming alone does not
-- give: typing "كهرب" should still surface "كهربائية" before the user has
-- finished the word.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_title_trgm_idx"
  ON "products" USING GIN ("title_ar" gin_trgm_ops);
--> statement-breakpoint

-- Facet indexes (§30): every filter the search page offers is indexed, and
-- each is partial on PUBLISHED because the public never filters over anything
-- else — a smaller index that answers the only question actually asked.
CREATE INDEX IF NOT EXISTS "products_facet_filetype_idx"
  ON "products" ("file_type") WHERE status = 'PUBLISHED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_facet_level_idx"
  ON "products" ("level") WHERE status = 'PUBLISHED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_facet_free_idx"
  ON "products" ("is_free") WHERE status = 'PUBLISHED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_software_tags_idx"
  ON "products" USING GIN ("software_tags");
--> statement-breakpoint

-- Best sellers and new releases are ordered reads over published rows only.
CREATE INDEX IF NOT EXISTS "products_bestsellers_idx"
  ON "products" ("sales_count" DESC, "published_at" DESC) WHERE status = 'PUBLISHED';
