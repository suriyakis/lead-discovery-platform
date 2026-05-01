# Phase 0 placeholder. The image builds but does nothing useful until
# Phase 1 introduces a real Next.js app and a build pipeline.
#
# When Phase 1 ships, this Dockerfile becomes a multi-stage build:
#   1. deps stage — install pnpm + production deps
#   2. build stage — pnpm build
#   3. runtime stage — distroless / alpine, runs `node` against `.next/standalone`

FROM node:22-alpine AS base
WORKDIR /app

# pnpm via corepack — version is pinned in package.json `packageManager`.
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
# Phase 0: lockfile may not exist yet; allow that.
RUN pnpm install --frozen-lockfile || pnpm install

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 3000
# Phase 0 placeholder command. Phase 1 replaces with `pnpm start` (or the
# Next.js standalone server entrypoint).
CMD ["node", "-e", "console.log('lead-discovery-platform image — Phase 0 skeleton; replace CMD in Phase 1.'); setInterval(() => {}, 1 << 30);"]
