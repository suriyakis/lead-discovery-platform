# Multi-stage build for the Next.js app in production.
#
# Final image is the Next.js standalone server: just node + the minimal
# files needed to serve. Roughly 200 MB on top of node:22-alpine.
#
# Build:    docker compose -f docker-compose.prod.yml build
# Run:      docker compose -f docker-compose.prod.yml up -d
# Migrate:  docker compose -f docker-compose.prod.yml exec app node scripts/migrate.cjs
#           (or pnpm db:migrate before bringing up app)

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
RUN pnpm build

# ---- runner ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Standalone output ships a self-contained server.js plus the trimmed
# node_modules it actually needs. Everything else is omitted.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Drizzle migrations — copied in so we can run them inside the container.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

# Storage mount point for the local-FS storage provider.
RUN mkdir -p /app/storage && chown nextjs:nodejs /app/storage

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
