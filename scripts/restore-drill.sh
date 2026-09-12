#!/usr/bin/env bash
# =============================================================================
# RESTORE DRILL
# =============================================================================
#   scripts/restore-drill.sh [backup-directory]
#
# A backup nobody has restored is a hypothesis. This restores one into a
# scratch database and then asks it the questions that matter.
#
# THE CHECKS ARE IN TWO GROUPS, AND BOTH ARE NECESSARY.
#
#   IDENTITY — is this the same ledger? Every count and the head of the hash
#   chain are compared against the manifest written when the dump was taken.
#   Without this the drill is nearly worthless: an EMPTY database passes every
#   consistency check there is.
#
#   INTEGRITY — are the restored books sound? The chain is re-verified from the
#   first entry, every line is re-summed, and the security model is counted.
#   These are asked of the RESTORED database using its own SECURITY DEFINER
#   functions, so a restore that lost a function or a policy fails here.
#
# The scratch database is dropped at the end. Set KEEP=1 to inspect it.
# =============================================================================
set -euo pipefail

if [ -f .env.local ] && [ -z "${DATABASE_SUPERUSER_URL:-}" ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env.local; set +a
fi
: "${DATABASE_SUPERUSER_URL:?DATABASE_SUPERUSER_URL must be set (a superuser connection)}"

BACKUP_ROOT="${BACKUP_DIR:-./backups}"
SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC="$(find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d | sort | tail -1)"
fi
[ -d "$SRC" ] || { echo "No backup directory found (looked in $BACKUP_ROOT)"; exit 2; }

SCRATCH="restore_drill_$(date -u +%Y%m%d%H%M%S)_$$"
# The maintenance connection: same server, but the `postgres` database, so the
# scratch database can be created and dropped.
ADMIN_URL="${DATABASE_SUPERUSER_URL%/*}/postgres"
SCRATCH_URL="${DATABASE_SUPERUSER_URL%/*}/$SCRATCH"

failures=0
check() {
  local ok="$1" label="$2" detail="${3:-}"
  if [ "$ok" = "1" ]; then
    printf '  PASS  %s%s\n' "$label" "${detail:+  — $detail}"
  else
    printf '  FAIL  %s%s\n' "$label" "${detail:+  — $detail}"
    failures=$((failures + 1))
  fi
}

expect_equal() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    check 1 "$label" "$actual"
  else
    check 0 "$label" "expected $expected, restored $actual"
  fi
}

# Reads one scalar out of the restored database.
q() { psql "$SCRATCH_URL" -At -X -v ON_ERROR_STOP=1 -c "$1"; }

# Reads one value out of the manifest. Deliberately not jq: this script must
# run on a bare production host without extra packages installed.
m() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));
exec('v=d'+''.join('[%r]'%k for k in sys.argv[2].split('.')));print(v)" \
  "$SRC/manifest.json" "$1"; }

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo; echo "Scratch database kept: $SCRATCH"
    return
  fi
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> drilling $SRC"

# --- 1. The artefacts are intact --------------------------------------------
echo
echo "1. THE BACKUP ITSELF"
if ( cd "$SRC" && sha256sum --quiet --check SHA256SUMS ) 2>/dev/null; then
  check 1 "every artefact matches its checksum"
else
  check 0 "every artefact matches its checksum" "a file is missing or corrupted"
fi
[ -s "$SRC/database.dump" ] && check 1 "the dump is not empty" || check 0 "the dump is not empty"
[ -s "$SRC/roles.sql" ] && check 1 "the roles file is not empty" || check 0 "the roles file is not empty"

# --- 2. Restore -------------------------------------------------------------
echo
echo "2. RESTORE"
# Roles are cluster-wide, so on a real recovery host they do not exist yet and
# this creates them; on a host that already has them every statement fails
# harmlessly. Either way what matters is the assertion that follows, not the
# exit status of this line.
psql "$ADMIN_URL" -q -f "$SRC/roles.sql" >/dev/null 2>&1 || true

for role in app_user migrator; do
  present="$(psql "$ADMIN_URL" -At -c "SELECT count(*) FROM pg_roles WHERE rolname='$role'")"
  expect_equal "the role $role exists after restoring globals" "1" "$present"
done

bypass="$(psql "$ADMIN_URL" -At -c "SELECT rolbypassrls FROM pg_roles WHERE rolname='app_user'")"
expect_equal "app_user still cannot bypass RLS" "f" "$bypass"

psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$SCRATCH\";"
# --exit-on-error would abort on the first missing role grant; the drill wants
# the whole restore attempted and then judged on its results.
restore_log="$(mktemp)"
pg_restore --dbname="$SCRATCH_URL" --no-owner --no-privileges --jobs=2 \
  "$SRC/database.dump" > "$restore_log" 2>&1 || true
errors="$(grep -c '^pg_restore: error' "$restore_log" || true)"
expect_equal "pg_restore reported no errors" "0" "$errors"
[ "$errors" = "0" ] || sed 's/^/      /' "$restore_log" | head -20
rm -f "$restore_log"

# --- 3. Identity: is this the same ledger? ----------------------------------
echo
echo "3. IDENTITY — the same books, not merely consistent ones"
expect_equal "migrations applied"      "$(m migrationCount)"          "$(q 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
expect_equal "last migration hash"     "$(m lastMigration)"           "$(q 'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1')"
expect_equal "ledger transactions"     "$(m ledger.transactionCount)" "$(q 'SELECT count(*) FROM ledger_transactions')"
expect_equal "ledger lines"            "$(m ledger.lineCount)"        "$(q 'SELECT count(*) FROM ledger_lines')"
expect_equal "hash-chain head sequence" "$(m ledger.headSeq)"         "$(q 'SELECT max(seq) FROM ledger_transactions')"
# The strongest single assertion in this script. The head hash commits to every
# entry before it, so matching it means no transaction was lost, added or
# altered anywhere in the chain.
expect_equal "hash-chain head entry hash" "$(m ledger.headEntryHash)" "$(q 'SELECT entry_hash FROM ledger_transactions ORDER BY seq DESC LIMIT 1')"
expect_equal "settlements"             "$(m settlementCount)"         "$(q 'SELECT count(*) FROM settlements')"
expect_equal "adjustments"             "$(m adjustmentCount)"         "$(q 'SELECT count(*) FROM financial_adjustments')"
expect_equal "orders"                  "$(m orderCount)"              "$(q 'SELECT count(*) FROM orders')"
expect_equal "users"                   "$(m userCount)"               "$(q 'SELECT count(*) FROM users')"

# --- 4. Integrity: are the restored books sound? ----------------------------
echo
echo "4. INTEGRITY — asked of the restored database, by its own functions"
# These two are owner-only, which is correct for an application caller. The
# drill is not an application caller; it announces the owner role for the
# session so the RESTORED functions run — which is itself a check that they
# survived the restore.
problems="$(psql "$SCRATCH_URL" -At -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT set_config('app.actor_role', 'OWNER', false);
SELECT count(*) FROM app_verify_ledger_chain();
SQL
)"
problems="$(printf '%s\n' "$problems" | tail -1)"
expect_equal "the hash chain re-verifies from the first entry" "0" "$problems"

unbalanced="$(psql "$SCRATCH_URL" -At -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT set_config('app.actor_role', 'OWNER', false);
SELECT count(*) FROM app_ledger_balance_check() WHERE total_minor <> 0;
SQL
)"
unbalanced="$(printf '%s\n' "$unbalanced" | tail -1)"
expect_equal "every currency still sums to zero" "0" "$unbalanced"

# --- 5. The security model came back too ------------------------------------
echo
echo "5. THE SECURITY MODEL"
expect_equal "row-level security policies" "$(m security.policyCount)"              "$(q "SELECT count(*) FROM pg_policies WHERE schemaname='public'")"
expect_equal "tables with RLS enabled"     "$(m security.rlsEnabledTables)"         "$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity")"
expect_equal "SECURITY DEFINER functions"  "$(m security.securityDefinerFunctions)" "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef")"

echo
if [ "$failures" -eq 0 ]; then
  echo "DRILL PASSED — this backup restores to the same, sound books."
else
  echo "DRILL FAILED — $failures check(s). Do not rely on this backup."
fi
exit "$failures"
