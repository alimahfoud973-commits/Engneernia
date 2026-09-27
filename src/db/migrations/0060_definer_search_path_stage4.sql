-- ===========================================================================
-- PIN pg_temp INTO THE SEARCH PATH OF THE STAGE 4 DEFINER FUNCTIONS (S4-08)
--
-- These SECURITY DEFINER functions set `search_path = public` only. PostgreSQL
-- then still resolves table names in the caller's temporary schema FIRST, so a
-- caller able to create a temporary table named like one of ours could make a
-- definer function read or write that table instead — the Stage 4 audit proved
-- it on app_record_entitlement_download (a temp `entitlements` was updated).
-- CLAUDE.md requires `SET search_path = public, pg_temp`: listing pg_temp LAST
-- is what stops the shadowing.
--
-- Behaviour is unchanged: only the resolution order of the path moves. The
-- authentication functions with the same defect are outside Stage 4 and are
-- deliberately left to their own change.
-- ===========================================================================

ALTER FUNCTION app_record_entitlement_download(uuid) SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION app_set_product_price(uuid, bigint, text, uuid, text) SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION app_submit_product_for_review(uuid) SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION app_public_product_authors(uuid) SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION app_public_contributor_product_count(text) SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION app_public_contributor_products(text) SET search_path = public, pg_temp;
