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
- [ ] **P12-06.** Deploy.

## Discovered along the way

(empty — add discoveries with `> 2026-MM-DD …` prefix when found)
