#!/usr/bin/env bash
# =============================================================================
# OPERATIONAL SMOKE TEST OF THE PRODUCTION IMAGE  (B8)
# =============================================================================
#   docker build -t enginora-app:test .
#   bash scripts/image-smoke.sh enginora-app:test arm64     # or amd64
#
# Building is not the test. An image can build and still fail the moment it
# runs: a native addon without a binary for this CPU, a migration tool missing
# from the runtime stage, a health check that never passes, a font that is
# not where the settlement statement looks. So this RUNS the image the way
# docker-compose.prod.yml does, against a throwaway PostgreSQL 16 initialised
# by the same docker/postgres/init, and checks what the platform needs:
#
#   1. the image is for the expected CPU, and so is the node inside it;
#   2. it runs as `nextjs`, holds the fonts, and no env file, key or backup;
#   3. the native addons load and work on this CPU (canvas draws Arabic with
#      the bundled font, argon2 hashes and verifies, mupdf opens);
#   4. `npm run db:migrate` from the image applies every migration in the
#      journal, as `migrator`, and a second run changes nothing;
#   5. the application boots as `app_user`, /api/health answers 200, the
#      image's own HEALTHCHECK reports healthy, pages answer 200 with a CSP
#      nonce, an unknown path answers 404;
#   6. it fails the way it should: the database stopped -> 503, and back
#      when it returns; filesystem storage in production -> refuses to start;
#   7. no generated secret appears in any container's output.
#
# Everything it creates is named smoke-<random>-* and removed on exit, by
# name. It touches nothing else: no prune, no other container, no volume
# but the anonymous one of its own database. Values are random per run and
# never printed; containers receive them by NAME (`-e VAR`), so no secret is
# ever in a process's arguments.
#
# Not covered here: S3 (R2), ClamAV and SMTP. The application boots without
# reaching any of them, by design — storage and mail are used per request,
# and an unreachable scanner fails closed. Those are tested where they exist.
# =============================================================================
set -euo pipefail

IMAGE="${1:-}"
ARCH="${2:-}"
if [ -z "$IMAGE" ] || { [ "$ARCH" != amd64 ] && [ "$ARCH" != arm64 ]; }; then
  echo "usage: bash scripts/image-smoke.sh <image> <amd64|arm64>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "No image $IMAGE on this Docker host — build it first." >&2
  exit 2
fi
RUN="smoke-$(openssl rand -hex 4)"
NET="$RUN-net"
PG="$RUN-pg"
APP="$RUN-app"
BAD="$RUN-bad"
POSTGRES_IMAGE=postgres:16-alpine

failures=0
pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; failures=$((failures + 1)); }
check() { local label="$1"; shift; if "$@"; then pass "$label"; else fail "$label"; fi; }

cleanup() {
  docker rm -f "$APP" "$BAD" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- per-run values: random, exported, never echoed --------------------------
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
MIGRATOR_PW="$(openssl rand -hex 24)"
APP_PW="$(openssl rand -hex 24)"
SESSION_SECRET="$(openssl rand -base64 36)"
CONFIG_ENCRYPTION_KEY="$(openssl rand -base64 36)"
STORAGE_SECRET_ACCESS_KEY="$(openssl rand -hex 20)"
DATABASE_URL="postgresql://app_user:${APP_PW}@db:5432/engineering_marketplace"
DATABASE_MIGRATION_URL="postgresql://migrator:${MIGRATOR_PW}@db:5432/engineering_marketplace"
export POSTGRES_PASSWORD MIGRATOR_PW APP_PW SESSION_SECRET CONFIG_ENCRYPTION_KEY \
  STORAGE_SECRET_ACCESS_KEY DATABASE_URL DATABASE_MIGRATION_URL
SECRETS=("$POSTGRES_PASSWORD" "$MIGRATOR_PW" "$APP_PW" "$SESSION_SECRET" "$CONFIG_ENCRYPTION_KEY" "$STORAGE_SECRET_ACCESS_KEY")

# The variables docker-compose.prod.yml gives `app`, with harmless stand-ins
# for the services this test does not run (.invalid never resolves).
APP_ENV=(
  -e NODE_ENV=production -e PORT=3000
  -e APP_URL=https://smoke.invalid
  -e DATABASE_URL -e DATABASE_MIGRATION_URL -e SESSION_SECRET -e CONFIG_ENCRYPTION_KEY
  -e STORAGE_ENDPOINT=https://storage.invalid -e STORAGE_REGION=auto
  -e STORAGE_ACCESS_KEY_ID=smoke -e STORAGE_SECRET_ACCESS_KEY
  -e STORAGE_BUCKET_ORIGINALS=em-originals -e STORAGE_BUCKET_DERIVATIVES=em-derivatives
  -e MAIL_TRANSPORT_URL=smtp://mail.invalid:587 -e 'MAIL_FROM=Enginora <no-reply@smoke.invalid>'
  -e PLATFORM_TIMEZONE=Asia/Damascus -e PLATFORM_BASE_CURRENCY=USD
  -e MALWARE_SCANNER=clamav -e CLAMAV_HOST=clamav.invalid -e CLAMAV_PORT=3310
  -e LOG_LEVEL=info -e SEO_INDEXABLE=false
)

# Counts, never prints, the generated values found in a text.
leaked() {
  local text="$1" count=0 value
  for value in "${SECRETS[@]}"; do
    case "$text" in *"$value"*) count=$((count + 1)) ;; esac
  done
  echo "$count"
}

in_image() { docker run --rm --entrypoint sh "$IMAGE" -c "$1"; }

echo "== image $IMAGE, expected $ARCH (run $RUN)"

# --- 1. architecture ---------------------------------------------------------
image_arch="$(docker image inspect --format '{{.Architecture}}' "$IMAGE")"
check "image architecture is $ARCH (got $image_arch)" test "$image_arch" = "$ARCH"
node_arch="$(in_image 'node -p process.arch')"
want_node=$([ "$ARCH" = amd64 ] && echo x64 || echo arm64)
check "node inside the image runs as $want_node (got $node_arch)" test "$node_arch" = "$want_node"

# --- 2. contents -------------------------------------------------------------
check "runs as nextjs (uid 1001)" test "$(in_image 'id -un; id -u' | tr '\n' ' ')" = "nextjs 1001 "
check "both Arabic fonts are in /app/assets/fonts" test "$(in_image 'ls /app/assets/fonts/*.ttf | wc -l')" -eq 2
check "the build output and the migrations are in the image" \
  in_image 'test -f /app/.next/BUILD_ID && test -f /app/src/db/migrations/meta/_journal.json && test -f /app/drizzle.config.ts'
stray="$(in_image "find /app -path /app/node_modules -prune -o \\( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '.pgpass' -o -name restored -o -name backups \\) -print | wc -l")"
check "no env file, key, .pgpass or backup under /app (found $stray)" test "$stray" -eq 0

# --- 3. native addons on this CPU --------------------------------------------
native="$(docker run --rm --entrypoint node "$IMAGE" -e "
  const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
  if (!GlobalFonts.registerFromPath('assets/fonts/NotoNaskhArabic-Regular.ttf', 'SmokeNaskh')) throw new Error('font');
  const ctx = createCanvas(400, 80).getContext('2d');
  ctx.font = '32px SmokeNaskh';
  const width = ctx.measureText('إنجينورا').width;
  const argon2 = require('@node-rs/argon2');
  const hash = argon2.hashSync('smoke');
  if (!argon2.verifySync(hash, 'smoke') || argon2.verifySync(hash, 'other')) throw new Error('argon2');
  import('mupdf').then((m) => {
    if (typeof m.Document !== 'function') throw new Error('mupdf');
    console.log(width > 0 ? 'ok' : 'zero-width');
  });
" 2>&1 | tail -1 || true)"
check "canvas draws Arabic with the bundled font, argon2 hashes, mupdf loads ($native)" test "$native" = ok

# --- 4. database and migrations from the image -------------------------------
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" --network-alias db \
  -e POSTGRES_PASSWORD -e POSTGRES_USER=postgres -e POSTGRES_DB=engineering_marketplace -e TZ=UTC -e PGTZ=UTC \
  -v "$ROOT/docker/postgres/init:/docker-entrypoint-initdb.d:ro" "$POSTGRES_IMAGE" >/dev/null
# Over TCP: the entrypoint's temporary init server listens on the socket only,
# so a socket check would pass before the roles exist.
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -q -h 127.0.0.1 -U postgres -d engineering_marketplace && break
  sleep 1
done
check "test PostgreSQL is up, initialised by docker/postgres/init" \
  docker exec "$PG" pg_isready -q -h 127.0.0.1 -U postgres -d engineering_marketplace

# The roles exist with no password (B6) until one is set, here per run.
docker exec -i -e MIGRATOR_PW -e APP_PW "$PG" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL' >/dev/null
\getenv migrator_pw MIGRATOR_PW
\getenv app_pw APP_PW
SELECT format('ALTER ROLE migrator WITH PASSWORD %L', :'migrator_pw'),
       format('ALTER ROLE app_user WITH PASSWORD %L', :'app_pw') \gexec
SQL

journal="$(in_image "node -p \"require('/app/src/db/migrations/meta/_journal.json').entries.length\"")"
applied() { docker exec "$PG" psql -tAq -U postgres -d engineering_marketplace -c 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2>/dev/null || echo 0; }
migrate_log="$(docker run --rm --network "$NET" -e DATABASE_MIGRATION_URL "$IMAGE" npm run db:migrate 2>&1)" && migrate_ok=yes || migrate_ok=no
check "npm run db:migrate from the image exits 0" test "$migrate_ok" = yes
check "every migration in the journal is applied ($(applied) of $journal)" test "$(applied)" = "$journal"
docker run --rm --network "$NET" -e DATABASE_MIGRATION_URL "$IMAGE" npm run db:migrate >/dev/null 2>&1 && again=yes || again=no
check "a second db:migrate exits 0 and applies nothing ($(applied) of $journal)" test "$again" = yes -a "$(applied)" = "$journal"
check "the migration output holds no generated secret" test "$(leaked "$migrate_log")" -eq 0
check "the schema belongs to migrator, not the superuser" \
  test "$(docker exec "$PG" psql -tAq -U postgres -d engineering_marketplace -c "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner <> 'migrator'")" -eq 0

# --- 5. the application ------------------------------------------------------
docker run -d --name "$APP" --network "$NET" -p 127.0.0.1::3000 "${APP_ENV[@]}" "$IMAGE" >/dev/null
port="$(docker port "$APP" 3000/tcp | head -1 | sed 's/.*://')"
url="http://127.0.0.1:$port"
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url$1" || echo 000; }
for _ in $(seq 1 90); do [ "$(status /api/health)" = 200 ] && break; sleep 1; done
check "GET /api/health answers 200 (got $(status /api/health))" test "$(status /api/health)" = 200
check "it reports config and database up" \
  sh -c "curl -s --max-time 10 '$url/api/health' | grep -q '\"database\":\"up\"'"
sessions() { docker exec "$PG" psql -tAq -U postgres -d engineering_marketplace -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'engineering_marketplace' AND $1"; }
check "the application connects as app_user, and as nothing else" \
  test "$(sessions "usename = 'app_user'")" -ge 1 -a "$(sessions "usename NOT IN ('app_user', 'postgres')")" -eq 0
for page in / /search /login /login/owner; do
  check "GET $page answers 200" test "$(status "$page")" = 200
done
check "an unknown path answers 404" test "$(status "/no-such-page-$RUN")" = 404
headers="$(curl -s -D - -o /dev/null --max-time 10 "$url/" || true)"
check "the page carries a CSP with a per-response nonce" sh -c "printf '%s' \"\$1\" | grep -qi '^content-security-policy:.*nonce-'" _ "$headers"
check "the page refuses to be framed" sh -c "printf '%s' \"\$1\" | grep -qi '^x-frame-options: *DENY'" _ "$headers"
for _ in $(seq 1 120); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$APP")" = healthy ] && break
  sleep 1
done
check "the image's own HEALTHCHECK reports healthy" test "$(docker inspect --format '{{.State.Health.Status}}' "$APP")" = healthy

# --- 6. failure handling -----------------------------------------------------
docker stop "$PG" >/dev/null
for _ in $(seq 1 30); do [ "$(status /api/health)" = 503 ] && break; sleep 1; done
check "database stopped: /api/health answers 503" test "$(status /api/health)" = 503
docker start "$PG" >/dev/null
for _ in $(seq 1 90); do [ "$(status /api/health)" = 200 ] && break; sleep 1; done
check "database back: /api/health answers 200 again, without a restart" test "$(status /api/health)" = 200

docker run -d --name "$BAD" --network "$NET" "${APP_ENV[@]}" -e STORAGE_ENDPOINT=file:///tmp/originals "$IMAGE" >/dev/null
for _ in $(seq 1 60); do [ "$(docker inspect --format '{{.State.Running}}' "$BAD")" = false ] && break; sleep 1; done
bad_log="$(docker logs "$BAD" 2>&1)"
check "filesystem storage in production: the process exits (code $(docker inspect --format '{{.State.ExitCode}}' "$BAD"))" \
  test "$(docker inspect --format '{{.State.Running}} {{.State.ExitCode}}' "$BAD")" = "false 1"
check "and says why" sh -c "printf '%s' \"\$1\" | grep -q 'Filesystem storage is not permitted in production'" _ "$bad_log"

# --- 7. no generated secret in any output ------------------------------------
app_log="$(docker logs "$APP" 2>&1)"
check "application log holds no generated secret" test "$(leaked "$app_log")" -eq 0
check "refused-boot log holds no generated secret" test "$(leaked "$bad_log")" -eq 0
check "database log holds no generated secret" test "$(leaked "$(docker logs "$PG" 2>&1)")" -eq 0
fatal="$(printf '%s\n' "$app_log" | grep -c '"level":60' || true)"
check "application log has no fatal entry (found $fatal)" test "$fatal" -eq 0

echo "== $([ "$failures" -eq 0 ] && echo "SMOKE PASSED" || echo "SMOKE FAILED: $failures check(s)") ($ARCH)"
[ "$failures" -eq 0 ]
