# AGENTS.md

How AI coding agents — primarily Claude CLI — should work in this repository.

## Operating principles

1. **Read before you write.** Inspect the current code path, the existing services, and the docs before editing. Most "missing" features are already partially built.
2. **Work on one task at a time.** Do not modify unrelated modules. If you notice a bug outside your task, file it in `TODO.md`, do not fix it inline.
3. **Tests are part of the task.** A task is not done until tests pass. Add or update tests for whatever you touched.
4. **Leave the app runnable.** `pnpm dev` and `pnpm test` must both succeed at every commit on `main`.
5. **Commit only working code.** No half-finished implementations. No `// TODO: fix this later` left in critical paths.
6. **Update `TODO.md` when you finish a task** and when you discover new work.
7. **Update `docs/ARCHITECTURE.md` whenever you make an architectural decision.** Do not silently change shape.

## Things that are forbidden

- **Workspace isolation bypasses.** Every tenant-owned query must accept a `workspaceId` from the calling context. No `WHERE workspaceId = 1` defaults. No "for now I'll just ignore tenancy." See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#workspace-first).
- **Live API calls in tests.** Use mock providers. Real providers (`anthropic`, `serpapi`, etc.) are wired via the abstraction layer; tests inject the mock.
- **Editing on Hetzner.** Source-of-truth is GitHub. The deploy server runs `git pull && docker compose up -d --build`. If you must touch production state, document it in `docs/DEPLOYMENT.md` under "emergency procedures."
- **Hard-coding products, sectors, or connector logic.** Every product-specific behavior comes from `ProductProfile` configuration. Every connector is generic with a recipe.
- **Coupling modules.** Discovery does not know about email. Review queue does not know about CRM. Product profiles do not know about RAG. The dependency graph stays one-way and shallow.

## Tooling preferences

- Prefer **Drizzle's `select()` builder** over raw SQL. Use raw SQL only with a comment explaining why.
- Prefer **Zod** for runtime input validation at module boundaries (route handlers, job inputs, connector configs).
- Prefer **service classes / pure functions** over controller-fat code. Service modules expose typed functions; route handlers are 10–30 lines.
- Prefer **`pnpm`** for package management. Lockfile is committed.
- Prefer **named exports** over default exports for service / library code.

## Patterns to follow

- **Workspace context object.** Every service function takes `{ workspaceId, userId, role, ... }` as its first argument. There is one canonical `WorkspaceContext` type in `src/lib/services/context.ts`.
- **Provider abstractions.** AI, search, jobs, storage are all defined by interfaces in `src/lib/{ai,search,jobs,storage}`. Implementations live alongside. The active provider is selected by env var at boot.
- **Audit + usage logs.** Significant actions emit `audit_log` events. AI/search/job activity emits `usage_log` events. Both include `workspaceId`. Do not skip them.
- **Explainable classification.** Qualification results store the rule, keyword match, model, and evidence used. The user must be able to ask "why was this lead approved?" and get a real answer.

## How to ship a change

1. Pick or pull a task from `TODO.md`.
2. Read the relevant section of `docs/MODULES.md` and `docs/DATABASE_MODEL.md`.
3. Make the change in the smallest viable diff.
4. Add or update tests. Run `pnpm test`.
5. Run `pnpm typecheck` and `pnpm lint`.
6. Manually verify in `pnpm dev` if the change is user-visible.
7. Update `TODO.md`. Update docs if architecture moved.
8. Commit with a message that says **what** and **why** in the first line.
9. Push to GitHub. Hetzner deploys on merge to `main`.

## When unsure

Stop. Ask. A clear question now is cheaper than a wrong assumption committed to the database.
