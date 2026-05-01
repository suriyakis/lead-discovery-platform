# TODO

Single, prioritized list. **Pick the top open task and start.** When you finish, mark `[x]`, append a note about anything you discovered, and add new tasks below.

Tasks are deliberately small. If a task feels like it's growing past one focused session, split it.

## Phase 0 — Repo + docs + Docker skeleton

- [x] Repository structure created.
- [x] `README.md` written.
- [x] `AGENTS.md` written.
- [x] `docs/ARCHITECTURE.md` written.
- [x] `docs/MODULES.md` written.
- [x] `docs/DATABASE_MODEL.md` written.
- [x] `docs/CONNECTOR_RULES.md` written.
- [x] `docs/LEARNING_LAYER.md` written.
- [x] `docs/DEPLOYMENT.md` written.
- [x] `docs/ROADMAP.md` written.
- [x] `.env.example` written.
- [x] `.gitignore` written.
- [x] `docker-compose.yml` skeleton.
- [x] `docker/Dockerfile` skeleton.
- [x] `package.json` skeleton with scripts and a frozen pnpm version field (real deps come in Phase 1).
- [ ] Create the GitHub repo and push the initial commit.
- [ ] Verify Phase 0 review with operator before starting Phase 1.

## Phase 1 — Core platform foundation (next up)

Each task ends with the app runnable + tests passing.

- [ ] **P1-01.** Add real Phase 1 dependencies in `package.json` (Next.js 15, React 19, Drizzle, postgres driver, Zod, Auth.js, Vitest, ESLint, Prettier). Lock with `pnpm install`. Commit `pnpm-lock.yaml`.
- [ ] **P1-02.** Bootstrap Next.js App Router skeleton (`src/app/layout.tsx`, `src/app/page.tsx`, `src/app/api/health/route.ts`). `pnpm dev` serves a placeholder. `/api/health` returns `{ ok: true }`.
- [ ] **P1-03.** Configure Drizzle: `src/lib/db/client.ts`, `src/lib/db/schema/index.ts`, `drizzle.config.ts`. Pointing at the docker-compose Postgres.
- [ ] **P1-04.** Define `users`, `workspaces`, `workspace_members`, `workspace_settings`, `audit_log`, `usage_log`, plus Auth.js's `accounts`, `sessions`, `verification_tokens`. Generate the first migration. `pnpm db:migrate` applies it cleanly on a fresh DB.
- [ ] **P1-05.** Define `WorkspaceContext` and a `withWorkspaceContext` helper for route handlers and services. Add a unit test that asserts `workspaceId` is required on the context.
- [ ] **P1-06.** Wire Auth.js with Google OAuth. Sign in / sign out flow works. Sessions persist in `sessions` table.
- [ ] **P1-07.** Bootstrap path: on first login, if email matches `OWNER_EMAIL`, promote user to `role='super_admin'` and create their first workspace owned by them.
- [ ] **P1-08.** Implement workspace service: `createWorkspace`, `getWorkspace`, `addMember`, `removeMember`, `setMemberRole`, `listMembers`. All take `WorkspaceContext`.
- [ ] **P1-09.** Implement `audit_log` and `usage_log` services. `recordAuditEvent`, `recordUsage`, `listAuditEvents`, `summarizeUsage`. Used internally by other modules.
- [ ] **P1-10.** Provider abstractions stub: `IAIProvider`, `ISearchProvider`, `IJobQueue`, `IStorage` with mock / local-FS implementations. Interfaces live in `src/lib/{ai,search,jobs,storage}/index.ts`. Tests prove the mock returns deterministic output.
- [ ] **P1-11.** Workspace isolation test suite. Three workspaces, three users, role matrix. Every service function tested for: (a) cannot read other workspace, (b) cannot write to other workspace, (c) viewer cannot mutate, (d) member cannot manage settings.
- [ ] **P1-12.** Minimal UI: signed-in user sees workspace selector → bare dashboard with workspace name + their role. No styling beyond default Tailwind.
- [ ] **P1-13.** First deploy to Hetzner per `docs/DEPLOYMENT.md`. The live URL must show the same flow as local. TLS via certbot.

When all P1-* items are checked: tag `phase-1-complete` in git and start Phase 2.

## Discovered along the way

(empty — add discoveries with `> 2026-MM-DD …` prefix when found)
