# Architecture

This document captures the architectural decisions that shape the codebase. Update it whenever you make a decision that affects future work — do not silently change shape.

## North star

The platform is **multi-tenant B2B lead discovery and outreach**. The unit of tenancy is the **Workspace**. Everything tenant-owned — users, products, connectors, harvested records, drafts, learning memory — belongs to exactly one workspace.

The system must remain useful even when AI and search providers are disabled. AI is an **assistant layer**, not the foundation.

## Stack decisions

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript | Type safety, single language across UI and server |
| Framework | Next.js 15 App Router | One framework for SSR, API, and ops; React-native; well-supported on Hetzner via Docker |
| Database | PostgreSQL | Boring, reliable, strong text search, JSONB for flexible payloads, good at relational + semi-structured |
| ORM | Drizzle | Lightweight, low-magic, SQL-shaped queries, good migration tooling |
| Auth | Auth.js (next-auth v5) | Built for Next.js, OAuth-ready, session storage in DB |
| Background jobs | Abstraction layer; in-memory in dev, BullMQ + Redis later | Isolate the queue from the rest of the codebase so swap is cheap |
| File storage | Abstraction layer; local FS in dev, S3-compatible later | Same reason |
| AI providers | Abstraction layer; mock + real implementations | Required by the brief: app must run without paid AI |
| Search providers | Abstraction layer; mock + real implementations | Same |
| Tests | Vitest | Native ESM, fast, plays well with Next.js + Drizzle |
| Browser smoke tests | Playwright (`e2e/`, `pnpm test:e2e`) | Every route at 1440px and 390px against a running app seeded by `scripts/seed-demo.ts`: status < 500, no uncaught page errors, no sideways scroll on a phone. The route list is derived from `src/app` (`e2e/routes.ts`) and checked by Vitest, so a new page can't drop out unnoticed |
| Container | Docker, docker-compose | Hetzner-friendly, parity between dev and prod |
| Reverse proxy | Nginx | Already deployed on the same host for other apps; well-understood |

## Workspace-first

This is the most important rule and the most often violated. Two stances:

1. **Every tenant-owned table includes `workspaceId`** as a NOT NULL column with an index. Tables that are *not* tenant-owned (e.g., the `users` table — users can belong to multiple workspaces) are explicitly documented in `docs/DATABASE_MODEL.md`.
2. **Every service function takes `WorkspaceContext` as its first argument.** There is no global default workspace, ever. There is no "service-level" code that runs without a workspace context — even cron jobs and connector runs carry an explicit `workspaceId`.
3. **The super-admin console is the one exception, and it uses `PlatformContext`, never `WorkspaceContext`.** `requirePlatformAdmin()` (`src/lib/services/auth-context.ts`) returns `{ scope: 'platform', actorUserId }` with no workspace in it. Platform services (`admin.ts`, the platform half of `users.ts`, support admin, `adjustTokens`, platform keys and settings) take it first, plus an explicit target workspace id wherever they touch a tenant. They audit either at platform scope (`workspace_id` NULL: users, pre-authorisations, platform roles, keys, settings) or against that explicit target (billing, tokens, members, support replies) — never against the workspace the admin's switcher points at. Nothing under `src/app/admin` may call `getWorkspaceContext()`; a static test (`src/tests/admin-console-static.test.ts`) enforces it. That includes the `/admin/providers` live checks ("Test platform AI default" and each vendor's "Test key"), which since PC-02 test only the platform tier (console key, else env var) and never resolve a workspace. `PENDING_EXCEPTIONS` in that test is empty; an entry may only be added with the change that removes it.

Workspace-isolation tests run on every CI build. They are the only tests that can never be skipped or marked as TODO.

## Module boundaries

Modules are **vertical slices** of the domain, each owning a set of tables, a service layer, types, and tests. Modules talk to each other only through their public service API — never by reaching into another module's tables directly.

The dependency graph is intentionally shallow:

```
auth, workspace            <-- foundation, depended on by everything below

product_profile            <-- depends only on workspace
connector_framework        <-- depends on workspace
search_provider            <-- depends on workspace, used by connectors
ai_provider                <-- depends on workspace (for usage logs); used by classification, drafts, learning
source_record              <-- depends on workspace + connector_framework
qualification              <-- depends on source_record + product_profile + (optional) ai
review_queue               <-- depends on source_record + qualification
draft                      <-- depends on review_queue + product_profile + (optional) ai
learning                   <-- listens to review_queue + draft, feeds qualification + draft
audit_log, usage_log       <-- written by everyone, read by admin views
```

Cross-cutting modules (audit, usage, jobs, storage) are accessed via interfaces, not direct imports of business modules.

A full module-by-module description is in `docs/MODULES.md`.

## Provider abstractions

Four kinds of pluggable providers, each defined by a TypeScript interface with a small surface and a mock implementation that ships in the repo.

### `IAIProvider`
```ts
interface IAIProvider {
  id: string;
  generateText(input: AIGenInput, options?: AIGenOptions): Promise<AIGenResult>;
  generateJson<T>(input: AIGenInput, schema: ZodSchema<T>, options?: AIGenOptions): Promise<T>;
  estimateCost(usage: AIUsage): number;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
```
Active-provider resolution (all capabilities, see `src/lib/services/provider-settings.ts`): workspace setting → env selector (`AI_PROVIDER` etc.) → **auto-detected system default** — the first vendor whose platform key env var is set (`systemDefaultProvider`). `mock` is a dev/test tool only: it returns deterministic stubs, is never offered in the customer UI, and in production a capability with no platform key resolves to the preferred real vendor so calls fail loudly ("no key configured") instead of fabricating mock data. Vector storage defaults to `pgvector` (keyless).

**Setup modes** (chosen in onboarding, stored on `workspaces.setup_mode`): `simple` = the workspace runs on the platform's system keys/defaults and `/settings/integrations` is a read-only summary; `advanced` = same defaults but provider selection and BYOK keys are editable. Switching to simple resets provider-selection overrides to NULL (BYOK secrets are kept). NULL setup_mode (legacy workspaces) behaves as advanced.

### `ISearchProvider`
```ts
interface ISearchProvider {
  id: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  testConnection(): Promise<{ ok: boolean; detail?: string }>;
  estimateUsageCost(query: string, options?: SearchOptions): number;
}
```
The mock provider returns a fixed result set keyed off the query string — enough for end-to-end tests of the connector + review pipeline without hitting SerpAPI.

### `IJobQueue`
```ts
interface IJobQueue {
  enqueue<P extends JobPayload>(type: JobType, payload: P, options?: JobOptions): Promise<JobId>;
  status(id: JobId): Promise<JobStatus>;
  cancel(id: JobId): Promise<void>;
  on(type: JobType, handler: JobHandler): void;
}
```
In-memory implementation in Phase 1 — handlers run inline on a microtask. BullMQ implementation later for production durability.

### `IStorage`
```ts
interface IStorage {
  put(key: string, body: Buffer | Readable, meta?: StorageMeta): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, options?: SignedUrlOptions): Promise<string>;
  exists(key: string): Promise<boolean>;
}
```
Local-filesystem implementation (`STORAGE_PROVIDER=local`, used in production today) and an S3-compatible one (Hetzner Object Storage / B2 / Wasabi / R2 / MinIO). `get()` rejects with `StorageObjectNotFoundError` when the key holds nothing.

**Browsers never get a storage URL.** Workspace files go out through authenticated route handlers: they resolve the `WorkspaceContext`, let the owning service find the object inside that workspace, and return `storageDownloadResponse()` (`src/lib/storage/download.ts`: attachment, sanitised filename, `Cache-Control: private, no-store`, `nosniff`). Today those routes are `GET /api/documents/[id]/download` (`streamDocument`, any workspace role) and `GET /api/crm/exports/[file]` (`streamCsvExport`, write roles). A key in another workspace answers 404, the same as a missing one. `LocalFileStorage.signedUrl()` throws `StorageUrlUnavailableError`, because a `file://` path cannot be opened by a browser. S3 presigned URLs stay available for future server-to-server use, but pages do not link to them: a presigned link works for anyone who holds it and carries the UUID key as its filename.

## API design

- Route handlers live under `src/app/api/<resource>/route.ts`. They are thin: parse input → enforce auth + workspace context → call service.
- Services live under `src/lib/services/<module>/`. They take a typed `WorkspaceContext` as first arg.
- Validation: Zod schemas at the API boundary. The service layer trusts its inputs (it has been validated and authorized).
- Errors: services throw typed errors (e.g., `WorkspaceAccessDenied`, `ProductProfileNotFound`); route handlers translate them into HTTP responses.
- Server (form) actions translate the same typed errors into a readable `?error=` / `?message=` flash with `describeActionError(err, [XxxServiceError, …])` from `src/lib/action-errors.ts`, which rethrows Next redirect/notFound throws and anything not listed. Each action decides what `not_found` / `conflict` mean for it (a repeated "end session" is a success; "connector inactive" is not). Unexpected errors fall through to the branded `src/app/error.tsx` (root-layout failures to `global-error.tsx`; unknown URLs and `notFound()` to `not-found.tsx`). Prefer module-scope actions in a `'use server'` file bound with `.bind(null, id)` — they are testable and cannot close over page-local helpers.

## Auth + session

- Auth.js with Google OAuth as the only provider initially. Adding GitHub or email/password later is one config change plus tests.
- Sessions stored in the database (Drizzle adapter), not JWT. Reasoning: workspace switching, role changes, and immediate revocation work cleanly with DB sessions.
- After login, the user picks a workspace. Their active workspace is stored in the session row. All subsequent API calls resolve `WorkspaceContext` from the session.
- The first user whose email matches `OWNER_EMAIL` becomes `super_admin` automatically. There is no other path to that role in Phase 1.

## Multi-workspace per user

A user can belong to multiple workspaces. The `workspace_members` table joins them with a role (`owner | admin | manager | member | viewer`). Switching workspaces updates the active workspace on the session row. All API calls thereafter use that workspace.

## Audit and usage logs

Two append-only tables, both indexed by `(workspaceId, createdAt)`:

- **`audit_log`** — significant user-visible actions (workspace created, member invited, lead approved, draft generated, settings changed, ...).
- **`usage_log`** — provider calls and resource consumption (search queries, AI calls, jobs, storage bytes, ...).

These tables are written by every relevant module and read primarily by admin views and cost dashboards. They are not a debugging log — that's stdout/journal.

## What we are not building yet

These are explicitly out of scope until later phases (see `docs/ROADMAP.md`):

- Email sending and IMAP sync.
- Vector search and RAG.
- CRM integrations.
- Billing.
- Super admin / God Mode UI.
- Real connector implementations beyond mock + CSV.

Each of these has a hook in the data model so it can be added without rewriting Phase 1 code. The hooks are documented in `docs/MODULES.md`.

## Decisions log

When you make an architectural decision, append it here with date, decision, and reasoning. Format:

```
### YYYY-MM-DD — Title
**Decision:** ...
**Reasoning:** ...
**Alternatives rejected:** ...
```

### 2026-05-01 — Phase 0 stack lock-in
**Decision:** Next.js + Drizzle + PostgreSQL + Auth.js + Vitest + Docker.
**Reasoning:** Boring, well-supported, single-language stack. Hetzner-friendly. Drizzle was preferred over Prisma for lower magic and easier migrations. PostgreSQL was preferred over MySQL/TiDB despite recent experience with TiDB Cloud — Postgres has stronger full-text search, better JSONB support for the connector raw_data column, and is easier to self-host.
**Alternatives rejected:** Prisma (heavier runtime, harder migrations on existing DBs); Hono (lighter than Next.js but means picking + integrating a UI framework separately); SQLite (won't scale to thousands of harvested records cleanly with concurrent connector runs).

### 2026-10-01 — PlatformContext for the super-admin console (PC-03)
**Decision:** Console pages and their server actions get a `PlatformContext` from `requirePlatformAdmin()` instead of a `WorkspaceContext` from `getWorkspaceContext()`. Platform services reject anything that is not a `PlatformContext` (including a `WorkspaceContext` with role `super_admin`) and take an explicit target workspace id. The no-op "Impersonate" control and its service path were removed; `impersonation_sessions` stays as history.
**Reasoning:** A `WorkspaceContext` in the console resolves to whatever workspace the admin switcher points at. Every console action was therefore audit-logged into that workspace — in god mode a tenant the admin does not belong to — and that tenant's admins could read other customers' emails, names and suspension reasons on `/settings/audit` (I051). Impersonation recorded sessions that nothing ever applied (I047). Rows already misfiled are moved by `scripts/remediation/refile-platform-audit.ts` (dry run by default; apply only with the fingerprint of a reviewed dry run; reversible through `payload.refiledFrom`).
**Alternatives rejected:** Keeping `WorkspaceContext` and passing the real target alongside it (the ambient workspace would still be one typo away); making impersonation real now (it needs a design for a read-only, time-boxed identity overlay first — PC-18).
### 2026-10-01 — Inbound relevance gate before the reply pipeline (Phase 0, flow:F-01)
**Decision:** Every IMAP-synced message is stored and threaded, but only messages proven to be about our outreach enter the reply pipeline. At parse time `lib/mail/relevance.ts` captures header signals (List-*, Precedence, Auto-Submitted, ESP markers, the parsed delivery-status report) and stores headers JSON-safely; `services/inbound-relevance.ts` adds DB facts (a reference to one of OUR outbound Message-IDs, matched case-insensitively; a DSN about our mail; a contacted lead's address; our own mailbox) and the pure decision labels `mail_messages.outreach_relevance` as prospect_reply / auto_reply / bounce / bulk / unrelated. Only the first three are classified (on the sender's own words: quoted history and our footer stripped) and may cause side effects; automatic suppression additionally needs a prospect_reply, and bounce suppression is off until DSN-based bounce handling (F-32).
**Reasoning:** The classifier ran over every synced email; newsletter footers read as unsubscribes and suppressed ~141 innocent addresses, created ~221 junk contacts, 359 false "Reply from" notifications and paid for translations of junk (X1). Proof of relation (references / DSN / lead address) is cheap, explainable (stored as evidence on the row) and errs towards doing nothing.
**Alternatives rejected:** Thread membership as proof (subject-fallback threading merges unrelated conversations, I008 — revisit with F-34); a keyword blocklist of newsletter senders (unbounded, silently wrong); classifying everything and only filtering the auto-actions (still pollutes contacts, notifications, labels and token spend).

### 2026-10-01 — Send mode, a human-confirmed unsubscribe, and suppression only on recipient rejections (Phase 0, flow:F-05)
**Decision:** `sendMessage` takes a required `mode`. `one_to_one` (compose, thread replies, queued drafts that answer a prospect's reply) carries no unsubscribe footer and no List-Unsubscribe headers; `sequence` (cold first touches, referral intros, follow-ups) keeps both. `GET /api/unsubscribe/<token>` only renders a confirmation page (and HEAD is an explicit no-op); only POST — the page's button or an RFC 8058 one-click POST — opts out, and then also cancels queued sends, pending / awaiting-approval follow-ups and open leads for that address (`services/unsubscribe.ts`, null actor). A send error suppresses a recipient only when the server refused that recipient at RCPT TO as non-existent / disabled (enhanced 5.1.x except the sender codes 5.1.7 / 5.1.8, or 5.2.1; 550-class "user unknown" text without an enhanced code) — `lib/mail/smtp-errors.ts`; a refused login (EAUTH / 534 / 535) marks the mailbox failing (`markMailboxFailing`, one deduped `mailbox.failing` notification), and the outreach queue and follow-ups hold behind a failing mailbox instead of failing.
**Reasoning:** B2B link scanners fetch every URL in an email, so a GET that unsubscribes silently drops prospects on arrival (I012). Any SMTP error with a code used to suppress every recipient — a rotated password blacklisted up to 50 prospects per drain, permanently for 5xx (I007). Personal replies carried a bulk-mail footer (I089) and compose sent the signature twice (I090).
**Alternatives rejected:** A default mode (a forgotten caller silently gets the wrong legal footer either way); JavaScript auto-submit on the confirmation page (scanners run JavaScript); suppressing on any 5xx at RCPT (relay / policy / blocklist refusals are about us); queue backoff for every transient failure here (the full taxonomy and stored stage + enhanced code on the failure row follow in F-28).

### 2026-10-01 — Production data is repaired by versioned, reviewed, revertible scripts (Phase 0, flow:F-06)
**Decision:** Data remediation lives in `scripts/remediation/<batch>/` (first: `2026-10-funnel`, mail module) on a shared engine (`scripts/remediation/lib/`). A dry run is read-only and writes a plan with a sha256 hash, a markdown report and a `decisions.csv` (bulk categories per workspace, judgement rows one by one) into the git-ignored `remediation-reports/`. `--apply` takes the report and the owner's decisions, recomputes the plan from the database and refuses on any hash drift, then runs one transaction per category; every changed row gets a before- and after-image in `remediation_log` and every run a `remediation_runs` row (id = batch id, so a report applies once). `--revert` restores the images in one transaction and reports rows changed since the apply as conflicts. Suppressions are revoked and contacts archived, never deleted; a token credit is an opposite ledger entry on revert. Provenance that the schema never recorded (pre-F-03 suppressions) is rebuilt from `audit_log`, not from notes.
**Reasoning:** X1 wrongly suppressed ~141 addresses (including the owner's colleagues), created ~221 junk contacts and 359 false notifications. Repairing that by hand-written SQL on prod would be unreviewable and irreversible, and a note-based guess would revoke opt-outs a person had entered before the classifier touched the row. Recomputing at apply time means the owner approves exactly what runs, and the images make every step undoable byte-for-byte.
**Alternatives rejected:** A one-off SQL file (no review artefact, no revert); a data migration (runs unreviewed on deploy, cannot take per-row owner decisions); trusting the plan file at apply time (stale or edited plans would execute); before-images in a JSON file on the host (lost with the host, not transactional with the change).

### 2026-10-02 — Job heartbeats, an incident stream and a readiness probe (Phase 1, PC-07)
**Decision:** Every handler registered with the job queue is wrapped by `instrumented(name, handler)` (`src/lib/jobs/instrumented.ts`). The wrapper writes `job_heartbeats` on start and finish (duration, status, consecutive failures, the handler's structured summary) and gives the handler a `TickIncidents`. A per-workspace failure inside a tick becomes a workspace-scope `ops_events` row (fingerprinted, deduplicated, masked) that the workspace's next success resolves. A whole-job failure is a platform-scope `tick.failed` / `job.failed`. The BullMQ worker's `failed` / `error` events raise platform incidents for anything the wrapper did not see. The schedule registration at boot stamps `registered_at` and `boot_id` per tick. `/api/ready` (503 on failure) checks the database, Redis (bullmq only), applied migrations and tick staleness. Staleness uses the expected-slot rule (epoch-aligned slots under BullMQ, registration-based under the memory queue, `pending` until the first slot after registration, a 10-minute boot grace). `/api/health` stays I/O-free.
**Reasoning:** Tick results were BullMQ return values that nothing read, per-workspace errors went only to `console.error`, the worker had no failure listener, and `/api/health` was static. A dead worker or a lost Redis therefore looked healthy while sending, sync, follow-ups and autopilot all stopped (I022). Failures that matter to an operator had no record at all (I021). Staleness is computed on read (never stored), so a stopped worker that writes nothing still turns stale.
**Alternatives rejected:** Heartbeats in a Redis hash (lost with Redis, which is exactly the failure to detect; not joinable with tenants); a fixed `interval × 3` age rule (a weekly tick right after a deploy would read stale, and a weekly tick could miss its slot for weeks); deep checks in `/api/health` (container restarts on a slow dependency); BullMQ `QueueEvents` / bull-board (another Redis-dependent moving part, and no per-workspace view).

### 2026-10-02 — Owner alerts to ntfy from an in-process watchdog (Phase 1, PC-08)
**Decision:** Owner alerts go to one ntfy topic configured in the server env (`NTFY_TOPIC` required, `NTFY_URL` default `https://ntfy.sh`, optional `NTFY_TOKEN`, `OPS_ALERT_MIN_SEVERITY` default `error`); unset means alerts off, logged once. A watchdog timer in the app process (`src/lib/ops/watchdog.ts`, every 60 s) turns a tick that is stale on two consecutive checks into a `tick.stale` incident, then pulls due incidents from `ops_events` (`src/lib/services/ops-alerts.ts`) and sends them: one alert per incident key, a reminder after 6 h while open, more than 3 due at once folded into one digest, at most 10 messages an hour (critical still goes out), scanner noise excluded, a daily digest of open incidents at 07:00 UTC. Platform stop / hold / pause changes push an alert through `alertControlChange()` right after they commit. Each alert key is claimed in `ops_alert_state` before sending; every message is logged in `ops_alert_deliveries`. The console's Providers page shows a topic- and token-free status and a "Send test alert" button.
**Reasoning:** PC-07 recorded failures, but nobody was told (X10: no alerting at all). Pulling from `ops_events` keeps every raiser unchanged and lets one claim-based dispatcher enforce dedupe, the budget and the digest across processes. A timer, not a queued job, so a lost Redis or a stuck BullMQ worker cannot silence the alert about it. On ntfy.sh the topic name is the credential, so it lives in env, is never rendered, and failures are scrubbed of it.
**Alternatives rejected:** Sending from inside `raiseOpsEvent` (every raiser would pay an HTTP call, and dedupe/budget would need the same cross-process state anyway); the webhook URL in `platform_secrets` with Telegram/Slack/JSON formats (the owner chose ntfy via env; the sink is one module, `src/lib/ops/ntfy.ts`, if another is ever needed); a BullMQ repeatable for the watchdog (dies with Redis, the thing it should report); email (PC-16).

### 2026-10-02 — Send-failure model, atomic 'sent', a stuck-work reaper and cross-process Cancel (Phase 1, PC-10)
**Decision:** A failed queued send is classified (`src/lib/mail/send-failure.ts`, on top of Phase 0's `classifySmtpError`): `transient` (SMTP 4xx, no reply) retries with exponential backoff up to 5 attempts, `local` (before the SMTP submission: translation, DB) and `unknown` up to 3, `sender_auth` holds the entry behind the failing mailbox, `recipient_hard` and `policy` fail; only `recipient_hard` ever suppresses. `sendMessage` tags the errors it throws instead of wrapping them (WeakMap / WeakSet): a provider failure carries its SMTP classification, and anything thrown after the server accepted the message is "after delivery" and is never retried. `sendMessage` gains `onPersisted(tx, message)`: the queue row turns `sent` in the same transaction as the `mail_messages` insert; post-insert audit and thread bookkeeping are best-effort. A paused mailbox holds its queue like a failing one. Failed, skipped and cancelled entries get Retry now / Requeue (any write role), which go back through the drain's own checks; the Errors-folder retry settles the draft's queue rows. A new tick, `ops.reaper.tick` (5 min, `src/lib/services/stuck-work.ts`), settles rows `sending` for 10 minutes (sent if a sent copy of the draft exists from the claim on, else failed `interrupted` + incident) and runs without progress for 15 minutes (pending 60). The runner keeps a heartbeat (`last_progress_at`) and reads `cancel_requested_at` on the same write between steps; it starts only `pending` runs and never overwrites a run that left `running` under it. internet_search ends `failed` when every query failed, `partial` when some did.
**Reasoning:** I007/I013/I014/I074: every exception made a queue row terminal, a restart mid-send left it `sending` forever (blocking the draft), a failure after the insert marked a delivered email `failed`, a paused mailbox failed its due queue after paying for the translation, and a run whose queries all failed showed green. Tagging keeps nodemailer's error objects intact for every existing caller. A database flag (not an in-process AbortController registry) is the only cancel signal that reaches a BullMQ worker in another process. Pending runs get 60 minutes because under BullMQ they can wait their turn behind others; the conditional claim means a reaped run never starts late.
**Alternatives rejected:** Wrapping send errors in a new error class (breaks callers and tests that read `responseCode`); retrying everything (a policy refusal or a dead address would be hammered); reusing `scheduled_send_at` for the backoff (loses the planned time the operator set); a `sending` timeout inside the drain (a second drain could double-send while the first is still alive; the reaper's conditional writes cannot); auto-resending interrupted rows (the email may have gone out).

### 2026-10-02 — Log noise cut at the source, and one daily retention tick (Phase 1, PC-35)
**Decision:** The autopilot tick visits only workspaces whose autopilot is on and unpaused (`listAutopilotTickWorkspaces`). `runOnce` keeps its guard in `autopilot_settings.guard_state` and writes a `guard` row only when that state changes (an UPDATE conditional on the state the run read, in one transaction with the row); its return value still carries the guard every time. `syncInbound` audits only a sync that stored new messages. A new tick, `ops.retention.tick` (24 h, `src/lib/services/retention.ts`), deletes past their window: `autopilot_log` 30 days, `mail.sync_inbound` audit rows 30 days, read notifications 90 days (by created_at), resolved `ops_events` 90 days after resolving, `ops_alert_deliveries` and unused `ops_alert_state` keys 90 days, heartbeat rows of jobs no longer in the tick catalogue 90 days. Each policy is a named, batched delete (5,000 rows a statement, 200 statements a run); a failing policy does not stop the others but fails the tick afterwards (heartbeat + `tick.failed`). A run that deleted anything writes a platform `ops.retention.run` audit row. It is platform housekeeping and no pause, hold or stop gates it.
**Reasoning:** I066: a workspace with autopilot off logged a `guard skipped` row every 5 minutes (288 a day), so real autopilot activity scrolled off `/autopilot` within hours; the 2-minute IMAP tick audited every empty sync; nothing ever deleted from these tables. Recording the state on the settings row keeps the check O(1) and survives the log's own retention (a log lookup would rescan the log and re-log a state every 30 days). One tick with its own heartbeat makes retention visible and alertable like any other background work.
**Alternatives rejected:** Filtering guard rows out of the UI only (the rows still grow); reading the last guard row from `autopilot_log` (a backward scan per run, and lost after 30 days); per-workspace retention passes (archived workspaces would keep their rows forever; one pass per table uses one index); retention on `usage_log` (it backs token debits) or on other audit kinds (they are the record of what people did); unbatched deletes (the first run after months of growth would hold long locks).
