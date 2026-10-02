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

KL-02 adds the operator's verdict as domain state: `operator_verdict` (`fit` | `not_fit`, CHECK), `operator_decided_by`, `operator_decided_at` (set iff a verdict is, CHECK), `operator_event_id` (FK `learning_events`, SET NULL) and the human location confirmation `geo_confirmed_by` / `geo_confirmed_at`. Only an operator decision (review.ts, inside the decision's transaction) writes them; re-classification never does. `not_fit` blocks Promote, `ensureQualifiedLead`, `generateOutreachDraft` and autopilot's auto-enqueue for the pair.

### `review_items` (Phase 4)
The review queue. State, assigned user, comments (separate `review_comments` table for history).

### `outreach_drafts` (Phase 8)
Linked to a workspace, product profile, and target entity (company/contact/opportunity).

### `learning_events`, `learning_lessons`, `lesson_scopes` (Phase 5, KL-01)
`learning_events` is append-only raw feedback. `learning_lessons` is the derived, structured knowledge ("rules") with an `embedding vector(1536)` column (Phase 12).

KL-01 shape of `learning_lessons`:
- `scope_kind` (`workspace` | `products`). NULL never means "everywhere": a `products` rule applies to exactly its `lesson_scopes` rows, and one with no rows left (its products were deleted) applies nowhere ("Needs a scope").
- `lifecycle` (`active` | `proposed` | `disabled` | `retired`) replaces `enabled`; only `active` rules reach a prompt or scoring step. A retired rule always has `retired_reason` (`stale`, `merged`, `superseded`, `contradicted`, `operator_rejected`, `source_decision_voided`, `absorbed_into_profile`, `product_deleted`, `category_removed`), optionally `retired_note` and `merged_into_id` (self-FK to the surviving rule). CHECK constraints keep reason and lifecycle consistent.
- `polarity` smallint (+1 PREFER, -1 AVOID, 0 neutral; CHECK in (-1, 0, 1)); allowed values per category come from the category registry (`src/lib/services/learning-categories.ts`).
- `cited_count`, `last_cited_at` (citations, filled by KL-04), `reinforced_at` (last outcome-driven confidence change).
- `UNIQUE (workspace_id, id)`, the target of the composite FK below.

`lesson_scopes(lesson_id, workspace_id, product_profile_id)`, PK `(lesson_id, product_profile_id)`. Both FKs are composite on `workspace_id`: `(workspace_id, lesson_id) -> learning_lessons(workspace_id, id)` and `(workspace_id, product_profile_id) -> product_profiles(workspace_id, id)`, both `ON DELETE CASCADE`. The database itself refuses a scope row joining a rule to another tenant's product; deleting a product drops its scope rows instead of the rules. `product_profiles` carries `UNIQUE (workspace_id, id)` for this.

Every reader filters through `lessonInScope(pid)` in `src/lib/services/learning.ts`: `scope_kind = 'workspace' OR EXISTS (lesson_scopes row [for pid])`. Rollback of the KL-01 migrations: `drizzle/rollback/p1_knowledge_foundation_lesson_scopes.down.sql`.

### `learning_decisions` and the decision columns of `learning_events` (KL-02)
`learning_decisions`: one row per decision — `id uuid`, `workspace_id`, `decision_key` (`UNIQUE (workspace_id, decision_key)`: a form nonce, or `autopilot:<run>:<item>`; a repeat records nothing), `kind` (`review.approve` / `reject` / `ignore` / `archive` / `comment`), `origin` (`operator` | `autopilot` | `system`, CHECK), generic `subject_type` / `subject_id` (NULL for a bulk decision), `user_id` (NULL for machines). `UNIQUE (workspace_id, id)` is the target of the events' composite FK.

`learning_events` is the decision log and the learning outbox: `decision_id` (composite FK `(workspace_id, decision_id)`, CASCADE), `origin`, `verdict` (`fit` / `not_fit` / NULL for an unscoped event or a comment), `polarity`, `weight` numeric(3,2) (1, or 0.5 for an untouched default and for archive / ignore), `explicit`, `reason_codes`, `context` jsonb (record snapshot: normalized domain — never a Vertex redirect — countries, per-product AI verdict / method / score / threshold / reason / cited rules, evidence quality, connector and recipe ids, product names), outbox state `processing_status` (`pending` → `processing` → `done` / `no_rule` / `below_floor` / `skipped_no_tokens` / `skipped` / `failed`), `attempts`, `next_attempt_at`, `last_error`, `processed_at`, and supersession `voided_at`, `voided_by_event_id` (self-FK), `void_reason` (`changed_mind` / `undo` / `autopilot_override`), `overrides_autopilot`. All written in the transaction of the state change (`recordDecision`, `src/lib/services/learning-decisions.ts`). Rows from before KL-02 keep `decision_id` NULL and `processing_status` `done`. Rollback: `drizzle/rollback/p1_knowledge_foundation_decision_record.down.sql`.

### `remediation_runs`, `remediation_log` (Phase 0, flow:F-06)
Bookkeeping for the versioned data-remediation scripts (`scripts/remediation/`). Not tenant-owned: a run spans workspaces and is driven by a platform super admin.

`remediation_runs`: id (text, the dry-run batch id), script, module, plan_hash, decisions_hash, options (jsonb), status (`applying` / `applied` / `failed` / `reverted` / `revert_partial`), summary (jsonb: per-category counts, post-apply checks), error, applied_by / started_at / finished_at, reverted_by / reverted_at.

`remediation_log`: one row per changed row — run_id, workspace_id, category (`R1a`, `R4`, …), table_name (allow-listed), row_id, action (`update` / `delete` / `ledger_credit`), before / after (jsonb images: the changed columns for an update, the whole row for a delete), reverted_at.

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
