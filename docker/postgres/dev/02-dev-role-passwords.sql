-- ---------------------------------------------------------------------------
-- LOCAL DEVELOPMENT ONLY. Never mounted by docker-compose.prod.yml or the
-- preview overlay; src/lib/config/db-roles.test.ts fails if either does.
--
-- docker/postgres/init/01-roles.sql creates migrator and app_user without a
-- password, for every environment (B6). On a developer's machine they need the
-- fixed values .env.example already carries, so that `docker compose up -d
-- postgres` followed by `cp .env.example .env.local` works with nothing to edit.
--
-- These values are public. That is acceptable ONLY because the cluster that
-- runs this file publishes 5432 on 127.0.0.1 alone (docker-compose.yml) and
-- holds nothing but development data. Loaded by docker-compose.yml, by
-- scripts/dev-db.sh and by the integration-test container of
-- docs/RUN-LOCALLY.md section 10.
--
-- Runs once, after 01-roles.sql, on an empty data directory only.
-- ---------------------------------------------------------------------------

ALTER ROLE migrator WITH PASSWORD 'migrator_password';
ALTER ROLE app_user WITH PASSWORD 'app_password';
