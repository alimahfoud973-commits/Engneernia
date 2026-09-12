-- ---------------------------------------------------------------------------
-- Discipline slugs sit at the ROOT of the site (/electrical, /civil, ...),
-- which keeps the primary navigation short and good for search engines but
-- puts them in the same namespace as the application's own routes.
--
-- Next.js resolves static routes before dynamic ones, so /search would win
-- today even if a discipline were called "search" — the discipline would
-- simply become unreachable, silently. A CHECK constraint turns that from a
-- confusing outage into a rejected insert at the moment someone tries it.
-- ---------------------------------------------------------------------------

ALTER TABLE "disciplines"
  ADD CONSTRAINT "disciplines_slug_not_reserved"
  CHECK (
    slug !~ '^(api|search|products|contributors|admin|account|login|logout|register|checkout|cart|settings|notifications|_next|assets|static|favicon\.ico|robots\.txt|sitemap\.xml)$'
  );
--> statement-breakpoint

-- Slugs are URL segments: lowercase letters, digits and hyphens only.
ALTER TABLE "disciplines"
  ADD CONSTRAINT "disciplines_slug_format"
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
--> statement-breakpoint

ALTER TABLE "categories"
  ADD CONSTRAINT "categories_slug_format"
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
--> statement-breakpoint

ALTER TABLE "products"
  ADD CONSTRAINT "products_slug_format"
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
--> statement-breakpoint

-- Shares are basis points: 1..10000. The "totals exactly 100%" rule spans
-- rows and is enforced in application code before every write; this catches
-- an individually impossible value at the column.
ALTER TABLE "product_contributors"
  ADD CONSTRAINT "product_contributors_share_range"
  CHECK (share_bp > 0 AND share_bp <= 10000);
--> statement-breakpoint

-- Money is never negative, and a price row's window must be coherent.
ALTER TABLE "product_prices"
  ADD CONSTRAINT "product_prices_non_negative" CHECK (amount_minor >= 0);
--> statement-breakpoint

ALTER TABLE "product_prices"
  ADD CONSTRAINT "product_prices_window_ordered"
  CHECK (effective_to IS NULL OR effective_to >= effective_from);
--> statement-breakpoint

ALTER TABLE "product_prices"
  ADD CONSTRAINT "product_prices_currency_format" CHECK (currency ~ '^[A-Z]{3}$');
