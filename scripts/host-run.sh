#!/usr/bin/env bash
# =============================================================================
# RUN ONE OPERATIONS COMMAND ON THE PRODUCTION HOST  (B7)
# =============================================================================
#   bash scripts/host-run.sh npm run backup:hourly
#   bash scripts/host-run.sh npm run bootstrap:owner
#
# `scripts/` is not in the application image, on purpose: the backup, the
# restore drill and the RLS proof need a SUPERUSER connection, `psql` and
# `pg_dump`, and none of that belongs in a container that serves traffic. So
# these commands run here, on the host, from a checkout of the deployed commit,
# and reach PostgreSQL through B5 (127.0.0.1:5432). docs/DEPLOYMENT.md §٤-ج.
#
# What this wrapper adds is the environment, read from two files and executed
# from neither:
#
#   .env.host.local   host-only values (.env.host.example): the superuser and
#                     migrator URLs through 127.0.0.1. Must be mode 600: it
#                     holds the superuser password.
#   .env.production   ONLY its BACKUP_* keys, which live there by the owner's
#                     decision. Nothing else from it reaches the command: the
#                     application's own secrets are not this command's business,
#                     and its database URLs name `postgres`, a host that exists
#                     only inside the Docker network.
#
# The files are PARSED, never sourced. `. ./.env.production` would run part of
# a value such as `MAIL_FROM=Enginora <no-reply@…>` as a redirection.
#
# The superuser URL must NOT carry its password. backup.sh, restore-drill.sh and
# prove-rls.mjs pass it to pg_dump, pg_dumpall, pg_restore and psql as an
# ARGUMENT, and any local user can read a process's arguments (`ps`,
# /proc/<pid>/cmdline). The password lives in ~/.pgpass (or $PGPASSFILE),
# which libpq reads itself; this refuses the URL with a password in it, and a
# password file that is missing, not the caller's, or readable by others —
# libpq would silently ignore that last one and fail later, less clearly.
#
# It REFUSES to run when `.env.local` exists. Every script falls back to that
# file for any variable it is not given, and on a server it can only be a
# development file that wandered in — a quiet source of the wrong credentials.
#
# Values the operator exports (OWNER_USERNAME for bootstrap:owner, BACKUP_DIR)
# pass through untouched unless a file sets the same name; the files win.
# Nothing here prints a value.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST_FILE=.env.host.local
APP_FILE=.env.production

if [ "$#" -eq 0 ]; then
  echo "usage: bash scripts/host-run.sh <command> [args...]" >&2
  exit 2
fi

if [ -e .env.local ]; then
  echo "Refusing to run: .env.local exists in $ROOT." >&2
  echo "On the server it can only be a development file, and every script would fill its gaps from it." >&2
  exit 1
fi

if [ ! -f "$HOST_FILE" ]; then
  echo "Missing $ROOT/$HOST_FILE — copy .env.host.example, fill it in, chmod 600." >&2
  exit 1
fi

mode="$(stat -c '%a' "$HOST_FILE")"
if (( (8#$mode & 8#077) != 0 )); then
  echo "Refusing to run: $HOST_FILE is mode $mode; it holds the superuser password. chmod 600 $HOST_FILE" >&2
  exit 1
fi

# load FILE [PREFIX] — export KEY=VALUE lines; with PREFIX, only keys that start with it.
load() {
  local file="$1" prefix="${2:-}" line key value number=0
  while IFS= read -r line || [ -n "$line" ]; do
    number=$((number + 1))
    line="${line%$'\r'}"
    case "$line" in '' | '#'*) continue ;; esac
    if [[ ! "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      echo "$file:$number is not KEY=VALUE — refusing to guess what it means." >&2
      exit 1
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [ -n "$prefix" ] && [[ "$key" != "$prefix"* ]] && continue
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    export "$key=$value"
  done < "$file"
}

if [ -f "$APP_FILE" ]; then
  load "$APP_FILE" BACKUP_
fi
load "$HOST_FILE"

if [ -n "${DATABASE_SUPERUSER_URL:-}" ]; then
  if [[ "$DATABASE_SUPERUSER_URL" =~ ^[a-z]+://[^/@]*:[^/@]*@ ]] || [[ "$DATABASE_SUPERUSER_URL" =~ [?\&]password= ]]; then
    echo "Refusing to run: DATABASE_SUPERUSER_URL in $HOST_FILE carries a password." >&2
    echo "pg_dump and psql receive that URL as an argument, which every local user can read." >&2
    echo "Remove it from the URL and put it in ~/.pgpass (mode 600) — see .env.host.example." >&2
    exit 1
  fi
  pgpass="${PGPASSFILE:-$HOME/.pgpass}"
  if [ ! -f "$pgpass" ]; then
    echo "Missing $pgpass — the superuser password lives there, not in the URL. See .env.host.example." >&2
    exit 1
  fi
  if [ ! -O "$pgpass" ]; then
    echo "Refusing to run: $pgpass does not belong to the user running this command." >&2
    exit 1
  fi
  pgmode="$(stat -c '%a' "$pgpass")"
  if (( (8#$pgmode & 8#077) != 0 )); then
    echo "Refusing to run: $pgpass is mode $pgmode; libpq ignores it unless only its owner can read it. chmod 600 $pgpass" >&2
    exit 1
  fi
fi

exec "$@"
