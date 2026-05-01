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
- [x] **P1-11.** Workspace isolation suite at `src/tests/workspace.isolation.test.ts`. Three workspaces (A/B/C), 10 users across the role matrix + outsider + super_admin. **28 tests** covering: read isolation (getWorkspace, listMembers, listAuditEvents w/ kind filter, summarizeUsage), write isolation (createWorkspace, addMember, removeMember, setMemberRole all scoped to one workspace), role auth (viewer/member/manager/admin/owner/super_admin gates on every mutation), last-owner protection (cannot remove or demote sole owner), and WorkspaceContext invariants. Test infra: dedicated `lead_test` DB, `truncateAll`/`seedUser`/`seedWorkspace` helpers, `globalSetup` migrates fresh. **55 / 55 tests pass.**
- [x] **P1-12.** Minimal UI live and verified end-to-end. `src/app/page.tsx` (sign-in form via server action), `src/app/dashboard/page.tsx` (user info + workspace + role). Verified with real Google sign-in: user `jb.poltrade@gmail.com` promoted to `super_admin`, "Personal" workspace created with random slug, member row as `owner`, `audit_log` entry of kind `workspace.bootstrap` written. Note: `AUTH_URL=http://localhost:3000` is required to match the OLD Wandizz OAuth client's registered redirect URIs (the new dedicated client at `...8fpof5gm9b9r20mo293jg3vpahs8guff` had silent corruption on its redirect URIs that we couldn't fix; reverted to old client).
- [x] **P1-13.** Deployed to agregat 2026-05-01 at `https://discover.nulife.pl`. Production stack: postgres + app via `docker-compose.prod.yml`, nginx vhost reverse-proxying `127.0.0.1:3001`, certbot SSL (Let's Encrypt, expires 2026-07-30). Migrations applied, `/api/health` returns 200 over HTTPS, sign-in flow live.

**Phase 1 complete.** Tagged `phase-1-complete` in git.

## Phase 2 — Product Profiles

- [x] **P2-01.** `product_profiles` schema (25 cols + reserved fields for Phase 9/13). Migration `0001_oval_stardust.sql` applied.
- [x] **P2-02.** Service `src/lib/services/product-profile.ts`: create / get / list / update / archive / restore. Workspace-scoped, role-gated, transactional, audit-logged.
- [x] **P2-03.** 21-test suite in `src/tests/product-profile.test.ts`. **76 / 76 total tests pass.**
- [x] **P2.5.** Visual baseline: `signal/works` brand pulled from `suriyakis/market-navigator`. `BrandHeader` component, theme tokens, hero copy.
- [x] **P2-04.** API surface: `auth-context.ts` (workspace resolver), `http.ts` (error mapper), Zod schemas, `/api/products` (GET/POST), `/api/products/[id]` (GET/PATCH/DELETE).
- [x] **P2-05.** `/products` list page (active + archived sections, "+ New product" CTA).
- [x] **P2-06.** `/products/new` create form + `/products/[id]` edit form via server actions. Shared `ProductFields` component with all 14 editable fields. Archive/restore for admins+.
- [x] **P2-07.** Deployed to https://discover.nulife.pl 2026-05-01. SHA `f586fd1`. New app container rebuilt with the /products UI; migration `0001_oval_stardust.sql` applied (product_profiles table live). Smoke tests pass: /api/health 200, /api/products 401 (correct, requires auth), /products 307 (redirects unauthenticated users).

**Phase 2 complete.**

## Phase 3 — Connector Framework

- [x] **P3-01.** Schema: connectors, connector_recipes, connector_runs, connector_run_logs, source_records (5 tables, 2 enums). Migration `0002_careful_titania.sql` applied.
- [x] **P3-02.** ISourceConnector interface + HarvesterEvent types in `src/lib/connectors/types.ts`. NormalizedRecord shape with recordType + raw + normalized + evidence + confidence.
- [x] **P3-03.** Connector registry in `src/lib/connectors/registry.ts`. registerConnector/getConnector/listConnectors + reset for tests.
- [x] **P3-04.** Mock connector in `src/lib/connectors/mock.ts` — deterministic SHA-256-seeded records, `count`/`seed`/`delayMs`/`failAfter` recipe controls. Self-registers on import.
- [x] **P3-05.** Runner in `src/lib/connectors/runner.ts`: marks run running, iterates events, persists logs/records, handles dedupe (unique conflict = silent skip), updates progress, ends as succeeded/failed/cancelled.
- [x] **P3-06.** Service `src/lib/services/connector-run.ts`: createConnector (admin-gated), createRecipe, listRecipes, startRun (member+, refuses inactive connectors, snapshots recipe at run time), getRun, listRuns, listRunLogs, listSourceRecords. Each mutation emits audit_log.
- [x] **P3-07.** Tests in `src/tests/connector.test.ts` (15 cases): happy path, deterministic seed, dedupe, fatal error, workspace isolation, role gates, audit emission, inactive-connector refusal, error shape. **91 / 91 total tests pass.**
- [x] **P3-08.** Deployed 2026-05-01. SHA `de06b8f` (+ lint cleanup in next commit). Migration `0002_careful_titania.sql` applied — 15 total tables. /api/health returns 200.

**Phase 3 complete.**

## Phase 4 — Review Queue

- [x] **P4-01.** Schema: `review_items`, `review_comments`. State enum (new/needs_review/approved/rejected/ignored/duplicate/archived). Unique index on (workspace, source_record). Migration `0003_eminent_talkback.sql` applied.
- [x] **P4-02.** Service `src/lib/services/review.ts`: seed (idempotent), list (state/assignee filters), get with joined source record + commenters, approve/reject/ignore/flag/archive (admin-only), assign, comment, getStateCounts. Audit-logged on every mutation.
- [x] **P4-03.** Runner now calls `seedReviewItem` after each successful source_record insert. Tests verify auto-seed.
- [x] **P4-04.** Tests in `src/tests/review.test.ts` (19 cases): runner integration, listing, all transitions, comment validation/audit, assignment, counts, isolation. **110 / 110 total tests pass.**
- [x] **P4-05.** UI: `/review` (state-tab filters with counts, summary cards) + `/review/[id]` (source detail, action row, reason-rejection form, threaded comments, server actions for every mutation).
- [x] **P4-06.** Deployed 2026-05-01. SHA `4778830`. Migration `0003_eminent_talkback.sql` applied (17 total tables). /api/health 200.

**Phase 4 complete.**

## Phase 5 — Learning Memory Foundation

- [x] **P5-01.** Schema: `learning_events` (append-only), `learning_lessons` (mutable, with reserved `embedding` for Phase 12). 12 lesson categories defined in service. Migration `0004_mute_the_executioner.sql` applied.
- [x] **P5-02.** Service `src/lib/services/learning.ts`: recordFeedback (event + heuristic extractor + audit), createLesson, listLessons, getLesson, updateLesson, enableLesson/disableLesson, getRelevantLessons (taskType-aware: classification/outreach/reply category sets), applyLessonsToPrompt.
- [x] **P5-03.** Heuristic extractor — pattern-matches qualification negative/positive, false positive/negative, outreach style, contact role, sector preference, dedupe hint, connector quality. Conservative — returns null on neutral text. Phase 7+ swaps for the AI provider abstraction.
- [x] **P5-04.** Hooked into `commentOnReviewItem` — every review comment becomes a feedback event. Best-effort (failures logged, do not undo the comment).
- [x] **P5-05.** Tests in `src/tests/learning.test.ts` (17 cases): heuristic edge cases, recordFeedback with/without extraction, role gates, lesson list ordering by confidence, enable/disable round-trips, retrieval taskType filtering, product-scoping, applyLessonsToPrompt. **131/131 total tests pass.**
- [x] **P5-06.** UI: `/learning` (category tabs + show-disabled toggle), `/learning/new` (manual creation form), `/learning/[id]` (edit + enable/disable toggle). Linked from dashboard.
- [x] **P5-07.** Deployed 2026-05-01. SHA `7d1a401`. Migration `0004_mute_the_executioner.sql` applied (19 total tables).

**Phase 5 complete.**

## Phase 6 — First real discovery source

**Design lock (2026-05-01):** API keys for paid providers (SerpAPI, etc.)
support BYOK: workspace-supplied key wins, otherwise falls back to a
platform default in env. Every provider call logs `usage_log` with
`payload.keySource = "workspace" | "platform"` so cost views distinguish
spend.

- [x] **P6-01.** `workspace_secrets` schema with AES-256-GCM encryption (`MASTER_KEY` env). `crypto.ts` (encrypt/decrypt round-trip with auth tag), `secrets.ts` (set/get/has/delete/list, all admin-gated, audit-logged, no value leakage), `resolveProviderKey(ctx, secretKey, envVarName)` returning `{key, source}`. **150/150 tests pass.**
- [ ] **P6-02.** SerpAPI search provider implementation.
- [ ] **P6-03.** `internet_search` connector that uses ISearchProvider + recipe queries.
- [ ] **P6-04.** Workspace settings page `/settings/integrations`.
- [ ] **P6-05.** Connector + recipe UI under `/connectors`.
- [ ] **P6-06.** Usage logging in the search path; per-workspace cost view.
- [ ] **P6-07.** BullMQ + Redis for durable jobs.
- [ ] **P6-08.** Deploy with `MASTER_KEY` (required) and optional `SERPAPI_KEY`.

## Discovered along the way

(empty — add discoveries with `> 2026-MM-DD …` prefix when found)
