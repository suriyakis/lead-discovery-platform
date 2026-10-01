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
| Container | Docker, docker-compose | Hetzner-friendly, parity between dev and prod |
| Reverse proxy | Nginx | Already deployed on the same host for other apps; well-understood |

## Workspace-first

This is the most important rule and the most often violated. Two stances:

1. **Every tenant-owned table includes `workspaceId`** as a NOT NULL column with an index. Tables that are *not* tenant-owned (e.g., the `users` table — users can belong to multiple workspaces) are explicitly documented in `docs/DATABASE_MODEL.md`.
2. **Every service function takes `WorkspaceContext` as its first argument.** There is no global default workspace, ever. There is no "service-level" code that runs without a workspace context — even cron jobs and connector runs carry an explicit `workspaceId`.

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
}
```
Local-filesystem implementation now; S3-compatible (Hetzner Object Storage / B2 / Wasabi / R2) later.

## API design

- Route handlers live under `src/app/api/<resource>/route.ts`. They are thin: parse input → enforce auth + workspace context → call service.
- Services live under `src/lib/services/<module>/`. They take a typed `WorkspaceContext` as first arg.
- Validation: Zod schemas at the API boundary. The service layer trusts its inputs (it has been validated and authorized).
- Errors: services throw typed errors (e.g., `WorkspaceAccessDenied`, `ProductProfileNotFound`); route handlers translate them into HTTP responses.

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

### 2026-10-01 — Inbound relevance gate before the reply pipeline (Phase 0, flow:F-01)
**Decision:** Every IMAP-synced message is stored and threaded, but only messages proven to be about our outreach enter the reply pipeline. At parse time `lib/mail/relevance.ts` captures header signals (List-*, Precedence, Auto-Submitted, ESP markers, the parsed delivery-status report) and stores headers JSON-safely; `services/inbound-relevance.ts` adds DB facts (a reference to one of OUR outbound Message-IDs, matched case-insensitively; a DSN about our mail; a contacted lead's address; our own mailbox) and the pure decision labels `mail_messages.outreach_relevance` as prospect_reply / auto_reply / bounce / bulk / unrelated. Only the first three are classified (on the sender's own words: quoted history and our footer stripped) and may cause side effects; automatic suppression additionally needs a prospect_reply, and bounce suppression is off until DSN-based bounce handling (F-32).
**Reasoning:** The classifier ran over every synced email; newsletter footers read as unsubscribes and suppressed ~141 innocent addresses, created ~221 junk contacts, 359 false "Reply from" notifications and paid for translations of junk (X1). Proof of relation (references / DSN / lead address) is cheap, explainable (stored as evidence on the row) and errs towards doing nothing.
**Alternatives rejected:** Thread membership as proof (subject-fallback threading merges unrelated conversations, I008 — revisit with F-34); a keyword blocklist of newsletter senders (unbounded, silently wrong); classifying everything and only filtering the auto-actions (still pollutes contacts, notifications, labels and token spend).

### 2026-10-01 — Send mode, a human-confirmed unsubscribe, and suppression only on recipient rejections (Phase 0, flow:F-05)
**Decision:** `sendMessage` takes a required `mode`. `one_to_one` (compose, thread replies, queued drafts that answer a prospect's reply) carries no unsubscribe footer and no List-Unsubscribe headers; `sequence` (cold first touches, referral intros, follow-ups) keeps both. `GET /api/unsubscribe/<token>` only renders a confirmation page (and HEAD is an explicit no-op); only POST — the page's button or an RFC 8058 one-click POST — opts out, and then also cancels queued sends, pending / awaiting-approval follow-ups and open leads for that address (`services/unsubscribe.ts`, null actor). A send error suppresses a recipient only when the server refused that recipient at RCPT TO as non-existent / disabled (enhanced 5.1.x except the sender codes 5.1.7 / 5.1.8, or 5.2.1; 550-class "user unknown" text without an enhanced code) — `lib/mail/smtp-errors.ts`; a refused login (EAUTH / 534 / 535) marks the mailbox failing (`markMailboxFailing`, one deduped `mailbox.failing` notification), and the outreach queue and follow-ups hold behind a failing mailbox instead of failing.
**Reasoning:** B2B link scanners fetch every URL in an email, so a GET that unsubscribes silently drops prospects on arrival (I012). Any SMTP error with a code used to suppress every recipient — a rotated password blacklisted up to 50 prospects per drain, permanently for 5xx (I007). Personal replies carried a bulk-mail footer (I089) and compose sent the signature twice (I090).
**Alternatives rejected:** A default mode (a forgotten caller silently gets the wrong legal footer either way); JavaScript auto-submit on the confirmation page (scanners run JavaScript); suppressing on any 5xx at RCPT (relay / policy / blocklist refusals are about us); queue backoff for every transient failure here (the full taxonomy and stored stage + enhanced code on the failure row follow in F-28).
