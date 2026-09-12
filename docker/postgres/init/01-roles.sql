-- ---------------------------------------------------------------------------
-- Role separation is the foundation of the authorization model (report §F).
--
--   migrator  : owns the schema, runs migrations, may define RLS policies.
--   app_user  : what the running application connects as. It is NOT a
--               superuser and does NOT have BYPASSRLS, so Row-Level Security
--               applies to it unconditionally. If application code ever
--               forgets a `WHERE contributor_id = ...`, the database still
--               refuses to return another contributor's rows.
--
-- This file runs once, on first container start.
-- ---------------------------------------------------------------------------

CREATE ROLE migrator WITH LOGIN PASSWORD 'migrator_password';
CREATE ROLE app_user WITH LOGIN PASSWORD 'app_password' NOBYPASSRLS;

GRANT ALL PRIVILEGES ON DATABASE engineering_marketplace TO migrator;

\connect engineering_marketplace

-- The public schema belongs to migrator; app_user may use it but not alter it.
ALTER SCHEMA public OWNER TO migrator;
GRANT USAGE ON SCHEMA public TO app_user;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM app_user;

-- Whatever migrator creates from now on, app_user gets data access to —
-- and only data access. No DDL, ever.
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- Extensions used by the schema.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
