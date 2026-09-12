-- ---------------------------------------------------------------------------
-- FORCE ROW LEVEL SECURITY applies the policies to the table's OWNER as well.
-- That is valuable on tables nothing trusted needs to read across rows — but
-- product_contributors is read by app_public_product_authors(), a narrow
-- SECURITY DEFINER function that exists precisely to expose author NAMES
-- while never exposing share_bp.
--
-- With FORCE on, that function returns nothing and the public product page
-- loses its author line (specification §28). Dropping FORCE restores it
-- WITHOUT weakening anything that matters: the application connects as
-- app_user, which is not the table owner and therefore remains fully subject
-- to the policies. Only `migrator` — used for migrations and for the audited
-- definer functions — is exempt.
--
-- This mirrors the same decision already taken for `contributors` in 0001.
-- ---------------------------------------------------------------------------

ALTER TABLE "product_contributors" NO FORCE ROW LEVEL SECURITY;
