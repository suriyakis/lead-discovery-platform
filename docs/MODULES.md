# Modules

Each module owns a slice of the domain: its tables, its service API, its types, and its tests. Modules are independent — they talk through service APIs, never by reaching into each other's tables.

This document is a reference; deep details live in each module's own README (added when the module is built).

## Foundation modules (Phase 1)

### Workspace

**Purpose.** Tenant boundary, members, roles, settings.

**Tables.** `workspaces`, `users`, `workspace_members`, `workspace_settings`, `sessions` (auth.js).

**Service API.**
- `createWorkspace(ctx, { name, ownerUserId }) -> Workspace`
- `getWorkspace(ctx) -> Workspace`
- `updateWorkspaceSettings(ctx, patch) -> WorkspaceSettings`
- `addMember(ctx, { userId, role }) -> WorkspaceMember`
- `removeMember(ctx, userId) -> void`
- `setMemberRole(ctx, userId, role) -> WorkspaceMember`
- `listMembers(ctx) -> WorkspaceMember[]`

**Roles.** `owner | admin | manager | member | viewer`. Plus a platform-wide `super_admin` granted only to the bootstrap user (whose email matches `OWNER_EMAIL`).

**Permission rules.**
- `owner`, `admin` — full workspace control, including settings and member management.
- `manager` — runs discovery, reviews queue, creates drafts. No settings, no member management.
- `member` — works on assigned records. Can comment, approve/reject only items assigned to them.
- `viewer` — read-only.

**Audit.** Workspace create, member add/remove/role-change, settings change. All emit `audit_log` entries.

### Audit + Usage logs

**Purpose.** Append-only history of who did what (audit) and what cost what (usage).

**Tables.** `audit_log`, `usage_log`. Both indexed on `(workspace_id, created_at desc)`.

**Service API.**
- `recordAuditEvent(ctx, { kind, entityType, entityId, payload }) -> AuditLog`
- `recordUsage(ctx, { kind, provider, units, costEstimateCents, payload }) -> UsageLog`
- `listAuditEvents(ctx, filter) -> AuditLog[]`
- `summarizeUsage(ctx, range) -> UsageSummary`

**Read paths.** Admin dashboards, the per-workspace cost view, eventually the super-admin overview.

### Settings + Secrets

**Purpose.** Workspace-scoped configuration (provider choices, default outreach style, usage limits) and **encrypted secrets** (provider API keys, IMAP credentials).

**Tables.** `workspace_settings` (typed JSONB), `workspace_secrets` (encrypted at rest).

**Service API.**
- `getSetting(ctx, key) -> T`
- `setSetting(ctx, key, value)`
- `getSecret(ctx, key) -> string`  (decrypts on read; never logged)
- `setSecret(ctx, key, value)`

**Encryption.** Workspace secrets are encrypted with a per-workspace data key, which is wrapped by a server-wide master key from `MASTER_KEY` env var. Master key rotation is documented in `docs/DEPLOYMENT.md`.

## Domain modules (Phase 2+)

### Product Profile

**Phase.** 2.

**Purpose.** Represents something the workspace wants to sell. **Generic.** Construction products, software, consultancy, machinery, services — all use the same shape.

**Table.** `product_profiles`.

**Fields.** `name`, `shortDescription`, `fullDescription`, `targetCustomerTypes[]`, `targetSectors[]`, `targetProjectTypes[]`, `includeKeywords[]`, `excludeKeywords[]`, `qualificationCriteria` (text), `disqualificationCriteria` (text), `relevanceThreshold` (0–100), `outreachInstructions` (text), `negativeOutreachInstructions` (text), `forbiddenPhrases[]`, `language`, `active`, `createdBy`, `updatedBy`.

**Future hooks (reserved fields).** `documentSourceIds[]`, `pricingSnapshotId`, `crmMapping` (JSONB), `learningMemoryScopeId`.

**Rule.** Product-specific behavior comes from this table. Never hard-coded in services.

### Connector Framework

**Phase.** 3.

**Purpose.** Pluggable discovery sources. New sources are usually new **recipes** under existing **templates**, not new code.

**Tables.** `connectors`, `connector_recipes`, `connector_runs`, `connector_run_logs`.

**Templates initially.**
1. `internet_search` — uses `ISearchProvider`.
2. `directory_harvester` — selectors + pagination over a known directory.
3. `tender_api` — typed pulls from public tender APIs.
4. `csv_import` — file upload + column mapping.

**Service API.**
- `registerConnectorTemplate(template)` — at boot
- `createConnector(ctx, { templateId, name, config, credentials })`
- `createRecipe(ctx, { connectorId, recipe })`
- `runConnector(ctx, { connectorId | recipeId, productProfileIds[] }) -> ConnectorRunId`
- `getRun(ctx, runId) -> ConnectorRun`

**Run lifecycle.** `pending → running → succeeded | failed | cancelled`. Each run produces `source_records` (next module).

### Source Records

**Phase.** 3.

**Purpose.** Normalize what connectors found into common objects.

**Tables.** `source_records`, `companies`, `contacts`, `opportunities`, `projects`, `tenders`, `evidence`.

**Dedupe keys.** `(workspace_id, source_system, source_id)` is unique. Soft dedupe across that uses domain match, normalized name similarity, email, phone, and source URL — but **never across workspaces**.

**Service API.**
- `ingestSourceRecord(ctx, raw) -> SourceRecord` — handles dedupe and normalization
- `linkRecordToCompany(ctx, recordId, companyId)`
- `splitDuplicate(ctx, recordId)` — undo a soft dedupe

### Qualification Engine

**Phase.** 7.

**Purpose.** Classify each source record against each active product profile.

**Table.** `qualifications` — one row per `(record, product_profile)`.

**Inputs.**
- Rules: keyword match, sector match, evidence quality.
- AI: optional, via `IAIProvider` (provider-agnostic).
- Learning memory: relevant lessons retrieved by product profile.

**Output fields.** `isRelevant`, `relevanceScore`, `qualificationReason`, `rejectionReason`, `matchedKeywords[]`, `disqualifyingSignals[]`, `confidence`, `evidence[]`, `method` (rules/ai/hybrid), `model` (if AI).

**Rule.** Every qualification is **explainable**. The user must always be able to see why a lead was approved or rejected.

### Review Queue

**Phase.** 4.

**Purpose.** Everything discovered goes through review before further action.

**Table.** `review_items`.

**States.** `new | needs_review | approved | rejected | ignored | duplicate | archived`.

**Actions.** `approve`, `reject`, `comment`, `assign`, `request_more_research`, `generate_draft`, `archive`. Each action produces an `audit_log` entry; comments also produce a `learning_event` entry.

### Outreach Drafts

**Phase.** 8.

**Purpose.** Generate draft emails/messages. **No automatic sending in early phases.**

**Table.** `outreach_drafts`.

**Style source.** Product profile's `outreachInstructions`, `negativeOutreachInstructions`, `forbiddenPhrases`. Plus the workspace-wide outreach defaults. Plus relevant learning memory.

**States.** `draft | review | approved | rejected | sent` (sent is reserved for the email module phase).

### Learning Layer

**Phase.** 5 (foundation), 12 (vector store).

**Purpose.** Capture user feedback as structured lessons that influence future qualification, drafts, and recommendations.

**Tables.** `learning_events`, `learning_lessons`.

**`LearningEvent`.** Raw input: workspace, user, entity, action, original comment, optional product profile context.

**`LearningLesson`.** Extracted, durable lesson. Categories: `qualification_positive | qualification_negative | outreach_style | contact_role | sector_preference | connector_quality | false_positive | false_negative | dedupe_hint | general_instruction | reply_quality | product_positioning`.

**Service API.**
- `recordFeedback(ctx, event)` — append + run extraction synchronously or as a job
- `getRelevantLessons(ctx, { productProfileId, taskType, contextText }) -> Lesson[]`
- `applyLessonsToPrompt(basePrompt, lessons) -> string`
- `disableLesson(ctx, id) / updateLesson(ctx, id, patch)`

**Vector store.** Reserved for Phase 12. The `learning_lessons` table has an `embedding` column (nullable) so the migration is additive when we add it.

### AI Provider

**Phase.** 1 (interface + mock), 7+ (real providers wired).

See `IAIProvider` in `docs/ARCHITECTURE.md`.

### Search Provider

**Phase.** 3 (interface + mock), 6+ (real providers wired).

See `ISearchProvider` in `docs/ARCHITECTURE.md`.

### Job System

**Phase.** 1 (interface + in-memory impl), 6+ (BullMQ for production).

See `IJobQueue` in `docs/ARCHITECTURE.md`. Job types defined as the system grows: `run_connector`, `run_recipe`, `enrich_website`, `classify_records`, `generate_draft`, `process_feedback`, `extract_document_text` (later), `sync_crm` (later), `sync_email` (later).

### File Storage

**Phase.** 1 (interface + local-FS impl), 9+ (S3-compatible for production).

See `IStorage` in `docs/ARCHITECTURE.md`.

## Future modules

These are sketched in the brief but **not implemented** in Phase 1. The data model has reserved hooks for each.

- **Document storage + RAG** (Phase 9 + 12). Tables: `documents`, `document_chunks`, `knowledge_sources`. RAG via vector index in Phase 12.
- **Mailing client** (Phase 10). Tables: `mailboxes`, `mail_messages`, `mail_threads`, `signatures`, `suppression_list`.
- **Qualified leads pipeline** (Phase 11). Table: `qualified_leads` with extended state machine separating raw discovery, qualification, outreach, and CRM hand-over.
- **CRM export** (Phase 13). Tables: `crm_connections`, `crm_sync_log`. Excel/CSV first, HubSpot/Pipedrive/Salesforce later.
- **God Mode** (Phase 14). Platform-wide super admin views and impersonation. Audit-heavy.
- **Notifications** (later). In-app + email + Telegram/Slack.
- **Billing** (later). Plan limits + usage caps.

## Module template

When you build a new module, drop a `README.md` in `src/lib/services/<module>/` covering: purpose, public API, table list, error types, dependencies on other modules, and known limitations.
