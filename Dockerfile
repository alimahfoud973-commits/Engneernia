# =============================================================================
# PRODUCTION IMAGE
# =============================================================================
# VERIFICATION STATUS (B8) — read this before trusting the file.
#
# Built from this file and RUN on every pull request and push to main by
# .github/workflows/image.yml: on a native arm64 runner (the server is Oracle
# Ampere A1, arm64) and on amd64. scripts/image-smoke.sh runs the image the
# way docker-compose.prod.yml does: `npm run db:migrate` from the image, the
# app on a throwaway PostgreSQL as app_user, /api/health and the HEALTHCHECK
# below, pages with their CSP nonce, the native addons on that CPU, the fonts,
# failure handling, and no generated secret in any output. First green on
# PR #28, arm64 and amd64.
#
# What is NOT verified here: the server itself — Ampere A1 hardware, its
# Docker, real R2, ClamAV with signatures, SMTP. docs/DEPLOYMENT.md §4-a runs
# the same smoke test on the server before the first `up`.
#
# A NOTE ON `output: 'standalone'`, WHICH THIS FILE DELIBERATELY DOES NOT USE.
# It was tried first, because it produces a much smaller image. Under
# standalone, next-intl's locale routing put every page into an infinite
# self-redirect — `GET /` answered `307 Location: /` forever — while the same
# build served by `next start` answered 200. Reproduced with the CSP proxy
# removed entirely, so it is not this project's code. Recorded as KI-2 in
# docs/KNOWN-ISSUES.md. The image is larger; the site works.
# =============================================================================

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Native addons (@napi-rs/canvas, mupdf, @node-rs/argon2) ship prebuilt binaries
# for this platform, so no toolchain is needed — but they are the reason the
# image is Debian rather than Alpine: the prebuilds are glibc.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `next build` refuses a non-production NODE_ENV — see scripts/check-build-env.mjs
# and KI-1. Set explicitly so the refusal cannot be triggered by a stray value
# inherited from the build host.
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Runs as a non-root user. The image writes nothing outside /tmp: originals and
# previews live in S3-compatible storage, which the application REFUSES to
# replace with a local disk in production.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=deps  --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nextjs:nodejs /app/.next       ./.next
COPY --from=build --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=build --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts

# Read at runtime by path, not imported — so nothing traces them and nothing
# would notice their absence until a settlement statement was requested.
# `assertArabicFonts` then refuses to draw, rather than emitting a PDF full of
# empty boxes, which is the failure mode this copy exists to prevent.
COPY --from=build --chown=nextjs:nodejs /app/assets ./assets

# Migrations and their journal: `npm run db:migrate` runs from the image, so the
# same artefact that serves the site is the one that shaped the schema.
COPY --from=build --chown=nextjs:nodejs /app/src/db ./src/db
COPY --from=build --chown=nextjs:nodejs /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build --chown=nextjs:nodejs /app/src/i18n ./src/i18n

USER nextjs
EXPOSE 3000

# Answers only when the database answers. A container that cannot reach
# PostgreSQL must not be sent traffic — every page on this platform reads.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
