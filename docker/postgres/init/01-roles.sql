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
-- NO PASSWORDS HERE (B6). This file is shared by every environment: the
-- production and preview compose files mount it, CI and scripts/dev-db.sh run
-- it. A password written here was a password every new database accepted, and
-- it was published with the repository. The roles are created WITHOUT one, so
-- neither can sign in over the network (SCRAM refuses a role that has no
-- verifier) until a password is set:
--   production / preview : on the server, `\password migrator` and
--                          `\password app_user` in psql, then the same values
--                          in .env.production (docs/DEPLOYMENT.md §2);
--   CI                   : a fresh random pair per run (.github/workflows/ci.yml);
--   local development    : docker/postgres/dev/02-dev-role-passwords.sql, which
--                          only docker-compose.yml and the local scripts load.
-- A database that cannot be reached until someone sets its passwords fails
-- loudly; one that quietly accepts published passwords does not.
--
-- The attributes are spelled out although most are PostgreSQL's defaults: they
-- are the whole point of the two roles, and src/lib/config/db-roles.test.ts
-- fails if one of them is weakened.
--
-- This file runs once, on first container start (an empty data directory).
-- ---------------------------------------------------------------------------

CREATE ROLE migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE app_user WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

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
