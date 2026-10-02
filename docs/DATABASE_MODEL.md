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

Retention (PC-35): every kind is kept indefinitely except `mail.sync_inbound`
(written only when a sync stored new messages), deleted after 30 days by the
daily `ops.retention.tick`; each retention run that deleted anything writes a
platform `ops.retention.run` row. `usage_log` has no retention (it backs token
debits).

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

`connector_runs`: id, workspaceId, connectorId, recipeId nullable, productProfileIds (bigint[]), status (`pending` / `running` / `succeeded` / `partial` / `failed` / `cancelled`), progress, startedAt, completedAt, errorPayload (jsonb). PC-10: `partial` = finished but some steps (search queries) failed, a run where every query failed is `failed`; `last_progress_at` is the runner's heartbeat (a running run without progress for 15 min is failed by the stuck-work reaper); `cancel_requested_at` is set by Cancel and polled by the runner between steps, so Cancel works from any process.

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

### `outreach_queue` (Phase 19; PC-10)
The send queue: status (`queued` / `sending` / `sent` / `failed` / `skipped` / `cancelled`), scheduled_send_at, attempt_count, last_error, sent_message_id. PC-10 adds `claimed_at` (set when the drain claims the row; a row still `sending` 10 minutes later is settled by the stuck-work reaper: `sent` when a sent copy of its draft exists from the claim on, else `failed` as interrupted), `next_attempt_at` (exponential backoff after a retryable failure; the drain skips the row until then) and `last_failure_kind` (`transient` / `local` / `unknown` / `sender_auth` / `recipient_hard` / `policy` / `interrupted`, CHECK in the migration's custom block; see `src/lib/mail/send-failure.ts`). A delivered send turns `sent` in the same transaction as its `mail_messages` row.

### `learning_events`, `learning_lessons`, `lesson_scopes` (Phase 5, KL-01)
`learning_events` is append-only raw feedback. `learning_lessons` is the derived, structured knowledge ("rules") with an `embedding vector(1536)` column (Phase 12). A review item autopilot approved has `approved_by_user_id` NULL and `approval_reason` 'autopilot' (PC-11, I034); its decision is recorded with origin `autopilot` and no user (KL-02).

KL-01 shape of `learning_lessons`:
- `scope_kind` (`workspace` | `products`). NULL never means "everywhere": a `products` rule applies to exactly its `lesson_scopes` rows, and one with no rows left (its products were deleted) applies nowhere ("Needs a scope").
- `lifecycle` (`active` | `proposed` | `disabled` | `retired`) replaces `enabled`; only `active` rules reach a prompt or scoring step. A retired rule always has `retired_reason` (`stale`, `merged`, `superseded`, `contradicted`, `operator_rejected`, `source_decision_voided`, `absorbed_into_profile`, `product_deleted`, `category_removed`), optionally `retired_note` and `merged_into_id` (self-FK to the surviving rule). CHECK constraints keep reason and lifecycle consistent.
- `polarity` smallint (+1 PREFER, -1 AVOID, 0 neutral; CHECK in (-1, 0, 1)); allowed values per category come from the category registry (`src/lib/services/learning-categories.ts`).
- `cited_count`, `last_cited_at` (citations, filled by KL-04), `reinforced_at` (last outcome-driven confidence change).
- `UNIQUE (workspace_id, id)`, the target of the composite FK below.
- Deprecated until the knowledge-foundation contract PR: `product_profile_id` (its FK now `ON DELETE SET NULL`) and `enabled`, declared as `legacyProductProfileId` / `legacyEnabled`. The migration backfills from them; nothing reads or writes them since, and their values are frozen.

`lesson_scopes(lesson_id, workspace_id, product_profile_id)`, PK `(lesson_id, product_profile_id)`. Both FKs are composite on `workspace_id`: `(workspace_id, lesson_id) -> learning_lessons(workspace_id, id)` and `(workspace_id, product_profile_id) -> product_profiles(workspace_id, id)`, both `ON DELETE CASCADE`. The database itself refuses a scope row joining a rule to another tenant's product; deleting a product drops its scope rows instead of the rules. `product_profiles` carries `UNIQUE (workspace_id, id)` for this.

Every reader filters through `lessonInScope(pid)` in `src/lib/services/learning.ts`: `scope_kind = 'workspace' OR EXISTS (lesson_scopes row [for pid])`. Rollback: `drizzle/rollback/p1_knowledge_foundation_learning_knowledge.down.sql` (the whole lane).

### `learning_decisions` and the decision columns of `learning_events` (KL-02)
`learning_decisions`: one row per decision — `id uuid`, `workspace_id`, `decision_key` (`UNIQUE (workspace_id, decision_key)`: a form nonce, or `autopilot:<run>:<item>`; a repeat records nothing), `kind` (`review.approve` / `reject` / `ignore` / `archive` / `comment`), `origin` (`operator` | `autopilot` | `system`, CHECK), generic `subject_type` / `subject_id` (NULL for a bulk decision), `user_id` (NULL for machines). `UNIQUE (workspace_id, id)` is the target of the events' composite FK.

`learning_events` is the decision log and the learning outbox: `decision_id` (composite FK `(workspace_id, decision_id)`, CASCADE), `origin`, `verdict` (`fit` / `not_fit` / NULL for an unscoped event or a comment), `polarity`, `weight` numeric(3,2) (1, or 0.5 for an untouched default and for archive / ignore), `explicit`, `reason_codes`, `context` jsonb (record snapshot: normalized domain — never a Vertex redirect — countries, per-product AI verdict / method / score / threshold / reason / cited rules, evidence quality, connector and recipe ids, product names), outbox state `processing_status` (`pending` → `processing` → `done` / `no_rule` / `below_floor` / `skipped_no_tokens` / `skipped` / `failed`), `attempts`, `next_attempt_at`, `last_error`, `processed_at`, and supersession `voided_at`, `voided_by_event_id` (self-FK), `void_reason` (`changed_mind` / `undo` / `autopilot_override`), `overrides_autopilot`. All written in the transaction of the state change (`recordDecision`, `src/lib/services/learning-decisions.ts`). Rows from before KL-02 keep `decision_id` NULL and `processing_status` `done`. Rollback: `drizzle/rollback/p1_knowledge_foundation_learning_knowledge.down.sql` (the whole lane).

### `lesson_reinforcements` and the processor columns of `learning_events` (KL-03)
`learning_events` gains `claimed_at` (the learning processor's claim token; `learning.sweep` releases claims older than 10 minutes) and `processing_note` (why the processor closed the row: `rule_created`, `rule_created_from_verdict`, `rule_strengthened`, `matches_rejected_rule`, `nothing_to_learn`, `below_floor`, `no_tokens`, `no_ai_provider`, `held` (the automation gate holds Background AI: the workspace pause, a hold, no accountable owner), `voided`, `failed`, `rejected:<reason>` …), plus partial indexes for events waiting for tokens and for `voided_by_event_id`. Learned rules carry `learning_lessons.source = 'decision'`.

`lesson_reinforcements` is the reinforcement ledger: one row per confidence change a decision causes on a rule — `workspace_id`, `lesson_id` (composite FK `(workspace_id, lesson_id) -> learning_lessons`, CASCADE), `event_id` (FK `learning_events`, CASCADE), `kind` (`cited` | `dedup_match` | `compensation`, CHECK), `delta_requested`, `delta_applied`, `confidence_before`, `confidence_after` (CHECK `after − before = delta_applied`, both 0..100), `compensates_id` (self-FK, `UNIQUE`; set iff `kind = 'compensation'`, CHECK), `reason`, `created_at`. A partial `UNIQUE (event_id, lesson_id) WHERE compensates_id IS NULL` keeps one forward row per (event, rule), so a re-run never moves a rule twice; a compensation row reverses one forward row exactly. Written only by `src/lib/services/learning-ledger.ts`, in the transaction that changes `learning_lessons.confidence`. Rollback: `drizzle/rollback/p1_knowledge_foundation_learning_knowledge.down.sql` (the whole lane).

### `knowledge_sources`, `knowledge_source_products`, `document_chunks` (KL-05)
A knowledge source wraps a document (`kind = 'document'`, `document_id`), a URL or a text excerpt. A document is only the bytes; it reaches retrieval through the source wrapping it, and a document is wrapped by at most one source (`createKnowledgeSource` refuses a second one with `document_has_source`).

- `knowledge_sources.scope_kind` (`workspace` | `products`; every writer states it — the default `products` exists only for the additive migration and is the safe side: a source written without a scope "Needs a scope", it is never workspace-wide). `workspace` = every product. `products` = exactly the `knowledge_source_products` rows; one with no row left (its products were deleted) "Needs a scope" and is retrieved nowhere. `UNIQUE (workspace_id, id)` is the target of the composite FKs below. The FK-less `product_profile_ids` array and `product_profiles.document_source_ids` are deprecated (declared as `legacyProductProfileIds` / `legacyDocumentSourceIds`, never read or written, frozen) until the contract PR drops them.
- `knowledge_source_products(source_id, workspace_id, product_profile_id)`, PK `(source_id, product_profile_id)`. Both FKs are composite on `workspace_id` and `ON DELETE CASCADE`: `(workspace_id, source_id) -> knowledge_sources(workspace_id, id)` and `(workspace_id, product_profile_id) -> product_profiles(workspace_id, id)`. The database refuses another tenant's product; deleting a product drops its rows.
- `document_chunks.knowledge_source_id` is `NOT NULL` with the composite FK `(workspace_id, knowledge_source_id) -> knowledge_sources(workspace_id, id)` (CASCADE): every chunk has exactly one owner in its own workspace. `document_chunks.document_id` is legacy and no longer written — before KL-05 a NULL source meant "workspace-wide", which is how a product-scoped document leaked into every product (I039).

One predicate decides whether a chunk may reach a prompt — `knowledgeSourceRetrievable` in `src/lib/services/knowledge-scope.ts`, used by `retrieve()`, `getProductKnowledgeCoverage` (product and workspace-wide counts separately), Suggest reply (the thread's lead product) and the pgvector provider query: `ks.workspace_id = $ws AND NOT EXISTS (archived document of ks) AND (ks.scope_kind = 'workspace' OR EXISTS (knowledge_source_products row [for $pid]))`. Archiving a document excludes its sources at once; restoring brings them back without re-indexing. url / text sources have no document and stay retrievable.

Migration (custom block part C of `p1_knowledge_foundation_learning_knowledge`): a product source with no chunks of its own adopts a copy of its document's document-level chunks; then the document-level chunks of documents that have a source with products ticked are deleted (the I039 shadow copies); the scope rows are backfilled from the array (own-workspace products only); every remaining document with document-level chunks ends up with exactly one workspace-wide source — its existing unscoped source (the oldest; that source's own duplicate chunks go) or a new one — that owns those chunks (moved, not re-embedded); then `NOT NULL` and the composite FK. `scripts/remediation/knowledge-scope-report.ts` (read-only) prints the counts and the owner-review list before the deploy. Rollback: `drizzle/rollback/p1_knowledge_foundation_learning_knowledge.down.sql` (the whole lane).

### Indexing pipeline: `documents` cache, `knowledge_sources` status, `indexing_jobs` outbox (KL-06)
- `documents.extracted_text`, `extractor` (`text` / `html` / `pdf` / `docx` / `ocr:<provider>/<model>`), `extracted_at`, `extracted_sha256` (the bytes it came from — the cache is valid only while it equals `sha256`), `detected_language`, `page_count` (drives the OCR cost estimate). Written once, right after extraction and before embedding; a document with the same `sha256` in the workspace reuses it. OCR runs once per document SHA; only the admin's "Re-extract with OCR" replaces an existing cache.
- `knowledge_sources.index_status` (enum `knowledge_index_status`: `queued` / `indexing` / `indexed` / `stale` / `failed`, default `stale` = not indexed yet), `indexed_at`, `indexed_content_hash` + `indexed_embedding_model` (stamped in the chunk-swap transaction; same hash and model = no re-embed), `last_index_error`. `external_*` still records the vector-storage provider's attach result.
- `indexing_jobs` is the `knowledge.index` outbox: `status` (`queued` / `running` / `succeeded` / `failed`, CHECK), `attempts`, `next_attempt_at` (retry backoff, or deferred while another run holds the source), `force_ocr`, `reason` (`create` / `edit` / `reindex` / `document` / `reextract_ocr`), `note` (`embedded` / `unchanged` / `superseded` / `timed_out`). Partial unique indexes (created in the migration's custom block, after closing legacy rows): one `queued` and one `running` row per `knowledge_source_id`.
- `product_vector_stores.usage_bytes` / `file_count` on the pgvector rail are derived from the chunks of the product's sources after every attach and detach, so re-indexing no longer inflates them and deleting a source brings them down.

Migration (custom block part D of `p1_knowledge_foundation_learning_knowledge`): additive DDL; the custom block closes legacy `running` rows (a crashed request, I108) and queued document-level rows, keeps the newest queued row per source, creates the two partial unique indexes and backfills `index_status` (queued run → `queued`; `external_status = 'failed'` → `failed`; no chunks, or a text / URL source edited more than a minute after its chunks → `stale`; otherwise `indexed` with its chunks' time and model, hash NULL). Nothing is re-indexed by the migration. Rollback: `drizzle/rollback/p1_knowledge_foundation_learning_knowledge.down.sql` (the whole lane).

### The knowledge-foundation lane migration (`p1_knowledge_foundation_learning_knowledge`)
KL-01, KL-02, KL-03, KL-05 and KL-06 ship as ONE migration that regenerates mechanically: the file is the verbatim output of `pnpm db:generate --name p1_knowledge_foundation_learning_knowledge` against the final schema, followed by one `-- custom:begin … -- custom:end` block (backfills, then the objects below). No intermediate schema is needed and drizzle-kit asks nothing: the lane only adds (the legacy columns above stay declared as deprecated `legacy*` properties). To regenerate, run the command and append the block unchanged.

DB-only objects, created by the block and deliberately NOT declared in the TypeScript schema: the six composite tenant FKs `lesson_scopes_lesson_fk`, `lesson_scopes_product_fk`, `lesson_reinforcements_lesson_fk`, `knowledge_source_products_source_fk`, `knowledge_source_products_product_fk` and `document_chunks_knowledge_source_fk` (drizzle-kit emits every FK before every `UNIQUE` it adds to an existing table, so a declared FK would be created before the `UNIQUE (workspace_id, id)` it needs and Postgres would refuse it); `document_chunks.knowledge_source_id NOT NULL` (true only after the backfill; declared nullable in TS); and the two partial unique indexes on `indexing_jobs` (only creatable after the cleanup). `src/tests/db-only-constraints.test.ts` fails if a regeneration loses one, if the schema declares one again, or if the block creates an object it does not know.

The later contract PR: drop `learning_lessons.product_profile_id` / `enabled`, `knowledge_sources.product_profile_ids`, `product_profiles.document_source_ids` and the `knowledge_sources.scope_kind` default, and declare `document_chunks.knowledge_source_id` `notNull()` (the generated `SET NOT NULL` is a no-op on the live database).

### `remediation_runs`, `remediation_log` (Phase 0, flow:F-06)
Bookkeeping for the versioned data-remediation scripts (`scripts/remediation/`). Not tenant-owned: a run spans workspaces and is driven by a platform super admin.

`remediation_runs`: id (text, the dry-run batch id), script, module, plan_hash, decisions_hash, options (jsonb), status (`applying` / `applied` / `failed` / `reverted` / `revert_partial`), summary (jsonb: per-category counts, post-apply checks), error, applied_by / started_at / finished_at, reverted_by / reverted_at.

`remediation_log`: one row per changed row — run_id, workspace_id, category (`R1a`, `R4`, …), table_name (allow-listed), row_id, action (`update` / `delete` / `ledger_credit`), before / after (jsonb images: the changed columns for an update, the whole row for a delete), reverted_at.

### `workspace_holds` (Phase 1, PC-06)
Holds stop work in one workspace (tenant-owned, cascade on workspace delete). kind (`hold` / `note` — a note is a legacy flag with no capability, never enforced), scope (`all` / `capabilities`), capabilities (`automation_capability[]`: sending, inbox_sync, inbound_actions, discovery, autopilot, crm_sync, background_ai, auto_topup), state (`active` / `pending_review` / `released` / `discarded`), source (`tenant` / `platform`), reason, blocks_access (enforced from PC-21), expires_at (NULL = until released), placed_by / placed_at, confirmed_by / confirmed_at, ended_by / ended_at / end_reason, legacy_flag_key (unique per workspace — makes the feature_flags import idempotent), history (jsonb, every transition). CHECK constraints keep the shape honest (a hold has scope `all` with no list or a non-empty list; a note has an empty list and is only pending or discarded; the reason is never blank). Only `active`, unexpired `hold` rows are enforced, by `services/automation-gate.ts`.

`workspaces.automation_owner_incident_at`: set once when automation first finds no accountable owner (the incident), cleared when the owner is back.

`feature_flags` is legacy: nothing reads it, the console no longer writes it, and it is dropped one release after `scripts/remediation/import-legacy-feature-flags.ts --apply` has run.

### The workspace pause, the go-live hold and `workspace_automation_state` (Phase 1, PC-05)
`workspaces.automation_paused_at` (NULL = running; set from the database clock under a row lock), `automation_paused_by_user_id`, `automation_pause_reason`, `automation_pause_source`: the single workspace pause (`services/automation-pause.ts`). `workspaces.outreach_live_at` / `outreach_live_by_user_id`: the go-live hold (NULL = not live: cold, follow-up and AI-reply mail is held; set by a super-admin, `services/go-live.ts`). `outreach_queue.claimed_at`: when the drain last claimed the row (database clock; never after `automation_paused_at`). `automation_capability` gains `trash_purge`.

View `workspace_automation_state` (plain, not materialized): one row per workspace with every workspace-level gate input — workspace_status, owner_user_id, owner_account_status, owner_is_member, owner_incident_at, paused_at / paused_by_user_id / pause_reason / pause_source, outreach_live_at / outreach_live_by_user_id, wallet_has_tokens (billing-exempt or a positive balance), billing_exempt, plan, subscription_status. The gate and the ticks read it.

`autopilot_settings.emergency_pause` and `outreach_send_settings.emergency_pause` are legacy: migrated into the pause (a workspace started paused if either was on), read by nothing, written only as a mirror of the pause, and dropped one release later.

### Product overrides, the product pause and the dead toggles (Phase 1, PC-13)
`autopilot_product_settings` is narrow-only: each override switch (`autopilot_enabled`, `enable_auto_approve_projects`, `enable_auto_enqueue_outreach`, `enable_auto_crm_contact_sync`, `enable_auto_crm_deal_on_qualified`) is NULL (inherit) or false (off) — CHECK `autopilot_product_settings_narrow_only_check`; `auto_approve_threshold` only ever raises the workspace's (the resolver takes the higher). `paused_at` / `paused_by_user_id` (FK users, set null): the product pause. `emergency_pause` is legacy (never applied, carried into `paused_at` by migration `p1_automation_control_policy`, cleared, read by nothing, dropped one release later). `services/automation-policy.ts` is the only reader.

`autopilot_settings.enable_auto_drain_queue`, `autopilot_settings.enable_auto_sync_inbound` and `workspaces.auto_send_replies` are legacy: read and written by nothing, set to false by the migration, dropped one release later.
### `job_heartbeats`, `ops_events` (Phase 1, PC-07)
Operational visibility (I021/I022). Not tenant-owned bookkeeping, written by background jobs (no user acts). See `docs/OPS_MONITORING.md`.

`job_heartbeats`: one row per job name (every repeatable tick in `src/lib/jobs/tick-catalog.ts`, incl. PC-10's `ops.reaper.tick` and PC-35's `ops.retention.tick`, and the on-demand `connector.run`). name (pk), kind (`tick` / `job`), interval_ms, queue_provider, boot_id + registered_at (written by the schedule registration at boot), last_started_at / last_finished_at / last_ok_at, last_status (`running` / `ok` / `degraded` / `failed`), last_duration_ms, last_error (masked) + last_error_at, last_summary (jsonb, the handler's structured summary), next_due_at (informational), run_count, consecutive_failures. Staleness is computed on read, never stored. A row whose name is no longer a catalogued tick and that was not written for 90 days is deleted by the retention tick (PC-35).

`ops_events`: the incident stream. scope (`platform` / `workspace`; a CHECK ties `workspace_id` to it), workspace_id (cascade), kind, severity (`info` / `warning` / `error` / `critical`), source (job or subsystem), dedupe_key, fingerprint (sha256 over scope + workspace + kind + dedupe key), title, message (masked), payload (jsonb, masked), occurrences, first_seen_at / last_seen_at, acknowledged_at / acknowledged_by, resolved_at / resolved_by / resolution (`auto` / `manual`). A partial unique index keeps one open row per fingerprint, so repeats bump `occurrences`. Resolved rows are kept 90 days after `resolved_at` (`OPS_EVENTS_RETENTION_DAYS`), then deleted by the retention tick (PC-35); open rows are never deleted.

### `ops_alert_state`, `ops_alert_deliveries` (Phase 1, PC-08)
Owner alerting to ntfy (see `docs/OPS_MONITORING.md`, "Owner alerts"). Not tenant-owned; written by the in-process watchdog, the control-change hook and the console's test alert.

`ops_alert_state`: one row per alert key: an incident fingerprint, a control-change key (`control:<control>:<workspace>:<hold>:<action>`) or `digest:daily`. alert_key (pk), last_alerted_at, last_event_id (the `ops_events` row last alerted, set null on delete), alert_count (CHECK >= 1). Claiming a key is an upsert guarded by `last_alerted_at <= cutoff`, so an alert goes out once across processes; the key outlives the incident row so a flapping incident does not page again within 6 h. A key not alerted for 90 days is deleted by the retention tick (PC-35).

`ops_alert_deliveries`: every message sent or attempted. kind (`incident` / `digest` / `daily_digest` / `control` / `test`), sink (`ntfy`), status (`sent` / `failed`), title (masked), priority (1-5), event_count, payload (jsonb: alert keys and event ids, bounded), http_status, error (masked, scrubbed of the topic and token), created_at. The hourly budget counts `sent` incident and digest rows. Same 90-day retention as `ops_events`, by created_at (the retention tick, PC-35).

### Autopilot guard state and log retention (Phase 1, PC-35)
`autopilot_settings.guard_state` (text, NULL = never evaluated) + `guard_state_at`: the guard state the last autopilot run recorded, `open` or the reason it stopped the run (`autopilot_disabled`, or the automation gate's refusal: `paused`, `hold:<id>`, `no_accountable_owner`, `plan_no_autopilot`, …). A `guard` row reaches `autopilot_log` only when it changes (payload `{state, previous}`; back to `open` logs `guard · success — resumed`). The migration seeds it for workspaces with autopilot off (`autopilot_disabled`) or a paused workspace (`paused`, from `workspaces.automation_paused_at`). `autopilot_log` rows are kept 30 days (index `autopilot_log_created_idx`), read `notifications` 90 days by created_at (partial index `notifications_read_created_idx`). The policies are in `src/lib/services/retention.ts`; see `docs/OPS_MONITORING.md`, "Log retention". CHECKs on kind, status, priority and event_count live in the migration's custom block.

### `work_leases` and follow-up claims (Phase 1, PC-12)
`work_leases`: one row per piece of work being done in a workspace (tenant-owned, cascade on workspace delete). Primary key (workspace_id, kind, resource_key). kind: `autopilot.run`, `outreach.drain`, `outreach.follow_up`, `mailbox.sync`, `connector.recipe` (CHECK `work_leases_kind_check`); resource_key: the mailbox id for `mailbox.sync`, the recipe id for `connector.recipe`, `''` for the others (CHECK `work_leases_resource_key_check`). holder (the acquisition's random token; renew and release match it), holder_label (process role, host, pid, boot id), purpose (`tick`, `manual`, `post-crawl`, `Retry now`, `run <id>`, …), acquired_at, renewed_at, expires_at — all from the database clock. Acquired by an upsert guarded by `expires_at < clock_timestamp()`, deleted on release; an expired row is a holder that died and is overwritten by the next acquire (index `work_leases_expires_idx`); one nobody acquires again (a deleted mailbox's or recipe's) is deleted by the retention tick 7 days after it expired (policy `work_leases.expired`). See `src/lib/services/work-leases.ts`.

`outreach_follow_ups.status` gains `processing` (a follow-up pass claimed the step; it has no tab of its own, the Scheduled tab lists it), with `claimed_at` (set by the claim; CHECK `outreach_follow_ups_processing_claim_check`: a `processing` row always has it) and `sending_at` (set just before the step is handed to the mail server). The stuck-work reaper settles a claim older than 30 minutes that no live lease may own: no `sending_at` → back to `pending`; `sending_at` → `sent` when an outbound copy is on the thread from then on, else `failed` (`Interrupted: delivery unknown`). Rollback: `drizzle/rollback/p1_workers_work_leases.down.sql`.

### `rate_limit_buckets`, `qualification_runs` and action leases (Phase 1, PC-38)
`rate_limit_buckets`: the shared rate limiter's fixed windows (`src/lib/rate-limit.ts`), one row per key (`assistant:ws:<id>`, `assistant:user:<id>`, `translate:ws:<id>`, `suggest-reply:ws:<id>`, `signature-redesign:ws:<id>`, `action:<name>:ws:<id>`). key (pk, 1–200 characters), window_start, count (requests let through in the window, CHECK ≥ 1), expires_at (window_start + the window, CHECK > window_start; index `rate_limit_buckets_expires_idx`). Not tenant-owned (a key may name a workspace or a user), so no foreign key. A check is one upsert guarded by `expires_at <= clock_timestamp() OR count < limit`: a returned row means allowed, none means rejected (not counted). Rows whose window ended more than a day ago are deleted by the retention tick (policy `rate_limit_buckets.expired`).

`qualification_runs`: one "Re-classify all" run (tenant-owned, cascade on workspace delete). status `queued` / `running` / `succeeded` / `stopped` / `failed` (CHECK); stop_reason `no_tokens` / `held` / `lease_lost`, set exactly when stopped (CHECK); error (operator-safe sentence for `failed`); requested_by (users, set null on delete); up_to_record_id and total_records (the records that existed when it was requested: the run covers source records with id ≤ up_to_record_id), product_count (active products then); progress: processed_records, qualification_count, failed_records (CHECK non-negative, failed ≤ processed), last_record_id (the cursor); job_id; created_at, started_at, heartbeat_at (written after every batch), finished_at. Partial unique index `qualification_runs_one_active_idx` on workspace_id where status is `queued` or `running`: one active run per workspace. See `src/lib/services/qualification-runs.ts`.

`work_leases.kind` gains `action`: single-flight for an operator's button, resource_key = the action's name, optionally `:<id>` (`learning.synthesize`, `crawl_plan.run_now:7`; CHECK `work_leases_resource_key_check`), purpose `action:<name>`. Rollback: `drizzle/rollback/p1_workers_ai_action_guards.down.sql`.

## Reserved fields and tables (no migration needed for future phases)

These columns / tables are reserved on Phase-1-and-Phase-2 tables so later phases can attach without an "alter table" parade:

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
