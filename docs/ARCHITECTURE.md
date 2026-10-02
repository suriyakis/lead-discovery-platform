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

### 2026-10-02 — One navigation registry; Today replaces the dashboard and inbox (DS-05, AP-03, ia:F-10)
**Decision:** `src/lib/nav/registry.ts` is the only description of where pages live: areas (Today, then Work, Build, Workspace, then the super-admin Platform console) with their tabs on today's URLs, the detail routes and create flows of each area, the unlisted pages with a reason, the Cmd-K actions, the account menu, the mobile tab bar and the count policy (`NavCountSpec`: key, tone, gate). Pure data, no React or database, so client components, server code and scripts all import it; behaviour over it lives in `resolve.ts` (visibility by role, URL → area/tab with static routes beating dynamic ones, badge resolution, Cmd-K entries) and `route-table.ts`. The Sidebar, `AreaNav` (area tabs and the grouped Settings sub-nav, around every page in `AppShell`), the Cmd-K palette (workspace app and console), the console nav, the legacy redirects (`redirects.ts`) and the assistant handbook's screens index all render from it; `nav-routes.ts`, the Sidebar's own SECTIONS/PINNED, AdminShell's NAV, the dashboard's module list and the seven `SettingsNav` copies are gone. `/today` is the home; `/dashboard` and `/inbox` are permanent-redirect stubs that keep the query. The handbook became a module directory (`src/lib/assistant/handbook/`) whose screens index, pipeline stages, reply classes (`REPLY_CLASSES`, also the source of the `ReplyClass` type), language order (`LANGUAGE_PRECEDENCE`, which the resolver walks), autopilot steps and billing catalogue are generated from the code that holds those facts; `pnpm handbook:export` writes the same text to `docs/USER_GUIDE.md`, and a test fails while they differ. The IA itself is written up in `docs/design/IA.md`.
**Reasoning:** Navigation was defined three times and drifted: Cmd-K could not find Support, Notifications, Health or the console's Providers and Support, the console had three names, and settings pages showed different tab bars (I082, I046, I171). The handbook hard-coded routes, classes, prices and an order the code no longer had, so the guide sent operators to the wrong place (I132–I134, I181). Data that tests can check against `src/app` (every page registered or unlisted with a reason; every href a page; one label per href) makes drift a failing test instead of a support ticket.
**Alternatives rejected:** A route group with one layout now (ia:F-09 / DS-07 do that move; `AppShell` already wraps every page, so the registry works on today's URLs without moving 59 pages); deriving navigation from the file system (it cannot carry labels, grouping, vocabulary or count policy); Next `redirects()` in `next.config.ts` (the stubs keep the moves inside the app and testable with the other routes); a Suspense boundary around `AreaNav` for `useSearchParams` (every page that renders it is dynamic, and React may stream the fallback copy of the nav first).
