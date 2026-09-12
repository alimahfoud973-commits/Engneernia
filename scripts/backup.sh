#!/usr/bin/env bash
# =============================================================================
# BACKUP
# =============================================================================
#   scripts/backup.sh [destination-directory]
#
# Takes three artefacts, not one, because restoring only the database would not
# restore this platform:
#
#   roles.sql     the cluster's roles. The entire authorisation model is
#                 Row-Level Security attached to `app_user` and `migrator`. A
#                 dump restored where those roles do not exist either fails
#                 outright or — worse — restores tables whose policies name a
#                 role that is not there.
#   database.dump the database itself, in PostgreSQL's custom format so a
#                 restore can be parallel and selective.
#   manifest.json what the books looked like AT THE MOMENT OF THE DUMP: the
#                 head of the ledger hash chain, the number of transactions,
#                 the balance per currency, the last migration applied.
#
# The manifest is the part that makes a restore drill meaningful. Without it a
# drill can only prove the restored database is INTERNALLY consistent — a
# freshly created empty one passes that. With it, the drill proves the restored
# ledger is THE SAME LEDGER: same chain head, same count, same balances.
#
# WHAT THIS DOES NOT BACK UP: the object store holding original files and
# previews. Those live in S3-compatible storage with its own replication, and
# copying them through this script would be both slow and wrong. The runbook
# covers them separately.
#
# Needs a superuser connection: `pg_dumpall --globals-only` reads the role
# catalogue, and the dump must carry every object's owner faithfully.
# =============================================================================
set -euo pipefail

DEST="${1:-${BACKUP_DIR:-./backups}}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"

if [ -f .env.local ] && [ -z "${DATABASE_SUPERUSER_URL:-}" ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env.local; set +a
fi

: "${DATABASE_SUPERUSER_URL:?DATABASE_SUPERUSER_URL must be set (a superuser connection)}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/$STAMP"
mkdir -p "$OUT"

echo "==> backing up to $OUT"

# --- 1. Roles ---------------------------------------------------------------
# --no-role-passwords keeps password hashes out of the backup file. They are
# not needed to restore the structure, and a backup is copied to more places
# than a database is.
pg_dumpall --dbname="$DATABASE_SUPERUSER_URL" --globals-only --no-role-passwords \
  > "$OUT/roles.sql"

# --- 2. The database --------------------------------------------------------
pg_dump --dbname="$DATABASE_SUPERUSER_URL" --format=custom --compress=9 \
  --file="$OUT/database.dump"

# --- 3. What the books said at this instant ---------------------------------
# Read AFTER the dump on purpose. If a transaction was posted between the two,
# the manifest records a chain head the dump does not contain, and the drill
# fails loudly — which is the correct outcome: a backup taken across a write is
# a backup nobody should trust silently. Take backups from a quiet moment, or
# from a replica.
psql "$DATABASE_SUPERUSER_URL" -At -X -v ON_ERROR_STOP=1 <<'SQL' > "$OUT/manifest.json"
SELECT json_build_object(
  'takenAt', now(),
  'postgresVersion', current_setting('server_version'),
  'database', current_database(),
  'ledger', json_build_object(
    'transactionCount', (SELECT count(*) FROM ledger_transactions),
    'headSeq', (SELECT max(seq) FROM ledger_transactions),
    'headEntryHash', (SELECT entry_hash FROM ledger_transactions
                       ORDER BY seq DESC LIMIT 1),
    'lineCount', (SELECT count(*) FROM ledger_lines),
    -- Aggregated directly rather than through app_ledger_balance_check(),
    -- which refuses anyone whose actor context is not the owner. A backup runs
    -- as a superuser, outside that model entirely; the drill calls the real
    -- function instead, which is where exercising it actually proves something.
    'balances', COALESCE((SELECT json_agg(b) FROM (
                            SELECT currency,
                                   SUM(amount_minor)::text AS "totalMinor",
                                   COUNT(*)::text          AS "lineCount"
                              FROM ledger_lines
                             GROUP BY currency
                             ORDER BY currency) b), '[]'::json)
  ),
  'settlementCount', (SELECT count(*) FROM settlements),
  'adjustmentCount', (SELECT count(*) FROM financial_adjustments),
  'orderCount', (SELECT count(*) FROM orders),
  'userCount', (SELECT count(*) FROM users),
  'lastMigration', (SELECT hash FROM drizzle.__drizzle_migrations
                     ORDER BY created_at DESC LIMIT 1),
  'migrationCount', (SELECT count(*) FROM drizzle.__drizzle_migrations),
  -- The security model is part of the backup, and has to be part of what the
  -- drill checks. A restore that brings back every row but drops a policy is
  -- a restore that has silently opened the books to everyone.
  'security', json_build_object(
    'policyCount', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
    'rlsEnabledTables', (SELECT count(*) FROM pg_class c
                           JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'public' AND c.relkind = 'r'
                            AND c.relrowsecurity),
    'securityDefinerFunctions', (SELECT count(*) FROM pg_proc p
                                   JOIN pg_namespace n ON n.oid = p.pronamespace
                                  WHERE n.nspname = 'public' AND p.prosecdef)
  )
)::text;
SQL

# --- 4. Checksums -----------------------------------------------------------
# So a corrupted copy is discovered before a restore is attempted, not during.
( cd "$OUT" && sha256sum roles.sql database.dump manifest.json > SHA256SUMS )

echo "==> artefacts"
ls -lh "$OUT" | sed 's/^/    /'
echo "==> ledger at backup time"
sed 's/^/    /' "$OUT/manifest.json" | head -c 800; echo

# --- 5. Retention -----------------------------------------------------------
if [ "$RETAIN_DAYS" -gt 0 ]; then
  find "$DEST" -maxdepth 1 -mindepth 1 -type d -mtime "+$RETAIN_DAYS" \
    -exec rm -rf {} + 2>/dev/null || true
fi

echo "==> done: $OUT"
