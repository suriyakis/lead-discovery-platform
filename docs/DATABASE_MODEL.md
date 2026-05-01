# Database model

PostgreSQL schema overview. Drizzle is the source of truth — `src/lib/db/schema/*.ts` is canonical. This document describes the **shape** so a reader can navigate the schema and understand the constraints without reading TypeScript.

## Conventions

- **Table names:** `snake_case`, plural (`workspaces`, `product_profiles`).
- **Column names:** `camelCase` in TypeScript, `snake_case` in SQL — Drizzle handles the mapping.
- **Primary keys:** `id BIGSERIAL` for tenant-owned tables. UUID is reserved for cases where IDs leak outside the platform (e.g., shareable links).
- **Timestamps:** `createdAt`, `updatedAt`. Both NOT NULL. `updatedAt` set by application, not trigger, so it's testable.
- **Soft delete:** No global soft-delete column. Tables that need it (e.g., `product_profiles`) get an `active` boolean and the queries filter explicitly.
- **JSONB:** Used for `rawData`, `normalizedData`, free-form connector configs, and learning evidence. Indexed with GIN where queried.
- **Tenant column:** `workspaceId BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE` on every tenant-owned table, with an index. **No exceptions in Phase 1+.**

## Foundation tables (Phase 1)

### `workspaces`
| col | type | notes |
|---|---|---|
| id | bigserial | PK |
| name | text | NOT NULL |
| slug | text | NOT NULL, unique |
| ownerUserId | bigint | FK users.id |
| createdAt | timestamptz | NOT NULL default now() |
| updatedAt | timestamptz | NOT NULL default now() |

### `users`
**Not tenant-owned** — a user can be in multiple workspaces.

| col | type | notes |
|---|---|---|
| id | bigserial | PK |
| email | text | NOT NULL, unique, citext |
| name | text | nullable |
| image | text | nullable |
| role | enum | `member | super_admin`. Platform-wide. Default `member`. |
| createdAt | timestamptz | |
| lastSignedInAt | timestamptz | nullable |

Auth.js requires `accounts` and `sessions` tables — added by the Drizzle adapter. They reference `users.id`.

### `workspace_members`
Joins users to workspaces with per-workspace roles.

| col | type | notes |
|---|---|---|
| id | bigserial | PK |
| workspaceId | bigint | FK workspaces.id, NOT NULL |
| userId | bigint | FK users.id, NOT NULL |
| role | enum | `owner | admin | manager | member | viewer` |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

Unique constraint on `(workspaceId, userId)`.

### `workspace_settings`
Per-workspace typed configuration. One row per workspace.

| col | type | notes |
|---|---|---|
| workspaceId | bigint | PK + FK workspaces.id |
| settings | jsonb | NOT NULL default '{}' — typed via Zod at the service boundary |
| updatedAt | timestamptz | |

### `workspace_secrets`
Encrypted secrets, one row per `(workspaceId, key)`.

| col | type | notes |
|---|---|---|
| workspaceId | bigint | FK workspaces.id |
| key | text | e.g., `serpapi.apiKey`, `imap.password` |
| encryptedValue | bytea | encrypted with workspace data key |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

PK on `(workspaceId, key)`. Decryption happens only inside the secrets module — never logged.

### `audit_log`
Append-only. No update path.

| col | type | notes |
|---|---|---|
| id | bigserial | PK |
| workspaceId | bigint | nullable (some events are platform-level) |
| userId | bigint | nullable (system events) |
| kind | text | e.g., `workspace.create`, `member.role_change`, `lead.approve`, `draft.generate` |
| entityType | text | nullable |
| entityId | text | nullable (text so it can hold non-bigint refs) |
| payload | jsonb | NOT NULL default '{}' |
| createdAt | timestamptz | NOT NULL default now() |

Index on `(workspaceId, createdAt desc)` and `(kind, createdAt desc)`.

### `usage_log`
Append-only. Used for cost dashboards.

| col | type | notes |
|---|---|---|
| id | bigserial | PK |
| workspaceId | bigint | NOT NULL |
| kind | text | `ai.generate_text`, `search.query`, `connector.run`, `storage.bytes`, ... |
| provider | text | e.g., `mock`, `serpapi`, `anthropic` |
| units | bigint | NOT NULL — kind-specific (tokens, queries, bytes) |
| costEstimateCents | integer | nullable |
| payload | jsonb | NOT NULL default '{}' |
| createdAt | timestamptz | |

Index on `(workspaceId, createdAt desc)`.

## Domain tables (Phase 2+)

### `product_profiles` (Phase 2)
Reserved fields are present but optional from day 1 so future modules don't require migrations.

| col | type | notes |
|---|---|---|
| id | bigserial | PK |
| workspaceId | bigint | NOT NULL |
| name | text | NOT NULL |
| shortDescription | text | |
| fullDescription | text | |
| targetCustomerTypes | text[] | default '{}' |
| targetSectors | text[] | default '{}' |
| targetProjectTypes | text[] | default '{}' |
| includeKeywords | text[] | default '{}' |
| excludeKeywords | text[] | default '{}' |
| qualificationCriteria | text | |
| disqualificationCriteria | text | |
| relevanceThreshold | smallint | 0–100, default 50 |
| outreachInstructions | text | |
| negativeOutreachInstructions | text | |
| forbiddenPhrases | text[] | default '{}' |
| language | text | default 'en' |
| active | boolean | NOT NULL default true |
| documentSourceIds | bigint[] | reserved for Phase 9, default '{}' |
| pricingSnapshotId | bigint | reserved, nullable |
| crmMapping | jsonb | reserved, default '{}' |
| createdBy | bigint | FK users.id |
| updatedBy | bigint | FK users.id |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

### `connectors`, `connector_recipes`, `connector_runs` (Phase 3)
Sketch only — full shape decided when the module is built.

`connectors`: id, workspaceId, templateType, name, config (jsonb), credentialsRef (FK workspace_secrets), active.

`connector_recipes`: id, workspaceId, connectorId, name, templateType, seedUrls, searchQueries, selectors (jsonb), paginationRules (jsonb), enrichmentRules (jsonb), normalizationMapping (jsonb), evidenceRules (jsonb), active.

`connector_runs`: id, workspaceId, connectorId, recipeId nullable, productProfileIds (bigint[]), status, progress, startedAt, completedAt, errorPayload (jsonb).

`connector_run_logs`: id, runId, level, message, payload (jsonb), createdAt.

### `source_records`, `companies`, `contacts`, `opportunities`, `projects`, `tenders`, `evidence` (Phase 3)

`source_records` is the canonical pre-classification record. The domain entities (`companies`, `contacts`, ...) are derived. Dedupe key on `source_records`: unique `(workspaceId, sourceSystem, sourceId)`.

`evidence` is a side-table linked to records and qualifications, storing source URLs, snippets, and provenance.

### `qualifications` (Phase 7)
One row per `(sourceRecordId, productProfileId)` with the explainable classification.

### `review_items` (Phase 4)
The review queue. State, assigned user, comments (separate `review_comments` table for history).

### `outreach_drafts` (Phase 8)
Linked to a workspace, product profile, and target entity (company/contact/opportunity).

### `learning_events`, `learning_lessons` (Phase 5)
`learning_events` is append-only raw feedback. `learning_lessons` is the derived, structured knowledge with an `enabled` flag and a reserved `embedding vector(1536)` column for Phase 12.

## Reserved fields and tables (no migration needed for future phases)

These columns / tables are reserved on Phase-1-and-Phase-2 tables so later phases can attach without an "alter table" parade:

- `product_profiles.documentSourceIds bigint[]` (Phase 9)
- `product_profiles.pricingSnapshotId bigint` (Phase 8/optional commercial)
- `product_profiles.crmMapping jsonb` (Phase 13)
- `learning_lessons.embedding vector(1536)` — added when pgvector is enabled in Phase 12; column is nullable

Future tables (RAG, mailing, CRM, billing, qualified-leads pipeline) get added in their own phases. Each will document its own dependencies.

## Indexes that matter

Even at Phase 1 we add the obvious indexes. Adding them later, with millions of rows, is painful.

- `audit_log (workspace_id, created_at desc)`
- `usage_log (workspace_id, created_at desc)`
- `workspace_members (workspace_id, user_id)` unique
- `users (lower(email))` unique (handled by citext or expression index)
- `source_records (workspace_id, source_system, source_id)` unique (added in Phase 3)
- `qualifications (source_record_id, product_profile_id)` unique (added in Phase 7)

## Migrations

Drizzle generates SQL migrations into `drizzle/`. Migrations are committed and applied via `pnpm db:migrate`. **Never edit a checked-in migration.** If the schema needs a fix, generate a new migration.

The `drizzle.config.ts` will pin schema files and migration directory. Do not run `drizzle-kit push` in production; only `drizzle-kit migrate` (apply pre-generated SQL).
