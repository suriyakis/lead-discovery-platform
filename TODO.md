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
- [x] **P6-02.** SerpAPI search provider implementation. ISearchProvider updated to take WorkspaceContext + return SearchOutcome with usage. SerpAPIProvider with key resolution (workspace→platform→null), HTTP error mapping (401→unauthorized, 429→rate_limited, 5xx→upstream_error), 15s timeout via AbortController, body.error → provider_error, MockSearchProvider updated to return `{results, usage:{keySource:'mock',units:1,cost:0}}`. **166/166 tests pass.**
- [x] **P6-03.** `internet_search` connector. Reads `searchQueries` array from the recipe (1..50 queries), iterates them through `getSearchProvider().search(ctx, query, options)`, emits each result as a `web_search_hit` NormalizedRecord, writes one `usage_log` entry per query with `payload.keySource`. Self-registers via `mock.ts` import chain. Recipe validation via Zod with `passthrough()` so generic recipe fields don't break it. Per-query failures non-fatal; `no_key`/`unauthorized` are fatal. **172/172 tests pass.**
- [x] **P6-04.** Settings shell at `/settings` redirecting to `/settings/integrations`. SettingsNav component (tabbed). Integrations page shows SerpAPI status (workspace key / platform default / not configured), set/clear key form (admin-only), test-connection button. Toast-style success/error feedback via search params. Dashboard now links to Settings.
- [x] **P6-05.** Connector + recipe UI: `/connectors` (list with last-run badges), `/connectors/new` (radio-card template chooser), `/connectors/[id]` (detail with recipes + recent runs), `/connectors/[id]/recipes/new` (template-aware fields), `/connectors/[id]/recipes/[recipeId]` (read config + Run-now), `/connectors/[id]/runs/[runId]` (status, log stream, records).
- [x] **P6-06.** Usage logging in the search path was wired in P6-03 (`payload.keySource` per query call). Cost view at `/settings/usage` with range selector (Today / 7d / 30d / All time), totals card, by-(kind,provider) breakdown table, and by-key-source table that distinguishes workspace vs platform spend. `summarizeUsageByKeySource` helper added.
- [x] **P6-07.** BullMQ + Redis durable job queue. `BullMQJobQueue` impl + `bootstrap.ts` handler registry. `startRun` enqueues, returns pending row + jobId. `awaitRun(ctx, runId, {timeoutMs})` polls to terminal state for tests. Memory queue runs handlers on microtask; bullmq runs in Worker. Redis added to docker-compose.{yml,prod.yml}. **172/172 tests pass.**
- [x] **P6-08.** Deployed 2026-05-01. SHA `0c007ed`. `workspace_secrets` table created (migration `0005`). 3 services running on agregat (postgres, redis, app). MASTER_KEY set in prod .env. JOB_QUEUE_PROVIDER stays `memory` for now — flip to `bullmq` when durability matters. Smoke tests green.

**Phase 6 complete.**

## Phase 7 — Classification Engine

**Goal.** Source records get scored and labelled against active product profiles
on the way in, with explainable evidence for every verdict.

**Design lock (2026-05-01):** the engine is rule-first — keyword/sector
matching with learning-lesson modifiers — to keep classification deterministic
and free in Phase 7. The AI provider path stays optional and lands later via
the existing `IAIProvider` abstraction without changing the table shape.
`qualifications` is keyed `(workspace_id, source_record_id, product_profile_id)`
so re-classifying upserts in place rather than accumulating duplicates.

- [x] **P7-01.** `qualifications` schema (migration `0006_crazy_vertigo.sql`). One row per (record, product) pair with unique index, plus indexes on `(workspace_id, product_profile_id)` and `(workspace_id, is_relevant)`. Stores `is_relevant`, `relevance_score (0..100)`, `confidence`, qualification + rejection reasons, matched keywords, disqualifying signals, evidence JSON, method (`rules | ai | hybrid`), optional model id.
- [x] **P7-02.** Pure rule engine in `qualification-engine.ts`. `classifyRecord(record, product, lessons)` returns a `ClassificationVerdict` with full evidence (every contribution recorded). Scoring: BASE 50, +6 per include keyword, -25 per exclude, +10 per sector hit, -50 per forbidden phrase (also forces `isRelevant=false`), ±10/-15 for positive/negative learning lessons. Confidence scales with the count of matching signals, capped 30..95. Lesson trigger token = longest word >4 chars in the rule (Phase 12 swaps for embedding similarity).
- [x] **P7-03.** DB-backed service `qualification.ts`: `classifySourceRecord` iterates every active product profile, retrieves both product-scoped AND workspace-wide lessons via `getRelevantLessons`, runs the engine, upserts the row. `reclassifyWorkspace` re-runs over all source records (audit-logged). `listQualificationsForRecord`, `topQualification`, `listLeads(filter)` for /leads UI. Connector runner now calls `classifySourceRecord` best-effort after each insertRecord.
- [x] **P7-04.** Tests in `src/tests/qualification.test.ts` (17 cases): one row per active product, inactive products skipped, idempotent upsert, top-1 ordering, product-scoped lessons influence only that product, runner auto-classifies, reclassifyWorkspace covers every record, no cross-workspace leak, plus engine unit cases (forbidden forces irrelevant, evidence trail completeness, confidence bounds). **189/189 total tests pass.**
- [x] **P7-05.** UI: `/review/[id]` Qualifications panel (one card per product profile with score, threshold, reason, matched keywords, disqualifying signals, expandable evidence/contribution list). New `/leads` page with product filter, relevant-only/all toggle, score/recent sort, deep-links to the review item.
- [x] **P7-06.** Deployed 2026-05-02. SHA `ff37019`. Migration `0006_crazy_vertigo.sql` applied (qualifications table). Discover container moved off the shared :3000 host port to `127.0.0.1:3001:3000` so wandizz (lead.nulife.pl) could re-claim :3000. Both vhosts live: lead.nulife.pl → wandizz on :3000, discover.nulife.pl → docker app on :3001. Health: `{"ok":true}`.

**Phase 7 complete.**

## Phase 8 — Outreach Drafts

**Goal.** Generate drafts from approved records using product-specific style.
**No sending.** Drafts land in a review state; humans approve; future Send
phase reads approved rows and dispatches.

**Design lock (2026-05-02):** rules-mode is the deterministic default, AI-mode
optional via the `IAIProvider` abstraction. Output of *both* modes routes
through forbidden-phrase stripping at the engine, so a misbehaving AI cannot
smuggle banned phrases past us. Each `(review_item, product_profile)` pair has
at most one active draft (partial unique index on
`status <> 'superseded'`); regenerating supersedes the prior row.

- [x] **P8-01.** `outreach_drafts` schema (migration `0007_dusty_wrecker.sql`). One row per (review_item, product_profile) attempt with `outreach_draft_status` enum (draft | needs_edit | approved | rejected | superseded). Stores subject, body, channel/language, confidence, method, model, evidence jsonb, forbidden_stripped[], matched_lesson_ids[], plus the full review trail (approved/rejected/edited by user + timestamps, rejection_reason). Indexes: `(workspace, status)`, `(workspace, product)`, `(review_item, product)`, partial unique on `(workspace, review_item, product) WHERE status <> 'superseded'`.
- [x] **P8-02.** Engine + service. `outreach-engine.ts` exposes `composeRulesDraft` (deterministic template) and `composeAiDraft` (calls `IAIProvider.generateText` with a structured prompt). Both modes run forbidden-phrase stripping. `outreach.ts` provides `generateOutreachDraft` (resolves the pair, retrieves outreach lessons workspace+product scoped, supersedes prior draft in transaction, audit-logs), plus `editOutreachDraft` (re-runs strip on user-supplied body), `approveOutreachDraft`, `rejectOutreachDraft`, `archiveOutreachDraft` (admin), `listOutreachDrafts`, `getOutreachDraft`, `activeDraftFor`.
- [x] **P8-03.** Server actions inlined per the existing pattern (no separate file). `/review/[id]` carries `generateDraft`; `/drafts/[id]` carries `saveEdits`, `approve`, `reject`, `regenerate`, `archive`. All declared with `'use server'`, role-gated through the service layer.
- [x] **P8-04.** Tests in `src/tests/outreach.test.ts` (24 cases): pure engine (rules + AI), forbidden-phrase audit trail, lesson-injection scoping, AI confidence drop on stripped phrases, DB-backed generate/supersede/edit/approve/reject lifecycle, terminal-status conflict, role gates (canWrite for generate, canAdminWorkspace for archive), workspace isolation on list + get + cross-workspace generate. **213/213 total tests pass.**
- [x] **P8-05.** UI: `/drafts` (list with status + product filters), `/drafts/[id]` (subject + body editor with inline save, approve/reject buttons, regenerate-with-method dropdown, admin archive). Per-qualification "Generate draft" button on `/review/[id]` with method picker; if an active draft exists the button becomes "Regenerate" plus a direct "Open draft" link. Dashboard linked.
- [x] **P8-06.** Deployed 2026-05-02. SHA `a2f91df`. Migration `0007_dusty_wrecker.sql` applied (outreach_drafts table live, 0 rows). All 3 services healthy. Sancho hit `tsx: command not found` running `npm run db:migrate` inside the container; host-side `pnpm db:migrate` worked first try — saved as a feedback memory so future Phase X-Y6 deploys default to host-side migrate.

**Phase 8 complete.**

## Phase 9 — Document Storage

**Goal.** Upload, tag, list documents. Wrap them and external URLs as
"knowledge sources" attachable to product profiles, ready for future RAG
phases. Storage backend swappable between local FS (dev) and S3-compatible
(prod) via `STORAGE_PROVIDER` env.

**Design lock (2026-05-02):** The `documents` table is pure file metadata
(name, mime, size, sha256, storage_key, tags, status). The
`knowledge_sources` table is the unifying abstraction for "things this
workspace knows" — a knowledge source is one of `document | url | text`. It
attaches to product profiles via `product_profile_ids bigint[]`. Future
phases (chunking, embeddings, RAG retrieval) read these rows. Bytes never
leave IStorage; metadata never leaves Drizzle.

- [x] **P9-01.** `documents` + `knowledge_sources` schema (migration `0008_mixed_rogue.sql`). `document_status` enum (uploading | ready | failed | archived); `knowledge_source_kind` enum (document | url | text). Indexes: documents on workspace, (workspace, sha256) for dedup detection, (workspace, status); knowledge_sources on workspace and (workspace, kind).
- [x] **P9-02.** S3-compatible IStorage implementation (`src/lib/storage/s3.ts`). Works against AWS S3, Hetzner Object Storage, Cloudflare R2, MinIO. Configured via env: `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`/`AWS_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`/`AWS_SECRET_ACCESS_KEY`, optional `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL`. Factory in `src/lib/storage/index.ts` lazy-imports the s3 module so the AWS SDK doesn't load when local provider is used. 11 storage tests cover both backends. Deps: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
- [x] **P9-03.** Documents + knowledge sources services. `documents.ts` provides `uploadDocument` (computes sha256, generates `workspaces/<id>/documents/<uuid>.<ext>` key, audit-logs), `listDocuments`, `getDocument` (returns signed URL), `streamDocument` (Readable for direct serving), `updateDocument`, `archiveDocument` / `restoreDocument` (admin). `knowledge-sources.ts` handles all three kinds with kind-specific shape validation, cross-workspace document rejection, postgres array-membership for product filtering.
- [x] **P9-04.** Tests in `src/tests/storage.test.ts` (11 cases) + `src/tests/documents.test.ts` (22 cases). Covers: local + S3 storage backends, env parsing, key-traversal rejection, upload + stream round-trips, tag sanitization, viewer-denied uploads, archive doesn't delete bytes, knowledge source kind validation (document/url/text), cross-workspace isolation, product-attachment filtering. **246/246 total tests pass.**
- [x] **P9-05.** UI: `/documents` (upload form + library list with archived toggle), `/documents/[id]` (metadata, download link, name+tags edit, knowledge sources referencing this doc, admin archive/restore), `/knowledge` (list with kind + product filters, "New source" button), `/knowledge/new` (kind switch, kind-specific fields, multi-product attachment), `/knowledge/[id]` (detail + edit + admin delete). Dashboard linked.
- [x] **P9-06.** Deployed 2026-05-02. SHA `e7ced89`. Migration `0008_mixed_rogue.sql` applied (documents + knowledge_sources tables live, both confirmed via `\dt`). Storage stays on `STORAGE_PROVIDER=local` for now — when user provisions a Hetzner Object Storage bucket and sets `S3_*` env, flipping `STORAGE_PROVIDER=s3` is a single env change with no code redeploy. Wandizz on :3000 untouched. Host-side `pnpm db:migrate` per the operational memory.

**Phase 9 complete.**

## Phase 10 — Mailing Client

**Goal.** Configure a mailbox, send and receive email through it, with thread
view and signatures. **Manual sending only.** Drafts go via human approval —
the Phase 8 outreach flow can hand an approved draft to the mailbox compose
screen, and Phase 10 takes it from there.

**Design lock (2026-05-02):** SMTP + IMAP credentials stored encrypted in
`workspace_secrets`; only opaque secret keys live on the `mailboxes` row.
Threading is best-effort header-based: the engine first tries to stitch via
References / In-Reply-To against any prior message in the same workspace +
mailbox, then falls back to a normalized-subject hash. Suppression list is
checked on every outbound recipient — a hard suppression aborts the send
before the SMTP layer is touched. The IMailProvider abstraction has a
MockMailProvider for tests so no real SMTP/IMAP is required to exercise the
service.

- [x] **P10-01.** Schema (migration `0009_blushing_kid_colt.sql`): mailboxes (with status enum + isDefault flag), mail_threads (with cached message_count + lastMessageAt + participants[]), mail_messages (with direction + status enums, RFC-5322 message_id unique-on-workspace), signatures, suppression_list (with TTL-aware isSuppressed). Indexes for queue lookups and threading.
- [x] **P10-02.** `IMailProvider` abstraction (`src/lib/mail/index.ts`) with `MockMailProvider` for tests; `SmtpImapMailProvider` (`src/lib/mail/smtp-imap.ts`) using nodemailer (SMTP send + verify) + imapflow (IMAP fetch) + mailparser. Lazy-imported by the factory so the real libs only enter the bundle when a real mailbox is wired up. Deps via pnpm.
- [x] **P10-03.** Services: `mailbox.ts` (CRUD with secret-key reservation per UUID slot, default uniqueness, `buildProviderFor` seam, `testMailboxConnection`), `mail.ts` (sendMessage with suppression check + threading + audit, syncInbound with message_id dedup, listThreads/getThread/getMessage), `suppression.ts` (add/remove/list/isSuppressed with TTL), `signatures.ts` (CRUD with default-uniqueness scoping per mailbox|workspace).
- [x] **P10-04.** Tests in `src/tests/mailing.test.ts` (25 cases): suppression TTL, mailbox secret-key encoding (regex-asserted, no cleartext on row), default uniqueness, archive clears default, testMailboxConnection updates status, signatures default-scoping, send rejects suppressed before hitting provider, two outbound messages with same References thread together, syncInbound dedups by message_id, workspace isolation across all five tables. **271/271 total tests pass.**
- [x] **P10-05.** UI: `/mailbox` (list of mailboxes), `/mailbox/new` (create with full SMTP+IMAP form), `/mailbox/[id]` (mailbox detail with test/sync buttons + threads list), `/mailbox/[id]/edit` (rotate passwords without persisting cleartext, settings change), `/mailbox/[id]/compose` (new outbound, default signature auto-appended), `/mailbox/threads/[id]` (thread view with inbound/outbound styling + reply form that preserves References), `/mailbox/signatures` (CRUD with workspace-wide and mailbox-scoped sections), `/mailbox/suppression` (add/remove/list with reason + TTL). Dashboard linked.
- [x] **P10-06.** Deployed 2026-05-02. SHA `6b57f51`. Migration `0009_blushing_kid_colt.sql` applied. All five mailing tables live on prod. All 3 services healthy on their existing ports; wandizz untouched on :3000. Real SMTP/IMAP credentials stay unset for now — mailbox stays in 'paused' state until user provisions an IMAP/SMTP account; once env'd in, `/mailbox/new` plus the test-connection button are ready.

**Phase 10 complete.**

## Phase 11 — Qualified Leads pipeline

**Goal.** Separate raw discovery from a commercial leads pipeline with the
nine-state journey from `raw_discovered` to `closed`. Promotion from /leads
into /pipeline is explicit; future automation will hook auto-transitions
(e.g., outbound-sent → `contacted`, inbound-received → `replied`).

**Design lock (2026-05-02):** transitions are forward-only by default;
non-forward moves require `force:true` AND `canAdminWorkspace`. Closing
demands a `close_reason`. Every mutation appends to `pipeline_events` so the
audit trail and the UI history panel share a single source of truth.

- [x] **P11-01.** Schema (migration `0010_petite_payback.sql`): `qualified_leads` + `pipeline_events`. Per-state timestamps, contact info columns (filled at `contact_identified`), assignment, CRM linkage columns reserved for Phase 13, close_reason enum (won|lost|no_response|wrong_fit|duplicate|spam|other), tags[], notes. Unique on (workspace, review_item, product_profile). Indexes on (workspace, state), (workspace, product), (workspace, assigned_to).
- [x] **P11-02.** State machine service (`src/lib/services/pipeline.ts`). `ensureQualifiedLead` (idempotent), `transition` (forward map enforced; admin-only force; close requires reason), `updateContact` (email validated + lowercased), `assign`, `setNotes`, `listLeads`, `getLead` (with event history), `getStateCounts`. Every mutation emits a pipeline_event (creation | transition | contact_update | assignment | note) plus an audit_log entry.
- [x] **P11-03.** Tests in `src/tests/pipeline.test.ts` (16 cases): ensure idempotency + cross-workspace rejection + viewer gate, full canonical-path walk through every state, non-forward refused without force, admin can force / member cannot, close-without-reason rejected, no-op re-transition, contact email validation, assignment + clear, notes trim, list filters by state + product, getStateCounts aggregation, getLead joined detail + event history, workspace isolation. **287/287 total tests pass.**
- [x] **P11-04.** UI: `/pipeline` (list + kanban toggle, state + product filters, stage counts), `/pipeline/[id]` (state-transition buttons honoring the forward map, close form with reason picker, admin force-transition details panel, contact form, assignment, notes, full timeline of pipeline_events). `Promote to pipeline` button on `/leads` for relevant qualifications. Dashboard linked.
- [x] **P11-05.** Deployed 2026-05-02. SHA `86456da`. Migration `0010_petite_payback.sql` applied (qualified_leads + pipeline_events tables live). All 3 services healthy on existing ports; wandizz untouched on :3000.

**Phase 11 complete.**

## Phase 12 — Document Knowledge / RAG

**Goal.** Retrieval-augmented generation: chunk + embed knowledge, retrieve
top-k by cosine similarity, ground reply drafting on workspace knowledge.

**Design lock (2026-05-02):** pgvector via the `pgvector/pgvector:pg17`
image. Embeddings fixed at 1536 dimensions to match OpenAI
text-embedding-3-small (the cheapest credible default; same dim as
text-embedding-ada-002 for migration). HNSW indexes with cosine ops on both
`document_chunks.embedding` and `learning_lessons.embedding`. Mock embedding
provider produces deterministic unit vectors so tests exercise the full
indexing + retrieval path without external API calls.

- [x] **P12-01.** pgvector + schema (migration `0011_demonic_human_fly.sql`). `document_chunks` (per-chunk content + embedding + metadata, scoped to document OR knowledge_source), `indexing_jobs` (operational status). Additive `embedding`/`embedding_model`/`embedding_dim`/`embedded_at` columns on `learning_lessons`. Custom Drizzle `vector(1536)` type. HNSW indexes hand-edited into the migration since drizzle-kit doesn't yet support `USING hnsw`. Compose images upgraded to `pgvector/pgvector:pg17` (base + prod).
- [x] **P12-02.** Embeddings provider abstraction (`src/lib/embeddings/index.ts`) with `MockEmbeddingProvider` (deterministic 1536-dim unit vectors via sha256-seeded expansion) and `OpenAIEmbeddingProvider` (text-embedding-3-small via /v1/embeddings, 30s timeout, `OPENAI_API_KEY` / `EMBEDDING_API_KEY` fallback). `EMBEDDING_PROVIDER` env switches; cosineSimilarity helper exported.
- [x] **P12-03.** RAG service (`src/lib/services/rag.ts`): `chunkText` (~2000 char with sentence-boundary preference + 200 char overlap, 1000-chunk cap), text extraction (text/json + html stripping + UTF-8 sniff for unknown mimes), `indexDocument` / `indexKnowledgeSource` (drop-and-replace re-index, batched embed at 64/req, indexing_job logging), `embedLesson` / `embedAllLessons` (populate the new lesson columns), `retrieve` / `retrieveLessons` (cosine `<=>` ORDER BY with optional product-scope filter), `listIndexingJobs` / `listChunksForDocument` for the UI.
- [x] **P12-04.** Tests in `src/tests/rag.test.ts` (19) + `src/tests/reply-assistant.test.ts` (4). 23 cases across chunking unit tests, mock embedder unit-vector + determinism properties, full document indexing pipeline, mime rejection with failed-job audit, role gates, cross-workspace isolation, retrieve top-k ordering + product filtering + empty-query short-circuit, lesson embedding round-trip, reply assistant prompt assembly + sources tracking. **310/310 total tests pass.**
- [x] **P12-05.** Technical reply assistant (`src/lib/services/reply-assistant.ts`). Pulls the most-recent inbound message in a thread, retrieves top-k chunks + lessons, builds a structured prompt with explicit `<chunk>` blocks for the AI to ground on, calls `IAIProvider.generateText`. Wired into `/mailbox/threads/[id]` as a "Suggest reply (RAG)" button that pre-fills the reply textarea via search-param round trip. Re-index buttons added to `/documents/[id]` and `/knowledge/[id]` with the indexing-job timeline below each.
- [x] **P12-06.** Deployed 2026-05-02. SHA `da6c5e5`. Postgres image swapped from `postgres:17-alpine` to `pgvector/pgvector:pg17` (volume data persisted across the swap). Migration `0011_demonic_human_fly.sql` applied: vector extension active, document_chunks + indexing_jobs tables live, learning_lessons.embedding column added, HNSW indexes built. App + postgres + redis healthy on existing ports; wandizz untouched on :3000. EMBEDDING_PROVIDER stays on `mock` until a workspace provisions OpenAI keys (or BYOK lands).

**Phase 12 complete.**

## Phase 13 — CRM / Export

**Goal.** Export approved leads to CSV (file download) and push them to
HubSpot via a real API adapter. Future CRM systems plug in behind the same
`ICRMConnector` shape.

**Design lock (2026-05-02):** CSV export is a pseudo-CRM connector — the
same `push()` shape, but the service writes the bundled CSV to IStorage
and surfaces a download URL. HubSpot uses Bearer-token auth with the
private-app PAT; the token lives in `workspace_secrets`. State-advance is
opt-in: a successful push can transition the lead to `synced_to_crm` with
`crmExternalId` + `crmSystem` populated, but the operator drives that
choice via a checkbox on the push form.

- [x] **P13-01.** Schema (migration `0012_workable_senator_kelly.sql`): `crm_connections` (per-workspace per-system, credential as a secret-key reference, status enum, lastSyncedAt/lastError) + `crm_sync_log` (one row per push, externalId for the upsert path, payload + response audit jsonb, partial unique index limits one pending entry per (lead, connection)).
- [x] **P13-02.** `ICRMConnector` abstraction (`src/lib/crm/index.ts`) with `CsvCrmConnector` (no remote calls — normalizes the row for bulk export) and `HubspotCrmConnector` (POST/PATCH `/crm/v3/objects/contacts` with Bearer token, 20s timeout, status-code + body capture for audit). State → hs_lead_status mapping; lead/product fields → standard HubSpot properties + `lead_platform_*` custom props for traceability. CSV helpers (`csvRowFor`, `rowsToCsv` with RFC-4180 quoting).
- [x] **P13-03.** Service (`src/lib/services/crm.ts`): create/update/archive connection (admin-only with credential rotation through `setSecret`), `testCrmConnection` (status + lastError side-effects), `pushLeadToCrm` (loads prior succeeded sync to reuse externalId, audit-logs every push, optional state advance), `exportLeadsToCsv` (state + product filters, writes to IStorage with download Content-Disposition), `listSyncEntries`.
- [x] **P13-04.** Tests in `src/tests/crm.test.ts` (16 cases): CSV escaping (commas/quotes/newlines), connection CRUD (admin gates, unknown-system rejection, credential never persisted as cleartext, credential rotation), testCrmConnection status sync, pushLeadToCrm (sync entry persistence, prior externalId reuse on second push, failure → connection failing + error capture, advanceState path, cross-workspace refusal), bulk CSV export (file written to storage, state filter narrows, workspace isolation), listSyncEntries scoping. **326/326 total tests pass.**
- [x] **P13-05.** UI: `/settings/crm` (list + Quick CSV export button + connection cards), `/settings/crm/new` (system + name + credential + base-URL form), `/settings/crm/[id]` (settings edit with credential rotate, Test connection, recent syncs timeline, admin archive). `/pipeline/[id]` extended with a CRM section: connection picker + advance-state checkbox + recent-syncs timeline. SettingsNav extended with the CRM tab.
- [x] **P13-06.** Deployed 2026-05-02. SHA `58e828c`. Migration `0012_workable_senator_kelly.sql` applied; crm_connections + crm_sync_log live. All 3 services healthy; wandizz untouched. CSV exports work out of the box (storage URL via the local provider for now); HubSpot stays unconfigured until a workspace adds a CRM connection with a real PAT.

**Phase 13 complete.**

## Phase 14 — God Mode

**Goal.** Platform-admin views: workspace list, usage analytics, impersonation
with full audit, premium-module enable/disable.

**Design lock (2026-05-02):** super-admin status lives on `users.role` (the
existing `user_role` enum); workspace-member roles are unaffected.
Impersonation is a server-side construct backed by `impersonation_sessions`
— the actor's user_id stays on every audit_log entry, so an impersonated
action always traces back to the super-admin who triggered it. Feature
flags are workspace-scoped boolean toggles with optional config jsonb,
upserted on (workspace, key).

- [x] **P14-01.** Schema (migration `0013_loud_wendigo.sql`): `impersonation_sessions` (actor + target + workspace + reason + start/end timestamps; partial unique index forces at most one active session per actor) and `feature_flags` (per-workspace per-key boolean + config jsonb). `isSuperAdmin(ctx)` helper added in `src/lib/services/context.ts`.
- [x] **P14-02.** Admin service (`src/lib/services/admin.ts`): every operation calls `assertSuperAdmin(ctx, op)` first. `listAllWorkspaces` (member count + lead count + total usage cost via aggregate queries), `startImpersonation` (verifies target is a workspace member; auto-closes prior active session by the same actor; audit-logs into the target workspace), `endImpersonation`, `listImpersonationSessions(activeOnly?)`, `activeImpersonationFor(userId)`, `setFeatureFlag` (key shape `[a-z][a-z0-9_.]*` enforced; upserts), `listFeatureFlags`, `listAllUsers`, `recentAuditAcrossWorkspaces`.
- [x] **P14-03.** Tests in `src/tests/admin.test.ts` (10 cases): every admin operation rejects non-super_admin actors; listAllWorkspaces returns aggregated metrics; impersonation start + end flow with audit trail; second start by same actor closes prior; cross-workspace target rejection; double-end rejected; activeOnly filter on session list; feature flag upsert behavior + key shape validation + workspace scoping. **336/336 total tests pass.**
- [x] **P14-04.** UI: `/admin` (workspace list with metrics, active impersonation sessions panel, recent platform-wide audit feed), `/admin/workspaces/[id]` (member list with per-member Impersonate form + reason input, active-impersonation banner with End button, feature-flag matrix for the known keys: crm.hubspot, rag.openai, outreach.send, mailbox.imap_sync, connector.serpapi). Dashboard exposes the Admin link only when `session.user.role === 'super_admin'`.
- [x] **P14-05.** Deployed 2026-05-02. SHA `a506b67`. Migration `0013_loud_wendigo.sql` applied; impersonation_sessions + feature_flags live. All 3 services healthy on existing ports; wandizz untouched. The bootstrap super-admin (jb.poltrade@gmail.com) now sees an "Admin (god mode)" link on the dashboard.

**Phase 14 complete.**

## Roadmap status (2026-05-02)

All 14 phases shipped end-to-end. The application is feature-complete per the
locked roadmap. Bring-your-own provider keys (OpenAI, HubSpot PAT, SerpAPI,
SMTP/IMAP) are the gating items for full production use. The S3 storage
backend stays opt-in via env (STORAGE_PROVIDER=s3 + Hetzner/MinIO/R2/AWS
credentials).

## Phase 15 — User management lifecycle + sidebar

- [x] **P15-01.** Schema (migration `0014_giant_blindfold.sql`): `users.account_status` enum (pending|active|suspended|rejected) + `preauthorized_emails` table.
- [x] **P15-02.** `src/lib/services/users.ts`: preauthorize, setAccountStatus, member CRUD with last-owner protection. Pre-authorize path in Auth.js `signIn` callback flips matching emails to `active` automatically.
- [x] **P15-03.** `AccountInactiveError` gate in `getWorkspaceContext`; `/pending` page for non-active accounts.
- [x] **P15-04.** Admin UI: `/admin/users` (status changes), `/settings/members` (workspace member CRUD, last-owner protection).
- [x] **P15-05.** Sidebar component (`AppShell`/`Sidebar`) with PINNED/SECONDARY/SETTINGS sections + Admin section gated on super_admin.
- [x] **P15-06.** 19 tests in `src/tests/users.test.ts`.

**Phase 15 complete.**

## Phase 16 — Contacts module

- [x] **P16-01.** Schema (migration `0015_fair_vengeance.sql`): `contacts` (workspace-scoped, email-deduped) + `contact_associations` (polymorphic entity_type/entity_id). Backfill from `qualified_leads.contactEmail` so existing pipeline rows get a contact.
- [x] **P16-02.** `src/lib/services/contacts.ts`: upsertContact (sparse merge — never blanks set fields), mergeContacts (re-points associations and audit-logs both rows). `mail_messages.contact_id` denormalized for inbox queries.
- [x] **P16-03.** Wired into `pipeline.updateContact`, `mail.sendMessage`, `mail.persistInbound` so contact resolution is automatic.
- [x] **P16-04.** UI: `/contacts` list + `/contacts/[id]` detail with linked outreach communication.
- [x] **P16-05.** 14 tests in `src/tests/contacts.test.ts`.

**Phase 16 complete.**

## Phase 17 — Structured signatures + suppression upgrades

- [x] **P17-01.** Schema (migration `0016_steep_terror.sql`): added structured signature columns (name/title/phone/email/website/linkedin/photo) + suppression `kind` enum (email|domain|company) + `value` column. Backfill suppression `value` from existing addresses.
- [x] **P17-02.** `signatures.ts`: structured fields + `renderSignatureHtml`/`renderSignatureText` helpers. `mail.sendMessage` now appends the default signature.
- [x] **P17-03.** Kind-aware `addSuppression` + `isSuppressed` (email + domain + company) + `recordBounce` helper. `mail.sendMessage` auto-bounce-suppresses on SMTP error responseCode.
- [x] **P17-04.** UI: `/mailbox/suppression` kind selector + structured-fields fieldset on `/mailbox/signatures`.
- [x] **P17-05.** 15 tests in `src/tests/suppression-p17.test.ts`.

**Phase 17 complete.**

## Phase 18 — CRM extensions: notes + deals

- [x] **P18-01.** Schema (migration `0017_bumpy_the_order.sql`): `crm_sync_kind` enum (contact|note|deal) + `kind`/`related_message_id` columns on `crm_sync_log`.
- [x] **P18-02.** Extended `ICRMConnector` with `pushNote` + `pushDeal`; HubSpot implementations use HUBSPOT_DEFINED association typeIds for note↔contact and deal↔contact.
- [x] **P18-03.** Service layer: `pushThreadAsNotes` (one note per thread message), `pushDeal` from a qualified lead.
- [x] **P18-04.** `/pipeline/[id]` exposes Push notes / Push deal buttons + thread picker.
- [x] **P18-05.** 5 tests in `src/tests/crm-p18.test.ts`.

**Phase 18 complete.**

## Phase 19 — Send queue + scheduling

- [x] **P19-01.** Schema (migration `0018_dashing_cannonball.sql`): `outreach_queue` (queued/sending/sent/failed/skipped/cancelled) + `outreach_send_settings` (daily cap, domain cooldown, delay mode, emergency pause).
- [x] **P19-02.** `outreach-queue.ts` enqueue + claim + dispatch with delay-mode-aware `scheduledSendAt` (immediate/fixed/random) and pre-send guards (suppression, daily cap, domain cooldown).
- [x] **P19-03.** UI: `/mailbox/queue` (queue view + status filters + cancel) + Enqueue-for-send form on `/drafts/[id]`.
- [x] **P19-04.** 13 tests in `src/tests/outreach-queue.test.ts`.

**Phase 19 complete.**

## Phase 20 — Reply classification + autonomous handoff

- [x] **P20-01.** Schema (migration `0019_fantastic_skrulls.sql`): `mail_messages.reply_classification` + confidence + extracted_emails + `reply_auto_actions` table.
- [x] **P20-02.** `reply-classifier.ts`: heuristic-first PATTERNS (unsubscribe / bounce / out_of_office / negative / interest / positive / redirect / doc_request / question / irrelevant) with optional AI override. `analyseReply` persists classification + executes auto-actions (suppress/notify_owner/wait_retry).
- [x] **P20-03.** Wired synchronously into `mail.persistInbound` so every inbound is classified at receive time.
- [x] **P20-04.** 18 tests in `src/tests/reply-classifier.test.ts` using a synthetic-insert helper that bypasses the slow startRun chain.

**Phase 20 complete.**

## Phase 21 — Autopilot

- [x] **P21-01.** Schema (migration `0020_mighty_caretaker.sql`): `autopilot_settings` (toggles + per-step gates + thresholds + emergency pause) + `autopilot_log` (run_id-grouped).
- [x] **P21-02.** `autopilot.ts` `runOnce` orchestrator with 6 gated steps: discovery → review-auto-approve → draft generation → draft auto-approve → enqueue → CRM push. Each step honours its own enabled flag; emergency pause halts everything.
- [x] **P21-03.** UI: `/autopilot` (settings + recent run log).
- [x] **P21-04.** 9 tests in `src/tests/autopilot.test.ts`.

**Phase 21 complete.**

## Phase 22 — Hints + tracking pixel + knowledge purpose categories

- [x] **P22-01.** Schema (migration `0021_mean_maginty.sql`): `knowledge_purpose_category` enum (technical|marketing|case_study|internal_note|objection_handling|general) + `purpose_category` column on `knowledge_sources`. `email_opens` table + `mail_messages.tracking_token`/`open_count`/`first_opened_at` for open tracking.
- [x] **P22-02.** `hints.ts`: derived (non-persisted) UX context — `hintsForLead` (product_fit, next_action, pending_approval), `hintsForThread` (last reply classification), `hintsForDraft` (ai_generated, forbidden_stripped, send_scheduled/sent/failed), `leadStateSummary`.
- [x] **P22-03.** `<HintBadge>` + `<HintBadgeList>` components wired into `/pipeline` (list + kanban) and `/drafts` list.
- [x] **P22-04.** Tracking pixel: `mail.sendMessage` injects a 1×1 `<img>` pointing at `/api/track/<token>.gif`; the route records `email_opens` + bumps the message counter, always returns the GIF regardless of token validity.
- [x] **P22-05.** RAG: `purposeCategory` filter wired through `RetrieveOptions` + the actual SQL filter in `retrieve()`. `/knowledge/new` and `/knowledge/[id]` expose the dropdown; `knowledge-sources.update` accepts the new field.
- [x] **P22-06.** 13 tests in `src/tests/p22.test.ts`. **443/443 total tests pass.**

**Phase 22 complete.**

## Phase 23 — Persistent sidebar + workspace/user admin

- [x] **P23-01.** Schema (migration `0022_p23_workspace_status.sql`): `workspace_status` enum (active|archived) + 4 lifecycle columns on `workspaces`. Archived workspaces denied to non-super-admin members via auth-context filter.
- [x] **P23-02.** Sidebar reorganized into Discovery / Pipeline / Outreach / Administration / Emergency / Platform sections — client component using `usePathname()` for auto active-highlight. Emergency block visually distinct.
- [x] **P23-03.** `AppShell` promoted to a server component that fetches the session itself; 39 pages migrated from `BrandHeader+main` → `AppShell` for persistent sidebar.
- [x] **P23-04.** Super-admin features: workspace lifecycle (`/admin/workspaces` + `/admin/workspaces/[id]` archive/restore), user profile editing with case-insensitive collision check, cross-workspace memberships (`adminAddUserToWorkspace` / `adminRemoveUserFromWorkspace` / `listMembershipsForUser`) + `/admin/users/[id]` detail.
- [x] **P23-05.** 22 tests in `src/tests/p23.test.ts`. **465/465 total pass.**

**Phase 23 complete.**

## Phase 24 — Audit log viewers

- [x] **P24-01.** `/settings/audit` (workspace-scoped, admin-gated) + `/admin/audit` (platform-wide, super-admin only). Filters by kind / workspace / since / until / limit.
- [x] **P24-02.** `admin.ts`: `listAuditAcrossWorkspaces(filter)` + `distinctAuditKindsAcross()`. User + workspace names resolved in single round-trip per page.
- [x] **P24-03.** 6 tests in `src/tests/p24.test.ts`. **471/471 total pass.**

**Phase 24 complete.**

## Phase 25 — Workspace create + hard-delete

- [x] **P25-01.** `/admin/workspaces/new` — name + slug + owner picker. Reuses the bootstrap-path transactional create + emits `admin.workspace.create` audit.
- [x] **P25-02.** `/admin/workspaces/[id]` danger-zone delete (gated on `archived` status) — type-the-slug confirmation, cascading FKs sweep workspace-scoped tables. Audit-logged BEFORE delete so trail still references the id.
- [x] **P25-03.** Service: `adminCreateWorkspace` (slug normalization + collision + owner-existence + transactional create) and `deleteWorkspace` (refuses unless archived).
- [x] **P25-04.** 10 tests in `src/tests/p25.test.ts`. **481/481 total pass.**

**Phase 25 complete.**

## Phase 26 — User/workspace admin polish (Wandizz-inspired)

- [x] **P26-01.** `/admin/users` split into Pending review (amber accent) / Active / Suspended-rejected sections with counts.
- [x] **P26-02.** `/admin/workspaces/new` auto-derives slug from name as you type until the slug field is touched (`WorkspaceCreateForm` client component).
- [x] **P26-03.** `/admin/workspaces/[id]` members get inline role select with role icons (👑 owner / 🛡 admin / ⭐ manager / 👤 member / 👁 viewer).
- [x] **P26-04.** `/admin/users/[id]` 'Move between workspaces' atomic flow (pick source membership + destination + role; one transaction).
- [x] **P26-05.** Service: `adminSetMemberRole` (super-admin role change scoped by workspace, NOT by ctx) + `moveUserBetweenWorkspaces` (transactional, refuses last-owner moves and identical src+dst).
- [x] **P26-06.** 10 tests in `src/tests/p26.test.ts`. **491/491 total pass.**

**Phase 26 complete.**

## Phase 27 — Autopilot console redesign + per-product overrides

- [x] **P27-01.** Schema (migration `0023_p27_autopilot_product_overlay.sql`): `autopilot_product_settings` overlay table keyed by `(workspace_id, product_profile_id)` with nullable override columns. Workspace-only steps (sync inbound, drain queue) cannot be overridden.
- [x] **P27-02.** `/autopilot` redesign — Master strip (global enabled / 🛑 emergency pause / Run now), 7-step autonomous flow visualization, scope picker tabs (Workspace defaults | each product), tri-state (inherit / on / off) form per product, recent-activity log.
- [x] **P27-03.** Service: `getEffectiveAutopilotSettings(productId)` (merges workspace defaults + product overlay; NULLs inherit), `upsertProductAutopilotSettings`, `getProductAutopilotSettings`, `listProductAutopilotSettings`, `clearProductAutopilotSettings`.
- [x] **P27-04.** Orchestrator: `stepAutoApproveProjects`, `stepAutoEnqueueOutreach`, `stepAutoCrmContactSync`, `stepAutoCrmDealOnQualified` resolve effective settings per candidate's `productProfileId`. Per-product mailbox override routes outreach through product's preferred mailbox.
- [x] **P27-05.** 8 tests in `src/tests/p27.test.ts`. **499/499 total pass.**

**Phase 27 complete.**

## Phase 28 — Workspace switcher + default-workspace protection

- [x] **P28-01.** Schema (migration `0024_p28_active_workspace.sql`): `users.activeWorkspaceId` (nullable bigint FK → workspaces, ON DELETE SET NULL) + `workspaces.is_default` boolean.
- [x] **P28-02.** Auth-context: `getWorkspaceContext()` reads `users.activeWorkspaceId` and uses it when membership is still valid; otherwise falls back to first membership.
- [x] **P28-03.** Service: `listMyWorkspaces(userId)` (every workspace with `isActive` flag), `setActiveWorkspace(userId, wsId, opts)` (verifies membership; super-admin can pass `allowAnyAsSuperAdmin`).
- [x] **P28-04.** `setWorkspaceDefault(workspaceId, isDefault)` flips flag with audit, refuses archived workspaces. `archiveWorkspace`/`deleteWorkspace` refuse default workspaces. `adminRemoveUserFromWorkspace` clears stale active pointer; `moveUserBetweenWorkspaces` re-points to destination.
- [x] **P28-05.** UI: `<WorkspaceSwitcher>` client component in header (renders only if 2+ memberships) + 🔒 default badge on `/admin/workspaces` + 'Mark as default' toggle in lifecycle section.
- [x] **P28-06.** 11 tests in `src/tests/p28.test.ts`. **510/510 total pass.**

**Phase 28 complete.**

## Phase 29 — God-mode workspace switching for super-admin

- [x] **P29-01.** `listMyWorkspaces` gains `includeAllForSuperAdmin` option — appends every other workspace as a synthetic row with `role='super_admin'` + `isGodMode=true`.
- [x] **P29-02.** `<WorkspaceSwitcher>` renders memberships first under 'Member of', then 'God mode (other workspaces)' below. Trigger pill gets amber accent + 👁 icon when active workspace is god-mode.
- [x] **P29-03.** Picking a god-mode workspace prompts `confirm()` + audit-logs in target workspace via new `workspace.god_mode_switch` kind (visible in both `/admin/audit` and target's `/settings/audit`).
- [x] **P29-04.** 6 tests in `src/tests/p29.test.ts`. **516/516 total pass.**

**Phase 29 complete.**

## Phase 30 — Email + password auth (Wandizz-style team users)

- [x] **P30-01.** Schema (migration `0025_p30_password_hash.sql`): `users.passwordHash` text nullable. NULL = OAuth-only; set = password user. bcrypt 12 rounds via `bcryptjs`.
- [x] **P30-02.** Service: `createPasswordUser` (super-admin only; refuses dup email / short password / non-super caller; optional immediate workspace + role assignment), `verifyUserPassword` (case-insensitive lookup + bcrypt.compare; refuses non-active accounts), `setUserPassword` (super-admin or self; rotates hash and by default invalidates other sessions), `deleteUserGlobally` (super-admin only; refuses self/super/last-owner targets).
- [x] **P30-03.** `/api/auth/team-login` route — JSON POST {email, password} mints `sessions` row + sets `authjs.session-token` / `__Secure-authjs.session-token` cookie identical to OAuth path. `teamLoginAction` server action for the form. Shared `session-helpers.ts`: 32-byte token + 30-day expiry + cookie-name detection from `AUTH_URL`.
- [x] **P30-04.** UI: `/` login page shows email+password form below Google button; `/admin/users` 'Create user with password' panel; `/admin/users/[id]` Password section + Danger zone (type-email-confirm hard delete).
- [x] **P30-05.** 19 tests in `src/tests/p30.test.ts`. **535/535 total pass.** Deps: `bcryptjs ^3` + `@types/bcryptjs`.

**Phase 30 complete.**

## Phase 31 — Avatars + auth-method badges + self-service /settings/account

- [x] **P31-01.** `<UserAvatar>` component — initial-only circle with deterministic color hashed from email. Used on `/admin/users`, `/admin/users/[id]`, `/settings/account`.
- [x] **P31-02.** `/admin/users` rows get avatar + last-sign-in timestamp + 🔑 password / 🔵 google badge per row. `/admin/users/[id]` header gets the same.
- [x] **P31-03.** `/settings/account` self-service page (in Administration sidebar group): change own display name; change own password (verifies current; OAuth-only users can leave old blank to set initial password and unlock email+password sign-in); read-only workspace memberships with active marker + 🔒 default badge.
- [x] **P31-04.** Service: `updateOwnProfile(ctx, { name })` + `changeOwnPassword(ctx, old, new)` (does NOT invalidate other sessions — user stays signed in).
- [x] **P31-05.** 8 tests in `src/tests/p31.test.ts`. **543/543 total pass.**

**Phase 31 complete.**

## Phase 32 — BYOK OpenAI key + ctx-aware embeddings provider

- [x] **P32-01.** `getEmbeddingProviderForCtx(ctx)` workspace-aware factory — reads `workspace.openai.apiKey` via `resolveProviderKey()`, constructs fresh `OpenAIEmbeddingProvider` with that key when set; falls back to env-cached singleton. Workspace overrides bypass cache so secret rotations take effect immediately.
- [x] **P32-02.** `rag.ts` callers updated: `indexDocument`, `indexKnowledgeSource`, `embedLesson`, `embedAllLessons`, `retrieve`, `retrieveLessons` all resolve via the ctx-aware factory.
- [x] **P32-03.** UI: `/settings/integrations` gets OpenAI section mirroring SerpAPI (effective-source banner / set workspace key / clear key, admin-gated).
- [x] **P32-04.** 5 tests in `src/tests/p32.test.ts`. **548/548 total pass.** Note: real OpenAI AI provider (chat) still TBD — this only wires embeddings.

**Phase 32 complete.**

## Phase 33 — Real AI providers (OpenAI + Anthropic) with BYOK

- [x] **P33-01.** `OpenAIAIProvider` — `/v1/chat/completions`, default `gpt-4o-mini`, `response_format=json_object` for `generateJson`, cost table for gpt-4o-mini and gpt-4o (Dec 2025 pricing).
- [x] **P33-02.** `AnthropicAIProvider` — `/v1/messages`, default `claude-haiku-4-5`. `generateJson` augments system prompt + strips stray code fences. Cost table for Haiku 4.5 + Sonnet 4. Both providers: 60s `AbortController` timeout + real token counts from API response.
- [x] **P33-03.** Factory: `getAIProvider()` switches on `AI_PROVIDER` (mock | openai | anthropic), env-cached. `getAIProviderForCtx(ctx)` workspace-aware variant — when active provider is real AND workspace has BYOK key, build fresh provider with that key. Mock path short-circuits.
- [x] **P33-04.** Caller wiring: `reply-assistant.ts` uses `getAIProviderForCtx(ctx)`. `outreach.ts composeVerdict` now takes `WorkspaceContext` and resolves provider per workspace; `method='hybrid'` upgrades from rules-fallback to real-AI body.
- [x] **P33-05.** UI: `/settings/integrations` Anthropic section mirroring OpenAI block. Page also shows active `AI_PROVIDER`. Note: prod env still on `AI_PROVIDER=mock` after deploy — operator-controlled flip.
- [x] **P33-06.** 14 tests in `src/tests/p33.test.ts`. **562/562 total pass.**

**Phase 33 complete.**

### Phase 33.5 — Paste-HTML signature option

- [x] **P33.5-01.** `/mailbox/signatures` New-signature form gets 'Custom HTML signature' textarea — when set, structured fields are ignored and exact markup is used in outbound HTML.
- [x] **P33.5-02.** Each existing signature row gets expandable 'Edit / replace custom HTML' panel showing current `bodyHtml` in monospace; saves via new `updateHtml` server action. Empty save reverts to auto-rendered.
- [x] **P33.5-03.** Signatures with custom HTML get a 'custom HTML' badge on the list. Drop a stray `@ts-expect-error` in `p33.test.ts` that didn't fire.

**Phase 33.5 complete.**

## Phase 34 — Background workers + repeatable cron ticks

- [x] **P34-01.** Three repeatable handlers: `autopilot.tick` (every 5 min), `outreach.drain.tick` (every 30 sec), `mail.imap.tick` (every 2 min). Each fans out across active workspaces serially and swallows per-tenant errors so one stuck workspace can't block the platform.
- [x] **P34-02.** Queue interface: `IJobQueue.enqueueRepeatable(type, payload, { everyMs, jobId })`. `InMemoryJobQueue` uses `setInterval` with `.unref` (test-safe). `BullMQJobQueue` uses `repeat: { every }` + removes prior repeatables on re-register so cadence changes take effect at next boot.
- [x] **P34-03.** Boot: Next.js `instrumentation.ts` calls `registerJobHandlers()` + `registerRepeatableJobs()` on every cold start. Skipped via `SCHEDULE_BACKGROUND_JOBS=0` for ephemeral CI / migration pods. Loud warning when `NODE_ENV=production` and `JOB_QUEUE_PROVIDER!=bullmq`.
- [x] **P34-04.** 7 tests in `src/tests/p34.test.ts`. **569/569 total pass.** Note: prod env still on `JOB_QUEUE_PROVIDER=memory` — durable scheduling needs `JOB_QUEUE_PROVIDER=bullmq` + `REDIS_URL=...` flip on agregat.

**Phase 34 complete.**

## Phase 35 — List-Unsubscribe header + public unsubscribe endpoint

- [x] **P35-01.** Outbound mail (`mail.ts sendMessage`): per-message unsubscribe URL reuses existing `trackingToken` (no new schema column). Two new headers on every send: `List-Unsubscribe: <https://.../api/unsubscribe/<token>>, <mailto:...?subject=unsubscribe>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. HTTPS first so Gmail/Yahoo prefer it.
- [x] **P35-02.** Visible footer rendered into both text + HTML bodies (CAN-SPAM requires conspicuous link). Plain-text gets separator + `Unsubscribe: <url>`; HTML gets a small grey link in a top-bordered footer.
- [x] **P35-03.** Public endpoint `/api/unsubscribe/[token]`: POST = RFC 8058 one-click (empty 200 on success or unknown token — never leaks token validity). GET = browser click; renders self-contained confirmation page listing suppressed addresses, no app shell.
- [x] **P35-04.** Service: `recordUnsubscribeByToken(token)` resolves token via `mailMessages.trackingToken`, lowercases recipients, upserts into `suppressionList` with `reason='unsubscribe'`. Idempotent via existing `(workspace, kind, value)` UNIQUE. Direct `audit_log` insert with `userId=null` (unauthenticated actor).
- [x] **P35-05.** 6 tests in `src/tests/p35.test.ts`. **575/575 total pass.** Deployed to prod 2026-05-04 after disk-full cleanup recovered 53GB.

**Phase 35 complete.**

## Phase 36 — Deliverability dashboard

- [x] **P36-01.** `src/lib/services/deliverability.ts` — pure read service. `getDeliverabilityReport(ctx, { sinceDays })` joins outbound `mail_messages` (sent/delivered/bounced/failed + open_count), inbound `mail_messages` (replies + reply_classification), workspace `suppression_list` (unsubscribe / bounce_hard / bounce_soft in window), and terminal `outreach_queue` rows (sent / skipped / failed). Per-mailbox breakdown + workspace totals + reply-classification roll-up. Window clamped to [1, 365] days.
- [x] **P36-02.** UI `/mailbox/deliverability` (linked from sidebar Outreach group). Window selector (7 / 30 / 90 days), workspace stat cards (sent / opens / replies / bounced / failed / unsubscribed / queue skipped / queue failed), per-mailbox table with rates, reply-classification cards, footer notes explaining what each metric means and the privacy-mode caveat for opens.
- [x] **P36-03.** 8 tests in `src/tests/p36.test.ts`. **583/583 total tests pass.** Coverage: empty workspace, per-mailbox aggregation, reply classification + unclassified bucket, suppression-by-reason, queue terminal-state counting (excludes queued/cancelled), time-window filtering, sinceDays clamp, workspace isolation.

**Phase 36 complete.**

## Phase 37 — Visual polish: lucide icons in sidebar + dashboard rewrite

- [x] **P37-01.** `lucide-react` added as a dependency (peer-deps clean for the project; nodemailer warning is pre-existing). Use `lucide-react` for all in-app iconography from here on.
- [x] **P37-02.** Sidebar: every NavItem now carries a topic-relevant Lucide icon. Active item gets a 2px accent rail on the left edge + tinted icon. Hover lifts icon colour from muted → fg.
- [x] **P37-03.** Dashboard rewrite: `<dl>` + `<ul>` replaced with `.page-intro` (eyebrow + title + lede) + `.profile-cards` row (paired elevated cards with role pills + radial accent) + 14-tile `.module-tile-grid`. Each module tile has a Lucide icon, tone-coloured icon pill, and hover-on-arrow microreaction.
- [x] **P37-04.** Reusable patterns added in globals.css: `.page-intro` / `.page-eyebrow` / `.page-title` / `.page-lede` / `.section-header` / `.section-title` / `.section-sub` / `.role-pill-{role}` / `.module-tile-grid` / `.module-tile` / `.module-tile-{tone}`. Subsequent pages adopt incrementally without churn.

**Phase 37 complete.**

## Phase 38 — Landing page hero pass

- [x] **P38-01.** `.landing-hero-bg-grid` (64px line grid masked by a radial fade) + `.landing-hero-glow` (two stacked radial gradients in primary blue + accent teal) for the public landing page.
- [x] **P38-02.** `.hero-badge` rounded pill with pulsing teal dot (`hero-pulse` 2s keyframe) + uppercased mono eyebrow text.
- [x] **P38-03.** `.hero-h1` grew to clamp(2.25rem, 5vw, 3.75rem) with `text-wrap: balance` for clean line breaks; `.hero-lede` similarly balanced.
- [x] **P38-04.** `.hero-cta-row`: primary 'Sign in with Google' (white pill with arrow that translates on hover) + secondary 'What\\'s inside' (border + backdrop-blur card style). Email/password sign-in folded into a `<details>` below the primary CTAs (`.hero-team-login`).
- [x] **P38-05.** Modules grid converted from 8 unstyled `.module-card` boxes to the same `.module-tile-grid` + `.module-tile-static` pattern as the dashboard, with Lucide icons per module (Network, ListChecks, Sparkles, PencilLine, Inbox, KanbanSquare, BookOpen, Download).

**Phase 38 complete.**

## Phase 39 — Page-intro pattern + lifted metric cards + data-table

- [x] **P39-01.** Naming reconciliation: `.page-header` (pre-existing) is the horizontal title-left / CTA-right flex bar — kept untouched. `.page-intro` (new) is the vertical eyebrow + title + lede stack — used inside `.page-header` on title-with-CTA pages or standalone on landing-style pages.
- [x] **P39-02.** Page-intro applied to /products (with Lucide Plus icon on the 'New product' CTA), /pipeline, /drafts, /dashboard.
- [x] **P39-03.** /mailbox/deliverability rewrite: inline styles replaced with `.metric-grid` + `<MetricCard>` (Lucide icons + tone tokens) + `.data-table` (uppercase mono headers, hover row tint, tabular-nums, `.num` right-align utility) + `.reply-class-grid` + `.empty-state` + `.metric-notes`. Bounce/Failed/Queue-failed cards flip to warn tone when non-zero.
- [x] **P39-04.** Shared patterns added to globals.css: `.metric-card` / `.metric-card-{tone}` (6 tones: primary, teal, amber, violet, warn, muted), `.data-table`, `.empty-state`, `.window-tabs` / `.window-tab`, `.reply-class-grid` / `.reply-class-card`, `.metric-notes`. `.primary-btn` flexes children with gap so an icon + label render cleanly side-by-side; hover gains `transform: translateY(-1px)`.

**Phase 39 complete.**

## Phase 40 — Profile-list as cards + leads/review/mailbox page-intro

- [x] **P40-01.** `.profile-list` reskin: each `<li>` is now a self-contained card (soft border + brand-card bg + hover lift). Touches every list-of-things view (/products, /admin/users, /admin/users/[id], /admin/workspaces, /admin/workspaces/[id], /admin, /connectors/.../runs/[runId], /mailbox). No markup change — child shape preserved so all consumers benefit without per-page rewrites. Same hover-lift treatment also applied to `.lead-list li`.
- [x] **P40-02.** Page-intro applied to /leads, /review, /mailbox so they match dashboard / pipeline / drafts. /mailbox keeps its CTA pattern: `.page-header` outer flex with `.page-intro` on the title side and a `.primary-btn` (now with Plus icon) on the right. Empty state replaced with the `.empty-state` card pattern + Inbox icon.

**Phase 40 complete.**

## Phase 41 — Translation system (kompas port)

- [x] **P41a-01.** `src/lib/i18n/language.ts` — pure module, no DB / AI / server-only imports. `LANGUAGE_NAMES` (31 ISO codes), `getLanguageName()` with region-tag stripping + fallback, `isKnownLanguage()`, `detectLanguageFromText()` (regex word-frequency markers for pl/en/de/fr/es/it/ro + diacritic boosts for pl/de/fr/ro, confidence floor 6, 20-char minimum), `resolveProfileLanguage()` cascade (fullDescription → shortDescription → outreachInstructions → negativeOutreachInstructions → explicit `language` → `'en'`). Detection BEATS the explicit field by design — kompas's reproducer was operators pasting a foreign description but forgetting to flip the dropdown.
- [x] **P41a-02.** `outreach-engine.ts` and `outreach.ts` now resolve language via `resolveProfileLanguage()` and pass the human-readable language name (e.g. 'Polish (pl)') into the LLM system prompt with an explicit fluency + proper-noun-preservation rule mirroring the kompas prompt.
- [x] **P41a-03.** `src/app/products/_form.tsx`: free-form `<input>` for language replaced with a `<select>` of every supported language (alphabetised by name). New `<LanguageHint>` component renders under the picker showing what the detector reads from the description; when detector and explicit field disagree the hint flips amber.
- [x] **P41a-04.** 21 tests in `src/tests/language.test.ts`. **583/583 → 604/604 total tests pass.**

- [x] **P41b-01.** Schema (migration `0026_mixed_colleen_wing.sql`): adds `mail_messages.body_text_en` + `translated_from_language` + `translated_at` for cached inbound translations. No table changes — single ALTER on the existing mail_messages table.
- [x] **P41b-02.** `src/lib/services/translation.ts` — `translateToEnglish(ctx, { text, sourceLanguageHint? })` (stateless, audit-logged), `translateFromEnglish(ctx, { text, targetLanguage })` (stateless, short-circuits when target is `en`/`en-*`, audit-logged), `translateInboundToEnglish(ctx, messageId)` (cached on the row, idempotent — second call is a no-op no-bill, refuses outbound messages and empty bodies and cross-workspace access). All routes use `getAIProviderForCtx(ctx)` so workspace BYOK keys are honoured.
- [x] **P41b-03.** `/mailbox/threads/[id]` UI: per-inbound-message 'Translate to English' button (calls `translateInboundToEnglish` server action). When the cache is hit, renders an expandable `<details>` titled e.g. 'English translation from Polish' below the original. Reply form gets a 'Translate before send' second submit button (using `formAction` to route to a separate server action) + a target-language dropdown; on click the form posts to `translateReply` which redirects with `?translatedReply=...&translatedTo=...` and pre-fills the textarea. New CSS: `.msg-translation`, `.msg-translation-icon`, `.draft-body-translated`, `.translate-inline`.
- [x] **P41b-04.** 12 tests in `src/tests/translation.test.ts` covering toEnglish (audit emit, empty + oversized rejection), fromEnglish (real translate, en short-circuit, en-GB short-circuit, lowercase normalisation), translateInboundToEnglish (cache populates, second-call no-op, outbound refusal, empty refusal, cross-workspace refusal). **604/604 → 616/616 total tests pass.**

**Phase 41 complete.**

Note: language-aware outreach generation (P41a-02) ships immediately on
deploy. Translation-on-demand (P41b) requires `AI_PROVIDER` to be flipped
from `mock` to `openai` or `anthropic` on prod for the actual translations
to be useful — currently the mock returns the input unchanged.

## Phase 42 — Auto-translate inbound + draft translate-and-save

- [x] **P42-01.** `maybeAutoTranslateInbound(ctx, messageId)` in `translation.ts`. Heuristic-gated using `detectLanguageFromText` so English mail short-circuits without billing the AI. Returns a typed outcome union (`translated` / `skipped:already_translated` / `skipped:already_english` / `skipped:undetermined` / `skipped:no_body` / `skipped:not_inbound` / `skipped:disabled` / `skipped:not_found`) so callers and tests can assert which branch fired. Honours `AUTO_TRANSLATE_INBOUND=0` env kill switch. Failures NEVER throw — runs inline with mail receipt and must not break the receive path.
- [x] **P42-02.** Wired into `mail.persistInbound` directly after the Phase 20 `analyseReply` call, sharing the same best-effort try/catch envelope. Console-logs but doesn't break receive on translator failures.
- [x] **P42-03.** `/drafts/[id]` UI: 'Translate to {language} & save' second submit button on the edit form (only renders when product's effective language is non-English). Server action calls `translateFromEnglish` with `resolveProfileLanguage(product)` as target then `editOutreachDraft` with the translated body, redirects with `?msg=translated-to-{lang}` for a teal info banner. `?msg=already-english` short-circuit when target resolves to English. `?error={msg}` on failure shows the existing `.form-error` style. New `.form-info` CSS class for the success banner.
- [x] **P42-04.** 6 tests added in `src/tests/translation.test.ts` covering `maybeAutoTranslateInbound`: translates Polish inbound, skips English (no audit emitted), skips ambiguous short text, skips outbound, skips when cache populated, honours the kill switch. **616/616 → 622/622 total tests pass.**

**Phase 42 complete.**

## Phase 43 — Mailbox sending policy (kompas-style)

- [x] **P43-01.** Schema (migration `0027_crazy_frank_castle.sql`, idempotent CREATE TABLE IF NOT EXISTS + DO-block constraint adders + ALTER COLUMN converger): new `mailbox_sending_limits` table keyed 1:1 to mailboxes. Holds quantity caps (`maxPerDay`, `maxPerHour`, `maxPerDomain`), delay envelope (`minDelaySeconds`..`maxDelaySeconds`), business window (`businessHoursOnly`, `businessStartHour`/`businessEndHour`, `businessDays` int[] of ISO weekdays, `timezone`), calendar (`respectWeekends`, `respectHolidays`, `holidayCountry`), and counters (`sentToday`, `sentThisHour`, `lastResetDate`, `lastResetHour`). `businessHoursOnly` defaults to `false` so existing setups behave unchanged until the operator opts in.
- [x] **P43-02.** `src/lib/i18n/holidays.ts` — pure module. Anonymous Gregorian Easter algorithm, builders for PL (Polish bank holidays incl. Wielkanoc / Boże Ciało / Wszystkich Świętych / Wigilia), GB (England+Wales bank holidays with weekend-substitute rule for Christmas/New Year), US (federal holidays incl. nth-weekday + Sat→Fri / Sun→Mon observance), DE (federal holidays incl. Karfreitag / Pfingstmontag / Tag der Deutschen Einheit). `getHolidaysForYear(country, year)`, `isHoliday(country, date)`, `isNonWorkingDay(date, opts)`. Per-year cache.
- [x] **P43-03.** `src/lib/services/sending-policy.ts` — pure window/counter evaluators + DB-backed orchestrator. `evaluateBusinessWindow(limits, now)` (timezone-aware via `Intl.DateTimeFormat` so DST is automatic), `evaluateCounters(limits, now)`, `pickRandomDelaySeconds(limits)`. `canSendNow({workspaceId, mailboxId, recipientDomain?, now?})` reads limits row + folds in per-domain count query. `recordSendCounter` atomically bumps the counters with day/hour rollover. `getOrCreateMailboxSendingLimits` lazy-creates the row on first read.
- [x] **P43-04.** `outreach-queue.ts` integration: `enqueueDraft` consults `evaluateBusinessWindow` and pushes `scheduledSendAt` to `retryAfter` when the chosen instant falls outside the window. `processEntry` calls `canSendNow` BEFORE suppression / cooldown checks; on a denial the entry is **re-queued** with `scheduledSendAt = retryAfter` and `lastError = reason` (status stays `queued`, attempt counter rolled back) so the operator sees scheduled items with their reason rather than failed sends. `recordSendCounter` runs after each successful send.
- [x] **P43-05.** UI (admin only): `/mailbox/[id]` Sending Policy section with form covering all knobs + holiday-country picker (PL/GB/US/DE) + business-day pill selector (`.business-day-pill` with `:has(input:checked)` styling). Shows current counter state ('5 sent today, 2 sent this hour'). `/mailbox/queue` re-styles `lastError` rendering: queued entries show a teal `.queue-reason-info` 'Why scheduled here: ...' note, while truly failed entries show the existing amber `.queue-reason-warn` block.
- [x] **P43-06.** 25 tests in `src/tests/sending-policy.test.ts` covering: easterSunday for 2024–2027; PL/GB/US/DE holiday sets including Christmas weekend substitutes and observed-day rules; isNonWorkingDay weekend + holiday gates; evaluateBusinessWindow happy path + before/after hours + weekend + holiday + respectHolidays-off bypass + retryAfter computation across timezones; evaluateCounters daily/hourly cap with stale-day reset; pickRandomDelaySeconds bounds + inverted-range clamp. **622/622 → 647/647 total tests pass.**

**Phase 43 complete.**

Note: per-mailbox policy ships with `businessHoursOnly=false` by default
so behaviour is unchanged after deploy. Operator turns the policy ON
from /mailbox/[id] when ready. The migration is idempotent so a stale
dev DB recovers automatically.

## Phase 44 — Research provider (Gemini grounding + Perplexity Sonar)

- [x] **P44-01.** New capability layer alongside `ISearchProvider` (raw SERP for connectors) and `IAIProvider` (text/JSON completion). `IResearchProvider` takes a question, performs web search internally, returns an LLM-grounded answer + citations. `src/lib/research/index.ts` defines `ResearchOptions` (country/language/freshness/maxCitations/systemPrompt/timeoutMs), `ResearchCitation`, `ResearchUsage` (incl. keySource for BYOK accounting), `ResearchOutcome`, `IResearchProvider`. `MockResearchProvider` returns deterministic stubs for dev/CI. Helpers: `dedupeAndRankCitations`, `extractDomain`. Factory pattern + BYOK identical to `getAIProviderForCtx`.
- [x] **P44-02.** Real Gemini implementation (`src/lib/research/gemini.ts`). POST `/v1beta/models/{model}:generateContent?key=...` with `tools: [{google_search: {}}]`. Maps `candidates[0].groundingMetadata.{groundingChunks, webSearchQueries}` to citations + `queriesIssued`. Default model `gemini-2.0-flash`. Cost computation covers Flash + Pro pricing as of late 2025. 60s `AbortController` timeout.
- [x] **P44-03.** Real Perplexity Sonar implementation (`src/lib/research/perplexity.ts`). OpenAI-shape POST `/chat/completions` with Bearer auth. Default model `sonar` (base tier; Pro returns `search_results` with title+snippet, base returns `citations` URLs only — both paths handled). `search_recency_filter` mapped from `options.freshness`. Cost computation covers base + Pro pricing.
- [x] **P44-04.** Schema (migration `0028_fancy_warbird.sql`): new `lead_research` table keyed `(workspace_id, qualified_lead_id)` with `question`, `question_hash` (sha256 lower-trimmed for cache lookup), `answer` (markdown), `citations` (jsonb), `queries_issued` (text[]), `provider_id`, `cost_estimate_cents`, `created_by`, `created_at`. Indexes on `(workspace, lead, created_at)` and `(workspace, lead, question_hash)` for cache hits.
- [x] **P44-05.** `src/lib/services/lead-research.ts` — `researchLead(ctx, {qualifiedLeadId, question, options?, refresh?})` checks the cache first (unless `refresh:true`), calls `getResearchProviderForCtx(ctx)` on miss, persists the row, audit-logs `lead_research.run`, and emits a `research.query` `usage_log` entry on every NON-mock call (so /settings/usage rolls research spend up). Cross-workspace, viewer-role, empty/oversized question rejections. `listLeadResearch`, `deleteLeadResearch` (admin-gated, audit-logged).
- [x] **P44-06.** UI on `/pipeline/[id]`: new Research section between CRM and Timeline with a textarea form + 4 preset buttons (company-overview / recent-news / decision-makers / buying-process). Cached entries render newest-first as gradient cards with the answer (paragraph-split), numbered citation list with title+domain+snippet, Re-run + Delete buttons per entry. Banner messages for `?message=` and `?error=`. New CSS: `.lead-research`, `.research-form`, `.research-presets`, `.research-preset`, `.research-list`, `.research-entry`, `.research-citations`, `.section-icon`, `.inline-form`.
- [x] **P44-07.** 17 tests in `src/tests/research.test.ts` covering: extractDomain url normalisation; dedupeAndRankCitations url-key dedupe + cap; MockResearchProvider determinism + zero-cost + maxCitations; researchLead persistence + cache hit + refresh-bypass + audit/usage emission (mock vs real provider via stub injector) + empty/oversized rejection + cross-workspace refusal + viewer-role refusal; list (newest first) + delete (audit). **647/647 → 664/664 total tests pass.**

**Phase 44 complete.**

Note: real grounded research only happens when `RESEARCH_PROVIDER` is
flipped from `mock` (default) to `gemini` or `perplexity` AND a
`GEMINI_API_KEY` / `PERPLEXITY_API_KEY` is configured in the workspace
secrets store or as a platform env var. Until the env flip the UI works
end-to-end but the answers are deterministic mock stubs.

## Phase 45 — Per-workspace provider selection (no more env flips)

- [x] **P45-01.** Schema (migration `0029_bumpy_randall_flagg.sql`): new `workspace_provider_settings` table with nullable columns `ai_provider` / `embedding_provider` / `research_provider` / `search_provider` + `updated_by` / `updated_at`. NULL means "inherit env default" so existing setups behave unchanged.
- [x] **P45-02.** `src/lib/services/provider-settings.ts`: `getProviderSettings(ctx)` lazy returns NULL row if missing (no insert), `resolveActiveProvider(ctx, capability, envFallback)` performs the cascade workspace → env → 'mock', `updateProviderSettings(ctx, partial)` admin-gated upsert with audit + per-capability allowed-values validation. `ALLOWED_AI_PROVIDERS` / `ALLOWED_EMBEDDING_PROVIDERS` / `ALLOWED_RESEARCH_PROVIDERS` / `ALLOWED_SEARCH_PROVIDERS` exported as readonly tuples for UI.
- [x] **P45-03.** Factory rewrites: `getAIProviderForCtx` / `getEmbeddingProviderForCtx` / `getResearchProviderForCtx` / `getSearchProviderForCtx` (new) all consult `resolveActiveProvider` first. Test-injection short-circuit (`if (cached) return cached`) preserves existing test patterns. When the cascade resolves to a real provider AND no key is configured (workspace BYOK or platform env), the factory throws with a clear `<provider>=… but no key configured` message instead of silently falling back to mock.
- [x] **P45-04.** UI on `/settings/integrations`: new "Active providers" section at the top with 4 dropdowns (one per capability). Each shows the resolved active id + source ('via workspace' / 'via env' / 'via default') in the label. Default option is `inherit env default (<env_value>)`. Admin-gated. Existing per-provider key sections updated to use `resolved.source` in their effective-source readout.
- [x] **P45-05.** 18 tests in `src/tests/provider-settings.test.ts` covering: resolveActiveProvider cascade (workspace > env > default); updateProviderSettings upsert + null-clears + partial preserves + unknown-id rejection + viewer denial + audit emit; getAIProviderForCtx integration with cascade (workspace anthropic + env openai → AnthropicAIProvider, mock override, platform-key fallback, BYOK wins, missing-key throws); getResearchProviderForCtx integration similar.
- [x] **P45-06.** 2 pre-existing P32/P33 tests updated: 'falls back to env-cached singleton' assertions changed from object-identity to provider-class + key checks since the new factories build fresh per call (the cached singleton was an internal detail; the user-visible contract is "right provider with right key"). **664/664 → 682/682 total tests pass.**

**Phase 45 complete.**

Operator can now flip providers from `/settings/integrations` directly.
After deploy + migration, the in-app dropdowns supersede `AI_PROVIDER` /
`RESEARCH_PROVIDER` / `EMBEDDING_PROVIDER` / `SEARCH_PROVIDER` env vars
without restart. Choosing 'inherit env default' falls back to the env
value, so existing prod setups keep their behaviour until the operator
explicitly picks a workspace-level provider.

## Phase 46 — Research-grounded outreach drafts

- [x] **P46-01.** Schema (migration `0030_messy_leader.sql`): two new columns on `product_profiles` — `enrich_drafts_with_research` (boolean, default `false`, opt-in per product) + `research_question_template` (text, default a B2B-flavoured question with `{company}` / `{domain}` tokens). Default off so existing products are unchanged.
- [x] **P46-02.** Engine: `composeAiDraft` accepts an optional `researchContext` string and, when present, injects a "Research context" block into the user prompt above the product/lead context. Mock seed includes a `:rN` suffix so enriched drafts are deterministic per (product, record, research) tuple.
- [x] **P46-03.** Service wiring: `generateOutreachDraft` looks up the qualified lead for `(reviewItem, product)` (when present), templated-renders the research question via `{company}` / `{domain}` substitutions (company derived from source-record title; domain from contact email > source-record domain), calls `researchLead` (cached), formats the answer + top 3 citations as the research context. Best-effort: failures log + draft generation continues without enrichment.
- [x] **P46-04.** UI: product form gets an 'Outreach research enrichment' fieldset with the on/off checkbox + a textarea for the templated question. New + Edit pages parse both fields. `product-profile.ts` create/update inputs accept `enrichDraftsWithResearch` + `researchQuestionTemplate`.
- [x] **P46-05.** Draft evidence: every AI draft now records `evidence.researchEntryId` (string of the `lead_research.id` that informed the draft, or `null` when no enrichment ran), so the operator can trace which research entry shaped any given draft.
- [x] **P46-06.** 5 tests in `src/tests/p46.test.ts` covering: `composeAiDraft` injects "Research context" when supplied + omits when not; `generateOutreachDraft` end-to-end runs research + persists to `lead_research` + threads it through to the prompt + records `researchEntryId`; flag-off skips research entirely; missing-lead skips enrichment gracefully without breaking the draft. **682/682 → 687/687 total tests pass.**

**Phase 46 complete.**

To use: turn on 'Enrich AI-generated drafts with live research' on a product
profile, ensure your workspace has a real research provider selected at
`/settings/integrations`, and generate a draft on `/drafts` — the engine
calls Gemini/Perplexity once per (lead, question) and feeds a grounded
context block into the prompt. Repeat draft generations for the same
question hit the cache.

## Phase 47 — Onboarding wizard + payment-ready schema

- [x] **P47-01.** Schema (migration `0031_first_maddog.sql`): two new enums (`onboarding_status` = pending|in_progress|completed, `subscription_status` = trial|active|past_due|canceled) + 6 new columns on `workspaces`: `onboarding_status` (default `completed` so legacy workspaces are unaffected), `plan` (text, default `trial`), `subscription_status` (default `trial`), `trial_ends_at` (nullable), `stripe_customer_id` (nullable), `stripe_subscription_id` (nullable). Stripe fields ship empty so the future P48 payment phase can plug Stripe webhook into the same row without another migration.
- [x] **P47-02.** Bootstrap path (`src/lib/auth.ts`): new bootstrap workspaces created at the OWNER_EMAIL first sign-in start with `onboarding_status='pending'`. Pre-existing prod workspaces use the `completed` schema default — nothing changes for them.
- [x] **P47-03.** `src/lib/services/onboarding.ts`: `getOnboardingState(ctx)` computes per-step completion (plan / ai / mailbox / product / connector) with auto-detect logic — AI step is done iff active provider is real AND key resolves; mailbox/product/connector steps are done iff at least one active row exists. `markOnboardingStarted(ctx)` moves pending → in_progress (no-op when already in_progress / completed). `markOnboardingComplete(ctx)` admin-gated, audit-logged.
- [x] **P47-04.** UI `/onboarding` page: 5 numbered step cards with Lucide icons (CreditCard / Sparkles / Inbox / ShoppingBag / Network), state-aware status badges (Done / Next / Pending), per-step CTAs that link to the relevant settings page, optional "why" hint for incomplete steps. The Plan step shows the workspace's `subscriptionStatus` + `plan` codes inline (today: trial / trial — placeholder for Stripe checkout in P48). 'Skip for now' button lets the operator dismiss; the wizard is admin-only for advancement, others can read + skip.
- [x] **P47-05.** Dashboard redirect: when the user's primary workspace has `onboarding_status != completed`, the dashboard bounces to `/onboarding`. The wizard's first visit promotes pending → in_progress so a stuck-pending workspace doesn't redirect-loop on every reload. Existing workspaces (legacy default `completed`) bypass the redirect entirely.
- [x] **P47-06.** New CSS: `.onboarding-list`, `.onboarding-step` (with `.next` accent + `.done` muted opacity), `.onboarding-step-icon` (tone-coloured for done/next/pending), `.onboarding-step-body`, `.onboarding-step-head`, `.onboarding-step-blurb`, `.onboarding-step-why` (amber callout for missing-step explanations).
- [x] **P47-07.** 12 tests in `src/tests/onboarding.test.ts`: 5-step shape; per-step done-detection (AI key reachable / not, mailbox + product + connector existence); effectivelyComplete = all-steps-done OR onboardingStatus='completed'; markOnboardingComplete flips status + admin-gates; markOnboardingStarted pending → in_progress idempotent + does not regress completed. **687/687 → 699/699 total tests pass.**

**Phase 47 complete.**

When P48 (Stripe payments) lands, the wiring is already in place:
`workspaces.{plan, subscription_status, trial_ends_at, stripe_customer_id,
stripe_subscription_id}` exist; the wizard's Plan step replaces its
placeholder copy with a real Stripe Checkout link; the `subscriptionStatus`
gate in `getOnboardingState` already treats `canceled` / `past_due` as
not-done so a lapsed customer hits the wizard instead of the dashboard.

## Phase 48 — Stripe payments (Checkout + Portal + Webhook)

- [x] **P48-01.** Plan catalogue at `src/lib/billing/plans.ts`. Two tiers: `starter` and `pro`. Each plan resolves its `priceId` from env (`STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO`) at request time so price rotations / regional pricing don't need a code change. `getAvailablePlans()` filters out plans whose price id is unset, so unconfigured tiers stay hidden from the UI.
- [x] **P48-02.** `src/lib/services/billing.ts` — Stripe SDK lazy-cached (`getStripeClient()` throws BillingError(`not_configured`) when `STRIPE_SECRET_KEY` missing, so `/settings/integrations` and the wizard surface a clear error instead of crashing).
- [x] **P48-03.** `getOrCreateStripeCustomer(ctx)` — finds or creates the workspace's Stripe Customer with `metadata.workspace_id` + `metadata.workspace_slug`. Persists `stripe_customer_id` on the workspace row so subsequent calls are no-ops.
- [x] **P48-04.** `createCheckoutSession(ctx, {planId, successUrl, cancelUrl})` — admin-gated, audit-logged. Creates a Stripe Checkout Session in subscription mode, threads `workspace_id` + `plan_id` through the session metadata AND the subscription metadata so the webhook can reconcile back to the right row. `allow_promotion_codes: true` in case you want coupons later. Returns `{url, sessionId}` for the caller to redirect.
- [x] **P48-05.** `createPortalSession(ctx, returnUrl)` — admin-gated. Creates a Stripe Customer Portal session so the operator can switch plans, cancel, update card, and view invoices on Stripe's hosted UI. Returns `{url}`.
- [x] **P48-06.** `verifyStripeEvent(rawBody, sig)` — verifies the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET` using `stripe.webhooks.constructEvent`. Throws `BillingError('webhook_invalid')` on mismatch so the route returns 400 + Stripe retries with backoff.
- [x] **P48-07.** `applyStripeEvent(event)` — switch on event type:
  - `checkout.session.completed` → write stripe ids + plan + `subscriptionStatus='active'` + flip `onboardingStatus='completed'` (paying customers don't need the wizard)
  - `customer.subscription.created` / `.updated` → write `subscriptionStatus = mapStripeStatus(sub.status)` + plan id when the metadata carries one
  - `customer.subscription.deleted` → `subscriptionStatus='canceled'`
  - `invoice.payment_failed` → look up workspace by `stripe_customer_id` (invoice metadata is unreliable), set `subscriptionStatus='past_due'`
  - other types → ignore + return 200 (Stripe sends a lot we don't care about; ignoring stops the retry loop)
  - Status mapping: `trialing→trial`, `active→active`, `past_due/unpaid/incomplete→past_due`, `canceled/incomplete_expired/paused→canceled`.
- [x] **P48-08.** Routes:
  - `POST /api/stripe/checkout` — body `{planId}`, returns `{url}`. Auth-required, admin-gated via the service.
  - `POST /api/stripe/portal` — returns `{url}`. Same gating.
  - `POST /api/stripe/webhook` — reads the raw body via `req.text()` (signature verification needs the unparsed bytes), runs `verifyStripeEvent` then `applyStripeEvent`. 400 on signature failure, 200 on every applied / ignored event, 500 on internal DB errors so Stripe retries.
- [x] **P48-09.** UI: `/onboarding` Plan step replaced its placeholder with a real `<PlanPicker>` rendering each available plan as a card (name + display price + pitch + checked feature list) with a server-action form that POSTs to `createCheckoutSession` and redirects the operator to Stripe Checkout. Stripe success / cancel banners render at the top of the page when returned with `?stripe=success` / `?stripe=canceled`. Current-plan card highlighted with primary-blue accent + "Manage from Billing settings" hint.
- [x] **P48-10.** New `/settings/billing` page (admin-gated): summary card with plan / status badge / Stripe customer + subscription ids; "Manage subscription" button that opens the Stripe-hosted portal; full plan list with the current plan highlighted; helpful hints when Stripe isn't configured / no customer exists yet / non-admin viewer. New `Billing` link in the sidebar Administration group with the CreditCard icon.
- [x] **P48-11.** New CSS: `.plan-picker`, `.plan-card`, `.plan-card-current` (primary-blue tinted gradient), `.plan-card-head`, `.plan-price`, `.plan-pitch`, `.plan-features` (with `.plan-feature-icon`), `.billing-summary` (icon + dl grid).
- [x] **P48-12.** 7 tests in `src/tests/billing.test.ts` covering `applyStripeEvent`: checkout completed → active + onboarding completed + ids written; subscription updated → past_due; deleted → canceled; payment_failed → past_due via customer-id lookup; missing metadata → no_workspace; unhandled event types → ignored; status mapping for trialing + incomplete. **699/699 → 706/706 total tests pass.**

**Phase 48 complete.**

To go live: set the following env vars on agregat (`/opt/lead-discovery-platform/.env`):
  - `STRIPE_SECRET_KEY=sk_live_...`        (or sk_test_... for test mode)
  - `STRIPE_WEBHOOK_SECRET=whsec_...`      (from the Stripe webhook endpoint config)
  - `STRIPE_PRICE_STARTER=price_...`       (Stripe Price ID for the Starter plan)
  - `STRIPE_PRICE_PRO=price_...`           (Stripe Price ID for the Pro plan)
  - optional: `STRIPE_PRICE_STARTER_DISPLAY` / `STRIPE_PRICE_PRO_DISPLAY` to override the displayed price strings.
  - optional: `STRIPE_TRIAL_DAYS=N` (default 5; set to 0 to disable trials).

Configure the Stripe webhook endpoint to POST to
`https://discover.nulife.pl/api/stripe/webhook` and subscribe at minimum to:
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.payment_failed`. Restart the app container after the env flip.

## Phase 49 — Product profile autofill (URL + PDFs → AI-synthesized draft)

- [x] **P49-01.** Deps: `cheerio` (HTML extraction) + `pdf-parse` (PDF text extraction). `@types/pdf-parse` for type bindings.
- [x] **P49-02.** `src/lib/services/product-autofill.ts`:
  - `fetchAndExtractWebsite(url)` — http(s)-only with 30s AbortController timeout, 1.5MB byte cap, identifies as `lead-discovery-platform/autofill` UA. cheerio strips script/style/nav/footer/header chrome and prefers `<main>` / `[role=main]` / `<article>` / `<body>` in that order. Returns `ExtractedSource{kind:'website', label, text, originalBytes}`.
  - `extractFromPdf(buffer, filename)` — uses `pdf-parse` v2 `PDFParse` class, handles encrypted/corrupted PDFs cleanly via try/finally, calls `.destroy()` to release the pdfjs handle. Returns `ExtractedSource{kind:'pdf', ...}`.
  - `synthesizeProfile(ctx, {sources})` — one AI call via the workspace's active provider with a Zod schema covering name / shortDescription / fullDescription / targetCustomerTypes / targetSectors / targetProjectTypes / includeKeywords / excludeKeywords / qualificationCriteria / outreachInstructions / language / confidence (high|medium|low) / notes (free-form for SPA / paywall flagging). Detector cascade fills language when AI omits it. Per-source 24KB clip + global 64KB budget enforced via proportional trim.
  - `autofillProductProfileFromSources(ctx, {url?, pdfs?})` — orchestrator: fetch + parse → synthesize → persist via existing `createProductProfile` → audit-log `product_profile.autofill` with confidence + source labels.
- [x] **P49-03.** UI `/products/autofill` page: form with URL field + multi-select PDF upload + "Generate" button. Server action handles File → Buffer conversion (only accepts `application/pdf` mimetype OR `.pdf` filename), redirects to `/products/[id]?autofill=ok&confidence=...` on success or `/products/autofill?error=<reason>` on failure.
- [x] **P49-04.** `/products` list page CTA upgrade: primary "Autofill from URL / PDFs" button + secondary ghost "New product (manual)" link. `/products/[id]` shows a teal "Autofill complete · confidence: <level>. Review every field…" banner when arriving via `?autofill=ok`.
- [x] **P49-05.** 9 tests in `src/tests/product-autofill.test.ts` covering: synthesizeProfile happy-path with stub AI, empty-sources rejection, language-detector fallback when AI omits language; end-to-end autofill (mocks `globalThis.fetch`) — persists the profile + emits audit; rejects no-source input; viewer-role rejection; 404 fetch surfaces cleanly; non-http URL rejection; malformed-URL rejection. **708/708 → 717/717 total tests pass.**

**Phase 49 complete.**

To use: visit `/products` → click **Autofill from URL / PDFs** → paste your
product page URL and/or upload TDS / spec PDFs → Generate. The engine
fetches + extracts + asks the workspace's active AI provider to synthesize
a structured profile, persists it, and lands you on the product detail
page for review. Cost: ~1–3¢ per autofill against the active AI provider.
Static fetch only (SPAs return empty text); scanned-image PDFs need OCR
(future).

## Phase 50 — Vector storage as 5th provider capability + PDF/DOCX indexing

- [x] **P50-01.** Schema migration `0035_groovy_unicorn.sql` — `vector_storage_provider` on `workspace_provider_settings`; `vector_storage_quota_mb_per_product` (int default 20) on `workspaces`; new `product_vector_stores` table; `external_provider_id` / `external_file_id` / `external_status` / `external_error` / `external_indexed_at` columns on `knowledge_sources`.
- [x] **P50-02.** `IVectorStorageProvider` interface + `MockVectorStorageProvider`. Phase 45 cascade extended — `resolveActiveProvider` accepts `'vector_storage'`, `ALLOWED_VECTOR_STORAGE_PROVIDERS = ['mock', 'pgvector', 'openai']`.
- [x] **P50-03.** `PgvectorVectorStorageProvider` wraps the self-hosted RAG path. No external store id.
- [x] **P50-04.** `OpenAIVectorStorageProvider` — Wandizz pattern (per-product OpenAI Vector Store, Files API + `file_search` tool). Enforces per-product byte cap. BYOK key resolution. Idempotent detach. Audit-logged.
- [x] **P50-06.** `/settings/integrations` UI: Vector Storage row in Active providers grid, per-product cap form, test-connection button.
- [x] **P50-07.** `attachKnowledgeSourceViaProvider` auto-fires after `createKnowledgeSource`; status badge surfaces on `/knowledge/[id]` and `/products/[id]`.
- [x] **P50 PDF/DOCX.** `rag.ts:extractDocumentText` now handles `application/pdf` via `pdf-parse` v1 (inner-module path) and DOCX via `mammoth`. Scanned PDFs throw a clean "no extractable text — switch to openai for OCR" rather than a cryptic invariant. New `mammoth` dep.
- [x] **P50-09 (later).** `buildProductKnowledgeBlock` routed through `getVectorStorageProviderForCtx` so both rails are symmetric on read. `suggestReply` intentionally stays on `retrieve()` directly (workspace-wide + lessons fusion, no per-product anchor).
- [x] **Operator decision (2026-05-17):** stick with `pgvector` (cheaper, self-hosted). The OpenAI rail stays as a dormant option. **717 → 760 total tests across the phase.**

**Phase 50 complete.**

To use: `/settings/integrations` → Active providers → pick `pgvector` for Vector Storage (default). Upload PDFs / DOCX as documents; wrap in a `knowledge_source`; the auto-attach pipeline chunks + embeds via the active Embedding provider (OpenAI `text-embedding-3-small` by default). Engagement + pitch drafts retrieve top-k chunks from this store at compose time.

## Inline fix (2026-05-14) — server actions bodySizeLimit 1 MB → 32 MB

- [x] **fix(uploads).** Next.js 15 server actions default to a 1 MB body cap; PDF datasheets >1 MB hit it before our code ran. `next.config.ts` bumps `experimental.serverActions.bodySizeLimit` to 32 MB. Meaningful gating remains the per-product cap.
- [x] Companion nginx fix on agregat: `client_max_body_size 32m;` on the `discover.nulife.pl` vhost (otherwise 413 stops requests before Next sees them).

## Inline fix (2026-05-14) — autoCloseNegative gate + P46 test fix

- [x] **fix(outreach).** The Phase B/C/D/E staged-conversation engine added a second close path in `outreach-reply-handler` that ran unconditionally on `close_and_suppress`, ignoring the workspace `autoCloseNegative` flag. Unsubscribe + bounce stay defensive; `decline` (negative reply) now honors the workspace toggle.
- [x] **fix(test).** P46 research-context test predated the Phase A discovery composer (which intentionally skips research). Test advances the lead to `engagement` so it exercises the AI path that consumes `researchContext`.

## Phase 51 — IMAP backoff + reactivate + adaptive polling (fail2ban-safe)

- [x] **P51-01.** Schema migration `0036_early_onslaught.sql`: `imap_consecutive_failures` (int default 0), `imap_next_sync_after` (nullable timestamp), `imap_empty_syncs` (int default 0) on `mailboxes`.
- [x] **P51-02.** Pure helpers in `src/lib/services/imap-backoff.ts`. `classifyImapError` distinguishes auth (AUTHENTICATIONFAILED / Invalid credentials / LOGIN_DISABLED / Account locked) from transient. `computeBackoffMs` exponential 2 → 4 → 8 → 16 → 32 → 60 min cap. `nextSyncAfterEmpty` stretches quiet mailboxes to 15-min cadence after 5 empty syncs.
- [x] **P51-03.** `handleImapTick` consumes the new columns: WHERE clause skips mailboxes whose cooldown gate hasn't elapsed; auth errors flip `status='failing'` (stops ticking until manual reactivation); transient errors increment the failure counter + push `imap_next_sync_after` by `computeBackoffMs(count)`.
- [x] **P51-04.** `reactivateMailbox` service + UI on `/mailbox/[id]`: red banner + Reactivate button surface when `status='failing'`. Resets all backoff state.
- [x] **P51-05.** 16 tests in `src/tests/imap-backoff.test.ts`. **733 / 733 total.**

**Phase 51 complete.**

Eliminates the prior failure mode where one mailbox with a stale password produced 30 failed IMAP logins/hour, every hour. Now: one rejection → `failing` status → operator-visible banner + Reactivate.

## Inline fix (2026-05-14/15) — mailbox SSL/STARTTLS reliability

- [x] **fix(mailbox).** `/mailbox/[id]/edit` IMAP SSL/TLS checkbox now actually saves when unchecked. The previous condition (`!== 'off'`) treated `null` as truthy and always wrote `imap_secure=true`. SMTP toggle was correct (`=== 'on'`); this brings IMAP into parity.
- [x] **fix(mail).** Port-aware SSL/STARTTLS auto-correct (mirror Wandizz): SMTP 465 → secure=true, 587/25 → secure=false; IMAP 993 → secure=true, 143 → secure=false. Non-standard ports keep operator choice. Plus `tls: { rejectUnauthorized: false }` for self-signed certs common on shared hosts.

## Phase 52 — Test email + inbox/outreach thread split

- [x] **P52-01.** `sendTestEmail(ctx, input)` in `mail.ts` — same SMTP path as `sendMessage` but bypasses suppression / bounce / contact resolution, skips unsub footer + tracking pixel, does NOT persist a `mail_messages` row. Tags `X-LDP-Test: true`. Audit `mail.send_test`. `/mailbox/[id]/test` page with To/Subject/Body form + signature picker.
- [x] **P52-02.** `listThreads` gains a `kind` filter (`outreach` / `inbox` / `all`) backed by an EXISTS over `outreach_thread_state`. `countThreadsByKind` returns the partition counts for tab badges.
- [x] **P52-03.** `/mailbox/[id]` Threads section becomes three tabs (Outreach / Inbox / All) with counts. Empty-state copy is kind-aware. Outreach = threads with an `outreach_thread_state` row; Inbox = everything else.
- [x] **P52-04.** 7 new tests. **733 → 740 total.**

**Phase 52 complete.**

Test sends never clutter the threads view; operator's own mail server keeps the sent copy. Inbox tab catches inbound mail not routed to outreach.

## Phase 53 — Signature logo URL + live HTML preview

- [x] **P53-01.** Schema migration `0037_steady_shocker.sql`: `logo_url` text column on `signatures` (separate from existing `logo_storage_key` — one is uploaded files, the other is externally hosted URLs).
- [x] **P53-02.** `validateLogoUrl` service helper — only http(s), up to 2 KB, defensive against `javascript:` URLs slipping into rendered `<img src=…>`.
- [x] **P53-03.** Renderer: row-level `logoUrl` wins over the explicit `logoUrl` arg (which `mail.send` pre-resolves from `logoStorageKey`). Logo cell drops out when both blank.
- [x] **P53-04.** UI: SignatureForm gets a Logo URL input with HTTPS hint; existing rows get a separate Logo URL details block + a tiny `logo URL` badge on the header.
- [x] **P53-05.** New `SignatureHtmlEditor` client component — replaces the bare textarea with a side-by-side editor + live HTML preview.
- [x] **P53-06.** 10 new tests (4 service-layer for `logoUrl` validation; 6 pure renderer for precedence + XSS escape + bodyHtml override). **740 → 750 total.**

**Phase 53 complete.**

## Phase 54 — AI re-design for signatures

- [x] **P54-01.** `redesignSignatureHtml(ctx, input)` service. Email-client-safe system prompt (inline CSS only, table-based, max 600 px, no `<script>`/`<iframe>`). Zod-validated JSON `{ bodyHtml }` response. `sanitizeSignatureHtml` strips `<script>`, `<iframe>`, `on*` event handlers, `javascript:` URLs. Records `usage_log` kind `ai.signature_redesign` + `audit_log` `signature.redesign`.
- [x] **P54-02.** `POST /api/signatures/redesign` route handler — auth-gated, Zod-validated input.
- [x] **P54-03.** `AISignatureRedesigner` client component. `useTransition` for pending state. Mounted in `SignatureForm` (new) and `SignatureHtmlEditor` (edit).
- [x] **P54-04.** 5 tests. **750 → 755 total.**

**Phase 54 complete.**

## Phase 55 — Better signature redesigns (style presets + few-shot + smarter model)

- [x] **P55-01.** Style preset chips in `AISignatureRedesigner` — Minimal / Branded / Two-column / Compact. Each chip prepends a canned style block to the AI prompt. Toggleable.
- [x] **P55-02.** Rewritten system prompt with two worked examples (minimal single-column with inline title; branded two-column with logo + muted sub-line). Explicit 4-option title-placement guidance + visual hierarchy rules.
- [x] **P55-03.** `pickRedesignModel` upgrade: Anthropic → keep Opus/Sonnet else `claude-sonnet-4-6`; OpenAI → keep gpt-5/4o/o3/mini else `gpt-5`. Temperature 0.6 → 0.85 for layout variation across regenerations.
- [x] **Inline fix (2026-05-16).** AI redesign no longer outputs `b7` instead of `·`. System prompt forbids hex escapes / HTML entities for separators; temperature dropped 0.85 → 0.7; `sanitizeSignatureHtml` rewrites orphaned `b7` / `B7` / `0xB7` / truncated `&#xB7` to literal `·`. **755 → 757 total.**

**Phase 55 complete.**

## Phase 56 — Signatures workspace overhaul (Wandizz-style two-column)

- [x] **P56-01.** `pickRedesignModel` always returns top tier — `claude-opus-4-7` / `gpt-5` regardless of workspace default. Operator decision: signatures designed once per operator; one Opus chat completion is rounding error.
- [x] **P56-02.** New `SignaturesWorkspace` client component — two-column layout (list left, preview + raw HTML right). `SignatureForm` extended to support edit mode via new `initial` prop.
- [x] **P56-03.** Per-signature send-test API + dialog: `POST /api/signatures/send-test` wraps `sendTestEmail`. `SendTestDialog` opens from an envelope icon top-right of the Live Preview card.
- [x] **P56-04.** Anti-fabrication: Opus 4.7 / gpt-5 were substituting "real" company contacts from training data (Ecobeton UK → Francesco Nardese in prod). New `DATA INTEGRITY RULES` section in the system prompt + `detectFabrication` post-pass that throws if the output contains an email address not in the operator's input. 3 new tests.
- [x] **Inline fix.** Card click reliability — `<li onClick>` was unreliable with nested forms. Card body now an explicit `<button>` spanning the row.

**Phase 56 complete.** **757 → 760 total tests.**

## Phase 57 — Communication workspace (list + filters + detail + reply composer)

- [x] **P57-01.** `src/lib/services/communication.ts` — `listCommunication(ctx, filters)` joins `mail_threads` + `outreach_thread_state` + `qualified_leads` + `product_profiles` in one query; enriches with derived flags via correlated subqueries. Derived status: `scheduled > error > replied > sent > pending`. Filters: status, productId, search (subject / contact / email / product, case-insensitive), dateFrom / dateTo. `countCommunicationByStatus` for tab badges.
- [x] **P57-02.** `/communication` landing page — sidebar Communication entry under Outreach. Status tabs (Total / Sent / Replied / Error / Scheduled) + filter row (search, product, date range).
- [x] **P57-03.** `/communication/[threadId]` three-column detail — left: lead context (contact, product, notes); middle: state (pipeline state, outreach stage, last reply intent, scheduled sends, pipeline-events history); right: conversation + inline reply composer.
- [x] **P57-04.** `mail.sendMessage` accepts `signatureId?: bigint | null`. `CommunicationReply` client component picks signature inline ("Default: {name}" badge). `POST /api/communication/reply` wraps `sendMessage`.
- [x] **P57-05.** 9 cases in `src/tests/communication.test.ts`. **760 → 769 total.**
- [x] **Inline fix.** Breadcrumb alignment (Lucide chevron was floating above text because `.lucide` class had no CSS rule defined — added global rule). Reply box → wider/taller (rows=14, min-height 22ch). Right column 1.6× width. Raw HTML pane uses themed `.signature-preview-text` class.

**Phase 57 complete.**

## Phase 58 — Automatic follow-ups (3 polite pings, weekly, cancel-on-reply)

- [x] **P58-01.** Schema migration `0038_keen_korvac.sql` — new `outreach_follow_ups` table (workspace, lead, thread, stepNumber, totalSteps, scheduledFor, status, skipReason, queueEntryId, draftId, sentMessageId, processedAt). Statuses: pending / sent / skipped / failed. Skip reasons: replied / bounce / manual_cancel / product_archived / lead_closed. Unique index on (workspace, thread, step). Plus `workspaces` gains `followUpEnabled` / `followUpIntervalDays` (default 7) / `followUpMaxSteps` (default 3).
- [x] **P58-02.** `src/lib/services/follow-up.ts` — `scheduleFollowUps`, `cancelFollowUps`, `processDueFollowUps` (worker entry), `listFollowUps`, `countFollowUpsByStatus`. Per-step re-verification on processOne (no inbound on thread, lead not closed, product still active).
- [x] **P58-03.** `composeFollowUpDraft` in outreach-engine. System prompt locks tone (≤60 words, polite, non-intrusive, no re-pitch, no urgency tactics). Step N of M in the prompt. Final step gets a hard-coded "this is the last email" instruction.
- [x] **P58-04.** Triggers: `mail.sendMessage` success on first outbound + thread linked to a qualified lead → schedule. `reply-classifier` inbound → `cancelFollowUps('replied')`.
- [x] **P58-05.** New cron tick `outreach.follow_up.tick` (every 1 h) in `repeatables.ts`. Per-workspace fan-out.
- [x] **P58-06.** UI: `CommunicationTabs` server component (Conversations / Follow-ups). New `/communication/follow-ups` page — schedule list with status chips, step badge (1/3, 2/3, 3/3), `final` badge on step N, Cancel button (pending rows only).
- [x] **P58-07.** 8 tests in `src/tests/follow-up.test.ts`. **769 → 777 total.**

**Phase 58 complete.**

## Phase 59 — Full follow-up configuration + approval gate

- [x] **P59-01.** Schema migration `0039_omniscient_living_tribunal.sql` — `workspaces.follow_up_require_approval` (bool default false) + `follow_up_step_configs` (jsonb, nullable; array of `{daysAfterPrev, customInstructions}`). `outreach_follow_ups` gains `staged_subject` + `staged_body` + new status value `awaiting_approval`.
- [x] **P59-02.** Service: `loadSettings` reads jsonb when set, falls back to simple interval × maxSteps. `updateFollowUpConfig` admin-gated writer (validates step count 1–10, daysAfterPrev ≥ 1). `scheduleFollowUps` uses per-step `daysAfterPrev` cumulatively. `composeFollowUpDraft` accepts `customInstructions`. `processOne` branches on `requireApproval`: when on, persists subject + body to staged_*, flips status to `awaiting_approval`. New `approveFollowUp(ctx, id, override?)` + `rejectFollowUp(ctx, id)` helpers.
- [x] **P59-03.** `/settings/outreach` (existing page, extended) — Follow-up configuration form. Enable + Require-approval toggles. Steps table with editable (daysAfterPrev, customInstructions) inputs + empty bottom row to add (clearing days drops the row on save).
- [x] **P59-04.** `/communication/follow-ups` gains an `Awaiting approval` status tab. Rows in that state expand to an inline review form (editable Subject + Body textareas pre-filled with staged AI content + Approve & send / Reject buttons).
- [x] **P59-05.** 4 new tests. **777 → 781 total.**
- [x] **Inline fix (discoverability).** Outreach config link moved from collapsed Administration sidebar section into the always-open Outreach section. Configure follow-ups CTA added to the Follow-ups tab header.

**Phase 59 complete.**

## Phase 60 — Knowledge-first review loop (operator decisions feed AI-managed knowledge)

**Design lock (2026-05-19):** "Knowledge is the source of knowledge." Every
manual decision in the Review Queue must enrich the workspace knowledge
base. Manual reject → product-scoped negative lesson. Manual approve →
product-scoped positive lesson. Knowledge is AI-managed and compacted
periodically so it stays at the most-useful size, not the biggest. Always
workspace-scoped.

- [x] **P60-01/02.** `applyStateChange` in review.ts feeds approve/reject into `recordFeedback` — looks up qualifications for the source record and emits one learning event per matched product (falls back to workspace-scoped event when no qualifications exist). New `review_items.approval_reason` column (migration 0040) + approve-with-reason UI input on `/review/[id]` mirroring the existing reject form. `approveReviewItem(ctx, id, reason?)` signature extended; `rejectReviewItem` unchanged.
- [x] **P60-03.** AI-driven lesson extractor. `recordFeedback` now calls `extractLesson(ctx, comment)` which tries the workspace AI provider (via `getAIProviderForCtx`) first and falls back to the deterministic heuristic on any failure. Extraction runs OUTSIDE the DB transaction so a slow / failing AI call cannot tie up a connection. `usage_log` entry tagged `ai.learning_extract` per call. Resolves the long-standing "Phase 7+ swaps the heuristic for the AI provider abstraction" note.
- [x] **P60-04.** `src/lib/services/knowledge-compaction.ts` — `compactWorkspaceKnowledge(ctx)` (admin-gated) + `compactWorkspaceKnowledgeUnattended(workspaceId)` (cron entry). Per-workspace pipeline: retire stale lessons (confidence < 40 AND `last_applied_at` older than 30 days or never applied AND createdAt older than 30 days) → cluster remaining enabled lessons by (productProfileId, category) → ask the AI per cluster to merge near-duplicates → update survivor row with the consolidated rule + unioned `evidence_event_ids`, disable the retired rows (no hard delete). Every merge / retire writes an audit event. `lastCompactionRun(ctx)` returns the most recent summary for UI display.
- [x] **P60-05.** `knowledge.compact.tick` registered in `repeatables.ts` (weekly per workspace, fan-out matches the P58 follow-up tick). `/learning` page gains a compaction panel with last-run summary + "Compact now" button (admin-only). New `.compaction-panel` styling in `globals.css`.
- [x] **P60-06.** `learning_lessons.application_count` + `last_applied_at` columns (migration 0041). New `recordLessonsApplied(ctx, lessonIds)` helper bumps both atomically — workspace-scoped, never throws, no-op on empty input. Wired into both real "lesson is consumed" callsites: `qualification.classifySourceRecord` (scoring loop) and `outreach.generateOutreachDraft` (prompt assembly). Compaction's stale-retirement uses these counters to distinguish dead-weight lessons from load-bearing ones.
- [x] **P60-07.** Tests written alongside each task (no separate test phase). +4 review tests (per-product feedback emission, fallback to workspace-scoped when no qualifications, isolation), +4 learning AI-extractor tests (uses AI category, falls back when null, falls back on throw, rejects invalid category), +2 usage-tracking tests, +6 compaction tests (admin gate, merge with evidence union, keep-all, workspace isolation, audit emission, singleton skip). **781 → 797 total tests.**
- [x] **P60-08.** Deployed 2026-05-19. SHA `a7c3076`. Migrations 0040 + 0041 applied via `ssh root@agregat "cd /opt/lead-discovery-platform && pnpm db:migrate"` (host-side, after deploy). Smoke: `/api/health` 200, `review_items.approval_reason` confirmed live, `learning_lessons.application_count` + `last_applied_at` confirmed live. Interactive smoke of approve-with-reason → learning event flow is operator-driven (cannot exercise as Claude without a session).

**Phase 60 complete.**

## Phase 61 — Full mailbox management (folders + trash + spam + errors)

**Design lock (2026-05-19):** Folders are DERIVED from `(direction, status,
trashed_at, spam_at)` — never stored as a column. Six folders:
**Inbox · Sent · Queued · Errors · Spam · Trash**. Priority order
**trash > spam > error > status**, so a trashed-and-spammed message lives in
Trash. Folder is a *message-level* concept; the thread view still shows the
full conversation but collapses hidden messages. Soft-delete via `trashed_at`
keeps thread context intact; hard delete only happens for already-trashed
rows (via the action or the auto-purge cron).

- [x] **P61-01.** Migration `0042_striped_black_queen.sql` — `mail_messages` gains `trashed_at TIMESTAMPTZ`, `spam_at TIMESTAMPTZ`, `spam_reason TEXT`, all nullable. Existing 799 tests stay green (no behavior change yet). Commit `06a50e4`.
- [x] **P61-02.** `src/lib/services/mail-folders.ts` — `MailFolder` type + `deriveFolder(msg): MailFolder` pure function. Priority: trashedAt → 'trash'; else spamAt → 'spam'; else status ∈ {failed, bounced} → 'errors'; else status ∈ {queued, sending} → 'queued'; else direction='outbound' → 'sent'; else 'inbox'. 13 tests in `src/tests/mail-folders.test.ts` covering priority order, inbound/outbound bucketing, and a full (direction × status × trashed × spam) matrix. **799 → 812 total.**
- [x] **P61-03.** `listMessages(ctx, {mailboxId, folder, limit, offset, search})` + `countMessagesByFolder(ctx, mailboxId)` in `mail.ts`. Folder filter pushed into SQL via `folderFilter(folder)` helper (mirrors `deriveFolder` priority exactly). Counts query uses a single `COUNT(*) FILTER` per folder. Search matches subject + fromAddress + any `to_addresses` element (case-insensitive). Pagination via limit (1..500) + offset. Existing `listThreads` kept for the thread view. 11 new tests in `mailing.test.ts` (empty mailbox, six-message bucketing, trash/spam priority, queued bundling, errors bundling, mailbox + workspace scoping, search across subject/from/to, ordering newest first, limit+offset). **812 → 823 total.**
- [x] **P61-04.** Per-message actions in `mail.ts`: `moveToTrash`, `restoreFromTrash`, `markAsSpam(reason='manual')`, `unmarkSpam`, `permanentlyDelete`. All accept `ReadonlyArray<bigint>`, are batch-capable, use `inArray()` (see [[feedback_drizzle_any_trap]]), workspace-scoped via the SQL `WHERE`, and emit `mail.*` audit events with the affected ids. Trash/spam mutations are idempotent (already-trashed / already-spammed rows skip the UPDATE so `affected` reports only newly-changed). `permanentlyDelete` is atomic: it pre-checks that *every* requested id is workspace-owned AND already trashed, throwing `invalid_input` for the whole batch otherwise — no partial deletion. Return shape `{ affected: number, ids: bigint[] }`. Viewer role blocked on every action. 20 new tests in `mailing.test.ts` (trash + restore + spam + unmark batches and idempotency, restore reveals underlying spam state, permanent-delete rejects non-trashed, cross-workspace + viewer denial, empty-input no-ops). **823 → 843 total.**
- [x] **P61-05.** Mailbox detail UI rebuild — `/mailbox/[id]` "Conversations" section replaced with "Messages": six-folder nav (Inbox / Sent / Queued / Errors / Spam / Trash) using `MAIL_FOLDERS`, count badges from `countMessagesByFolder`, body switched from thread-list to *message list* (`listMessages`). Each row: subject (linking to its thread on `/communication/[threadId]` when present), peer (to-address for outbound, from-name + address for inbound), status pill, timestamp; Errors rows surface `failureReason`, Spam rows surface `spam_reason`. URL = `?folder=<name>&q=<search>`, default Inbox. Search box scoped to active folder with Clear link. Per-folder empty hints. Legacy `?view=` param silently ignored (lands on Inbox). Type-check + lint clean; data path covered by P61-03 / P61-04 tests, no new tests added at this layer.
- [x] **P61-06.** Bulk action bar on `/mailbox/[id]`. Single `<form>` wraps the message list; each row has an unlabelled checkbox (`name="ids"`). Hidden `folder` + `q` inputs survive the round-trip so the action redirects back to the same view. Folder-specific submit buttons via `formAction`: Inbox/Sent/Queued/Errors → Move to trash + Mark as spam; Spam → Not spam; Trash → Restore + Delete permanently. Permanent-delete uses a new `ConfirmFormButton` client component (`src/components/ConfirmFormButton.tsx`) that intercepts the click with `confirm()` and cancels submission on decline. Server actions: `trashSelected`, `restoreSelected`, `spamSelected` (reason='manual'), `unspamSelected`, `deleteSelected`. Each parses `ids` from FormData, calls the P61-04 helper, and redirects back with an `affectedNote()` message (e.g., "3 messages moved to trash."). Per-row inline buttons skipped this pass — HTML doesn't allow nested forms and the bulk-only surface is clear enough. Production build clean; data path covered by P61-04 tests, no new tests at UI layer.
- [x] **P61-07.** Errors folder UX + Retry. New `retrySend(ctx, ids[], providerOverride?)` in `mail.ts` walks each id, classifies it (`retried` / `skippedHardBounce` / `skippedIneligible` / `errors`), and for each retryable row calls `sendMessage` with the original payload (to/cc/bcc/subject/body/inReplyTo/references/sourceDraftId). On success the original row is auto-trashed so the Errors folder clears; the new send threads onto the same conversation via its existing References. Audit event `mail.retry_send` records all four outcome arrays. New `isHardBounce({status, failureReason})` predicate: hard if `status='bounced'` OR `failureReason` matches `/\b5\d{2}\b/`. UI: in the Errors folder a primary "Retry selected" button leads the action bar; each Errors row shows a "Hard bounce" badge when `isHardBounce(message)`. Viewer role blocked. 12 new tests (4 isHardBounce cases + 8 retrySend cases: success path with auto-trash + new sent row, skip on bounced, skip on 5xx failureReason, skip on ineligible status/direction, mixed batch, workspace isolation, viewer denied, empty input). **843 → 855 total.**
- [x] **P61-08.** Failed-send persistence + bounce-loop auto-spam. `sendMessage`'s catch block now persists a `mail_messages` row on send failure: `status='bounced'` when the underlying error carries a 5xx response code, `status='failed'` otherwise. `failureReason` is set (responseCode prefix when present). A synthesised `<failed-${uuid}@<domain>>` Message-ID keeps the workspace-unique constraint happy without colliding with the never-emitted real one. The failed row threads onto the same conversation via `ensureThread` so the thread view shows the attempt. Persistence is wrapped in its own try/catch — a persistence failure never masks the original send error. New `detectBounceLoop(ctx, mailboxId, recipient)` helper counts prior `failed`/`bounced` rows in (workspaceId, mailboxId, recipient in to_addresses, createdAt > now - 14d). When count ≥ `BOUNCE_LOOP_THRESHOLD - 1` (= 2 priors), the about-to-be-persisted failure gets `spam_at = now()`, `spam_reason = 'bounce_loop'` and an audit event `mail.bounce_loop_auto_spam` is recorded. Constants `BOUNCE_LOOP_THRESHOLD=3`, `BOUNCE_LOOP_WINDOW_MS=14d`. 12 new tests (8 `detectBounceLoop` cases: zero / below / at / mixed failed+bounced / 14-day window / per-recipient / per-mailbox / cross-workspace; 4 sendMessage failure-persistence cases: 5xx → bounced row, transport error → failed row, threshold-th attempt lands in Spam with reason=bounce_loop, mixed recipients don't cross-trigger). **855 → 867 total.**
- [x] **P61-09.** Auto-empty trash policy + cron + admin UI. Migration `0043` adds `workspaces.trash_retention_days INT NOT NULL DEFAULT 30`. Three new helpers in `mail.ts`: `purgeOldTrashUnattended(workspaceId)` hard-deletes rows where `trashed_at < now - retention_days` (returns `{deleted, retentionDays}`, no-op when retention=0); `emptyTrashNow(ctx)` (admin-gated) hard-deletes every trashed row regardless of age with an audit event; `updateTrashRetentionDays(ctx, days)` (admin-gated) writes the workspace setting, clamps to `[0, 365]`, rejects non-integers. Cron tick `mail.trash.purge.tick` (24h) registered in `repeatables.ts` with `handleMailTrashPurgeTick` fan-out matching the P58/P60 pattern. UI: new "Mailbox retention" card on `/settings/outreach` — admin-gated number input + "Empty trash now" button (uses the existing `ConfirmFormButton` from P61-06). 12 new tests (5 `purgeOldTrashUnattended` — old-not-recent, leaves non-trashed alone, retention=0 disables, per-workspace setting, workspace isolation; 3 `emptyTrashNow` — deletes all ages, admin gate, workspace isolation; 4 `updateTrashRetentionDays` — round-trip, clamps low+high, rejects non-integer, admin gate). **867 → 879 total.**
- [x] **P61-10.** Thread view (`/communication/[threadId]`, canonical location since the IA cleanup) — messages split into `visibleMessages` (not trashed AND not spammed) and `hiddenMessages` (either flag set). Visible ones render inline; hidden ones live inside a `<details>` expander labelled "Show N hidden message(s) (trashed / spam)" with 75% opacity so they read as audit material, not active conversation. Each bubble now carries a right-aligned action menu (Trash / Spam in normal state, Restore in trash, Not spam in spam) — implemented as tiny `<form action={fn.bind(null, idStr)}>` shims per button (server actions accept `.bind()` partial application). Existing badge styles surface `trashed` and `spam{:reason}` next to the from-address so the row visually identifies its hidden bucket. No new tests at this layer — the P61-04 service tests already pin the data path. Production build clean; 879 tests still green.
- [ ] **P61-11.** Tests written alongside each task. Folder-derivation matrix (P61-02), service action tests with workspace isolation + batch semantics + admin gating (P61-04), bounce-loop detection and threshold edge cases (P61-08), cron purge respecting retention and idempotency (P61-09), retry preserving messageId + thread linkage (P61-07). Target +~20 tests. **799 → ~819 total.**
- [ ] **P61-12.** Deploy. Migrations 0042 (already in tree) plus any added by P61-08 / P61-09. Host-side `pnpm db:migrate` (see [[feedback_lead_platform_migrate]]). Smoke: each of the six folders renders for an existing mailbox; trash → restore a message; spam → "Not spam" round-trip; Errors folder shows any failed sends and Retry succeeds; cron `mail.trash.purge.tick` registered in repeatables; old trashed message disappears after retention window (validate by setting retention=0 in a throwaway workspace and triggering the tick manually).

**Open notes (resolve during impl, don't block plan):**
- Phase 52's outreach-vs-inbox distinction: probably folds into the Inbox folder as a secondary filter chip ("Outreach only"). Decide in P61-05.
- Bounce-loop threshold (3 / 14d) is a guess; tune after deploy if it fires too eagerly or not enough.

## Discovered along the way

(empty — add discoveries with `> 2026-MM-DD …` prefix when found)
