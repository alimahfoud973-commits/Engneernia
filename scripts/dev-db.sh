#!/usr/bin/env bash
# Starts a local PostgreSQL for development when Docker is unavailable.
# Idempotent: safe to run whenever the database is not answering.
set -euo pipefail

PGDIR="${PGDIR:-/var/lib/postgresql/em_test}"
BIN="/usr/lib/postgresql/16/bin"

if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  echo "PostgreSQL is already running."
  exit 0
fi

if [ ! -d "$PGDIR/base" ]; then
  echo "Initialising a new cluster at $PGDIR"
  rm -rf "$PGDIR"; mkdir -p "$PGDIR"; chown postgres:postgres "$PGDIR"
  su postgres -c "$BIN/initdb -D $PGDIR -U postgres --auth=trust -E UTF8" >/dev/null
fi

su postgres -c "$BIN/pg_ctl -D $PGDIR -o '-p 5432 -c listen_addresses=localhost' -l $PGDIR/server.log start" >/dev/null
sleep 2
pg_isready -h localhost -p 5432

if ! psql -h localhost -U postgres -tAc \
     "SELECT 1 FROM pg_database WHERE datname='engineering_marketplace'" | grep -q 1; then
  echo "Creating database and roles"
  psql -h localhost -U postgres -q -c "CREATE DATABASE engineering_marketplace;"
  psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
    -f docker/postgres/init/01-roles.sql
  echo "Now run: npm run db:migrate && npm run seed:catalog"
fi
