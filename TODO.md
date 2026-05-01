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
- [x] Create the GitHub repo and push the initial commit. (suriyakis/lead-discovery-platform on 2026-05-01)
- [x] Verify Phase 0 review with operator before starting Phase 1.

## Phase 1 — Core platform foundation (next up)

Each task ends with the app runnable + tests passing.

- [x] **P1-01.** Phase 1 dependencies added: Next.js 15.5, React 19.2, Auth.js 5.0.0-beta.25, Drizzle 0.38, postgres 3.4, Zod 3.25, Vitest 2.1, Prettier 3.8, ESLint 9.39, TypeScript 5.9. pnpm-lock.yaml committed.
- [x] **P1-02.** Next.js App Router skeleton live: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/api/health/route.ts`. tsconfig strict, ESLint flat config + Prettier wired. `pnpm typecheck`, `pnpm build`, `pnpm dev` all green; `/api/health` returns `{"ok":true}`. Note: `output: 'standalone'` deferred until Dockerfile actually consumes it.
- [x] **P1-03.** Drizzle wired: `drizzle.config.ts`, `src/lib/db/client.ts`, `src/lib/db/schema/{auth,workspaces,audit,index}.ts`, `scripts/migrate.ts`. Connection-pool cached on `globalThis` for HMR. Postgres comes up via `docker compose up -d postgres`. `dotenv` added for env loading.
- [x] **P1-04.** First migration `0000_narrow_ravenous.sql` generated and applied: 9 tables (`users`, `accounts`, `sessions`, `verification_tokens`, `workspaces`, `workspace_members`, `workspace_settings`, `audit_log`, `usage_log`) + 2 enums (`user_role`, `workspace_member_role`). Verified in psql. Auth.js tables use camelCase column names per adapter requirements; non-auth tables use snake_case.
- [x] **P1-05.** `WorkspaceContext` + `makeWorkspaceContext` validator + `canWrite` / `canAdminWorkspace` / `canOwnWorkspace` role helpers in `src/lib/services/context.ts`. Vitest config wired (`vitest.config.ts`, `src/tests/`). 9/9 tests pass — covers required-field validation, every documented role, and the three role-based capability gates.
- [x] **P1-06.** Auth.js v5 wired with Google provider + Drizzle adapter. Database session strategy (sessions in `sessions` table). `src/lib/auth.ts`, `src/app/api/auth/[...nextauth]/route.ts`, `src/types/next-auth.d.ts` (session.user.id + role augmentation). `/api/auth/providers` returns Google config; `/api/auth/signin` renders. Full sign-in E2E pending real `GOOGLE_CLIENT_ID/SECRET` for `localhost:3000/api/auth/callback/google`.
- [x] **P1-07.** Bootstrap super_admin promotion baked into `events.signIn` callback — on first login by `OWNER_EMAIL` user is promoted to `role='super_admin'`, a workspace is created with random slug, the user is added as `owner`, and an `audit_log` entry of kind `workspace.bootstrap` is written. `lastSignedInAt` updated on every sign-in.
- [x] **P1-08.** Workspace service in `src/lib/services/workspace.ts`: `createWorkspace`, `getWorkspace`, `listMembers` (joined with users), `addMember`, `removeMember`, `setMemberRole`. Transactional, uses `WorkspaceContext`, enforces canAdminWorkspace / canOwnWorkspace, prevents removing/demoting the last owner. Each mutation emits an `audit_log` entry. Typed `WorkspaceServiceError` with `code` field. DB integration tests deferred to P1-11.
- [x] **P1-09.** Audit + usage services in `src/lib/services/audit.ts` and `src/lib/services/usage.ts`. `recordAuditEvent` (workspace-scoped), `recordPlatformAuditEvent` (no workspace), `listAuditEvents` with kind/since/until/limit filters. `recordUsage`, `summarizeUsage` returning `(kind, provider) -> {totalUnits, totalCostCents, eventCount}`.
- [x] **P1-10.** Provider abstractions live in `src/lib/{ai,search,jobs,storage}/index.ts`: `IAIProvider` (+ MockAIProvider), `ISearchProvider` (+ MockSearchProvider), `IJobQueue` (+ InMemoryJobQueue), `IStorage` (+ LocalFileStorage with path-traversal guard). Each has a `getX()` factory that reads env, plus `_setXForTests` injector. 18 new tests prove deterministic output, error capture in jobs, and stream/buffer round-trip in storage. **27 / 27 tests pass.**
- [ ] **P1-11.** Workspace isolation test suite. Three workspaces, three users, role matrix. Every service function tested for: (a) cannot read other workspace, (b) cannot write to other workspace, (c) viewer cannot mutate, (d) member cannot manage settings.
- [ ] **P1-12.** Minimal UI: signed-in user sees workspace selector → bare dashboard with workspace name + their role. No styling beyond default Tailwind.
- [ ] **P1-13.** First deploy to Hetzner per `docs/DEPLOYMENT.md`. The live URL must show the same flow as local. TLS via certbot.

When all P1-* items are checked: tag `phase-1-complete` in git and start Phase 2.

## Discovered along the way

(empty — add discoveries with `> 2026-MM-DD …` prefix when found)
