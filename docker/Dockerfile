# Multi-stage build for the Next.js app in production.
#
# Final image is the Next.js standalone server: just node + the minimal
# files needed to serve. Roughly 200 MB on top of node:22-alpine.
#
# PC-36: the same image also carries the background-job worker, bundled
# with its dependencies into worker/worker.cjs (scripts/build-worker.mjs;
# the image has no tsx and no full node_modules). docker-compose.prod.yml
# runs it twice: `app` (node server.js, ROLE=web) and `worker`
# (node worker/worker.cjs, ROLE=worker).
#
# Build + run:  scripts/deploy/deploy-agregat.sh (docs/DEPLOYMENT.md)
# Migrate:      host-side `pnpm db:migrate` (the image has no tsx)

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---- deps ----
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- builder ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build && pnpm build:worker

# ---- runner ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# PC-07: the commit this image was built from, reported in the
# token-protected /api/ready detail (docs/OPS_MONITORING.md). Pass it with
# BUILD_SHA=$(git rev-parse --short HEAD) docker-compose ... build app.
ARG BUILD_SHA=unknown
ENV BUILD_SHA=$BUILD_SHA

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Standalone output ships a self-contained server.js plus the trimmed
# node_modules it actually needs. Everything else is omitted.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# PC-36: the background-job worker (the `worker` service's command).
COPY --from=builder --chown=nextjs:nodejs /app/dist/worker ./worker

# Drizzle migrations — copied in so we can run them inside the container.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

# Storage mount point for the local-FS storage provider.
RUN mkdir -p /app/storage && chown nextjs:nodejs /app/storage

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
