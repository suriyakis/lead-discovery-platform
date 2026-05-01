# Lead Platform

Multi-tenant B2B lead discovery, qualification, outreach, and intelligence platform.

The platform helps users find companies, contacts, projects, tenders, and other opportunities for products or services they want to sell. It is **generic by design** — no hard-coded sectors, products, or connectors. Discovery sources, qualification rules, and outreach style come from workspace-specific configuration.

## Status

**Phase 0 — repository + documentation + deployment skeleton.** No application code yet. The next phase wires the workspace/auth/database foundation. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full phase plan.

## Stack

- **Language:** TypeScript end-to-end
- **Framework:** Next.js 15 (App Router) — UI + API route handlers
- **Database:** PostgreSQL via Drizzle ORM
- **Auth:** Auth.js (next-auth v5) with Google OAuth
- **Background jobs:** abstraction layer; in-memory in dev, BullMQ + Redis in production (later phases)
- **File storage:** abstraction layer; local filesystem in dev, S3-compatible later
- **Tests:** Vitest
- **Deploy:** Docker Compose on Hetzner; Nginx reverse proxy + Let's Encrypt
- **Source of truth:** GitHub. The server pulls from GitHub. No manual editing on production except emergency.

The architectural reasoning is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick start (local development)

Prerequisites: Node 22+, pnpm, Docker, Docker Compose.

```bash
cp .env.example .env
# fill in AUTH_SECRET (openssl rand -hex 32), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OWNER_EMAIL

docker compose up -d postgres        # starts the database
pnpm install
pnpm db:migrate                       # applies Drizzle migrations (Phase 1+)
pnpm dev                              # http://localhost:3000
```

Run the test suite:
```bash
pnpm test
```

Full deployment instructions, including Hetzner production setup: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Repository layout

```
docs/                  Architecture, modules, database, deployment, roadmap
src/
  app/                 Next.js App Router (UI + API route handlers)
  lib/
    db/                Drizzle schema + client + migrations
    services/          Business logic — workspace-scoped, framework-independent
    connectors/        Connector framework + harvester implementations
    search/            Search provider abstraction (mock, serpapi, gemini, ...)
    ai/                AI provider abstraction (mock, anthropic, openai, ...)
    jobs/              Job queue abstraction
    storage/           File storage abstraction
    learning/          Feedback memory + lesson extraction
  tests/               Vitest test suites
drizzle/               Generated migration SQL
docker/                Dockerfile and related assets
scripts/               One-off and ops scripts
```

The rule that makes this layout work: **route handlers in `src/app/api/.../route.ts` are thin — they parse input, enforce auth + workspace context, and call into `src/lib/services`.** All business logic lives in `lib/`, which means it can be tested without HTTP and reused by background jobs.

## Working with this codebase

- See [`AGENTS.md`](AGENTS.md) for how AI coding agents (Claude CLI) should approach changes here.
- See [`TODO.md`](TODO.md) for the next concrete tasks.
- Every change must keep the app runnable, tested, and committed. No half-finished branches in `main`.
- Never bypass workspace isolation. Every tenant-owned query takes a `workspaceId`. There is no "global default workspace."

## License

Proprietary. All rights reserved.
