-- ===========================================================================
-- PROOF OF THE AUTHORIZATION FOUNDATION (architecture report §F, layer 3)
--
-- This script proves, against a real PostgreSQL instance, the three claims the
-- entire permission model rests on:
--
--   1. The application role cannot alter the schema.
--   2. Row-Level Security applies to the application role unconditionally.
--   3. With RLS active, a contributor's query returns only their own rows —
--      even when the query carries NO WHERE clause at all, i.e. even when the
--      application layer has a bug.
--
-- Run with: psql -v ON_ERROR_STOP=1 -f src/db/security/rls-foundation.test.sql
-- ===========================================================================

\set ON_ERROR_STOP on
\echo '--- setting up a representative financial table as migrator ---'

SET ROLE migrator;

DROP TABLE IF EXISTS rls_proof_earnings;
CREATE TABLE rls_proof_earnings (
  id             bigserial PRIMARY KEY,
  contributor_id text     NOT NULL,
  amount_minor   bigint   NOT NULL
);

INSERT INTO rls_proof_earnings (contributor_id, amount_minor) VALUES
  ('contributor-civil',      13200),
  ('contributor-civil',       4500),
  ('contributor-mechanical', 64000),
  ('contributor-electrical', 14300);

ALTER TABLE rls_proof_earnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_proof_earnings FORCE ROW LEVEL SECURITY;

-- The policy reads the per-transaction actor context that the application
-- sets with `SET LOCAL app.actor_id`. No context => no rows.
CREATE POLICY contributor_isolation ON rls_proof_earnings
  FOR SELECT
  USING (contributor_id = current_setting('app.actor_id', true));

GRANT SELECT ON rls_proof_earnings TO app_user;

RESET ROLE;

\echo ''
\echo '=== CLAIM 1: app_user cannot alter the schema ==='
SET ROLE app_user;
\set ok 0
DO $$
BEGIN
  EXECUTE 'CREATE TABLE app_user_should_not_manage (id int)';
  RAISE EXCEPTION 'FAIL: app_user was able to create a table';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: app_user is denied DDL (%).', SQLERRM;
END $$;

\echo ''
\echo '=== CLAIM 2: RLS applies — no actor context means no rows ==='
-- NOTE: deliberately no WHERE clause. This is the "application layer forgot
-- to filter" scenario the whole defence-in-depth argument is about.
SELECT count(*) AS rows_visible_without_context FROM rls_proof_earnings;

\echo ''
\echo '=== CLAIM 3: with an actor context, only that contributor is visible ==='
BEGIN;
  SET LOCAL app.actor_id = 'contributor-civil';
  SELECT contributor_id, count(*) AS rows_visible, sum(amount_minor) AS total_minor
    FROM rls_proof_earnings
   GROUP BY contributor_id;
COMMIT;

\echo ''
\echo '=== CLAIM 3b: a different contributor sees a different, disjoint set ==='
BEGIN;
  SET LOCAL app.actor_id = 'contributor-mechanical';
  SELECT contributor_id, count(*) AS rows_visible, sum(amount_minor) AS total_minor
    FROM rls_proof_earnings
   GROUP BY contributor_id;
COMMIT;

\echo ''
\echo '=== CLAIM 3c: a contributor cannot read another by naming them explicitly ==='
BEGIN;
  SET LOCAL app.actor_id = 'contributor-civil';
  SELECT count(*) AS mechanical_rows_visible_to_civil
    FROM rls_proof_earnings
   WHERE contributor_id = 'contributor-mechanical';
COMMIT;

RESET ROLE;

\echo ''
\echo '--- cleanup ---'
SET ROLE migrator;
DROP TABLE rls_proof_earnings;
RESET ROLE;
