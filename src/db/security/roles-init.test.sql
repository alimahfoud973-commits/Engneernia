-- ---------------------------------------------------------------------------
-- What docker/postgres/init/01-roles.sql must leave behind (B6). Run by CI as a
-- superuser right after that file and BEFORE any password is set; every check
-- raises, so `psql -v ON_ERROR_STOP=1` fails the step.
--
--   1. Both roles exist and can log in.
--   2. Neither has an administrative attribute: SUPERUSER, CREATEDB,
--      CREATEROLE, REPLICATION or BYPASSRLS. app_user without BYPASSRLS is what
--      makes RLS a boundary; migrator needs none of them to own the schema.
--   3. Neither has a password. The shared init used to set published ones, and
--      every new database, production included, accepted them until rotated.
--
-- Reads pg_authid, which only a superuser can: the point is to see rolpassword.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
BEGIN
  IF (SELECT count(*) FROM pg_authid WHERE rolname IN ('migrator', 'app_user')) <> 2 THEN
    RAISE EXCEPTION 'roles-init: expected the roles migrator and app_user';
  END IF;

  FOR r IN
    SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
           rolpassword IS NOT NULL AS has_password
      FROM pg_authid
     WHERE rolname IN ('migrator', 'app_user')
  LOOP
    IF NOT r.rolcanlogin THEN
      RAISE EXCEPTION 'roles-init: % cannot log in', r.rolname;
    END IF;
    IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN
      RAISE EXCEPTION 'roles-init: % carries an administrative attribute', r.rolname;
    END IF;
    IF r.has_password THEN
      RAISE EXCEPTION 'roles-init: % has a password from the shared init file (B6)', r.rolname;
    END IF;
  END LOOP;
END
$$;

SELECT 'roles-init: migrator and app_user exist, can log in, carry no administrative attribute and no password' AS result;
