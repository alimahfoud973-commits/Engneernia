#!/usr/bin/env bash
# =============================================================================
# THE HOURLY BACKUP  (owner decision on OPEN-10: RPO = 1 hour)
# =============================================================================
#   npm run backup:hourly
#
# One command for cron, because a backup policy split across three crontab
# lines is a backup policy where one of them silently stops.
#
#   1. take the backup            (scripts/backup.sh)
#   2. ship it, encrypted         (scripts/backup-ship.ts)
#   3. record that it happened    (last-success, read by step 4)
#   4. say so if the restore drill is overdue
#
# RPO = 1 HOUR, MEANT LITERALLY. A full dump every hour, not continuous WAL
# archiving. At this catalogue's size a dump is small and a restore is one
# command, and the owner asked for an hour — not for minutes. If that ever has
# to drop below an hour, the answer is WAL archiving on the database host, and
# it is a different design with a different restore procedure; §7 of
# docs/BACKUP-AND-RESTORE.md says what changes.
#
# EXITS NON-ZERO ON ANY FAILURE, so cron mails the operator. A backup job that
# fails quietly is worse than no backup job: it produces the belief that
# backups exist.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEST="${BACKUP_DIR:-./backups}"
# Local copies are a staging area, not the archive: the archive is the bucket,
# and it is what survives losing this machine. Two are kept so that a failed
# ship still leaves yesterday's on disk.
LOCAL_KEEP="${BACKUP_LOCAL_KEEP:-2}"
DRILL_DUE_DAYS="${BACKUP_DRILL_DUE_DAYS:-30}"
STATE="$DEST/.state"

mkdir -p "$STATE"

echo "==> [$(date -u +%Y-%m-%dT%H:%M:%SZ)] hourly backup starting"

# --- 1 & 2 ------------------------------------------------------------------
BACKUP_RETAIN_DAYS=0 bash scripts/backup.sh "$DEST"

NEWEST="$(find "$DEST" -maxdepth 1 -mindepth 1 -type d -not -name '.*' | sort | tail -1)"
if [ -z "$NEWEST" ]; then
  echo "No backup directory was produced. Refusing to report success." >&2
  exit 1
fi

node --experimental-strip-types scripts/backup-ship.ts "$NEWEST"

# --- 3 ----------------------------------------------------------------------
# Written only after the ship succeeded. This file is what makes "the backups
# stopped three weeks ago" visible instead of assumed.
date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE/last-success"
basename "$NEWEST" > "$STATE/last-shipped"

# --- local staging retention -------------------------------------------------
# Local only. NOTHING here touches the bucket: deleting site data must never
# delete its history, so remote retention is the provider's object-lock and
# lifecycle rules, set by the owner where this script cannot reach them.
COUNT="$(find "$DEST" -maxdepth 1 -mindepth 1 -type d -not -name '.*' | wc -l)"
if [ "$COUNT" -gt "$LOCAL_KEEP" ]; then
  find "$DEST" -maxdepth 1 -mindepth 1 -type d -not -name '.*' \
    | sort | head -n "-$LOCAL_KEEP" | while read -r old; do
        echo "    pruning local staging copy $(basename "$old")"
        rm -rf "$old"
      done
fi

# --- 4 ----------------------------------------------------------------------
if [ -f "$STATE/last-drill" ]; then
  LAST_DRILL_EPOCH="$(date -u -d "$(cat "$STATE/last-drill")" +%s 2>/dev/null || echo 0)"
  AGE_DAYS=$(( ( $(date -u +%s) - LAST_DRILL_EPOCH ) / 86400 ))
  if [ "$AGE_DAYS" -gt "$DRILL_DUE_DAYS" ]; then
    echo "!!  The last restore drill was $AGE_DAYS days ago (due every $DRILL_DUE_DAYS)." >&2
    echo "!!  A backup nobody has restored is a backup nobody knows about." >&2
    echo "!!    npm run backup:fetch -- \$(cat $STATE/last-shipped)" >&2
    echo "!!    npm run restore-drill -- ./restored/\$(cat $STATE/last-shipped)" >&2
  fi
else
  echo "!!  No restore drill has ever been recorded. Run one before the first sale." >&2
fi

echo "==> done. shipped $(basename "$NEWEST")"
