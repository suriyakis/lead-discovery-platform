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
  - *Suppression provenance (Phase 0, F-03).* Every `suppression_list` row records the `source` of the suppression in force (`unsubscribe_link`, `reply`, `dsn`, `smtp`, `manual`, `import`; `legacy_auto` / `legacy_unknown` only for rows that predate provenance) plus a `source_ref` evidence pointer (e.g. `mail_message:123`). `addSuppression` merges instead of overwriting: a stronger reason (opt-out / complaint / manual, then hard bounce, then soft bounce) is never downgraded, an expiry is never added to a permanent row or shortened, and at equal strength explicit evidence takes over an inferred (`reply` / legacy) row. Rows are revoked (admin-only, with a reason), never deleted; revoked rows never suppress and a new add re-activates them. Every add — including one that changes nothing — and every revoke writes an audit event with its source and the prior state.
  - *Reply auto-actions (Phase 0, ia:F-03).* `reply_auto_actions` holds four per-workspace switches for what happens on its own when an inbound message is classified: suppress the sender (and close the lead) on an unsubscribe reply, the same on a bounce, close the lead on a negative reply, create contacts from a redirect reply. Both auto paths (`applyAutoActions` in the classifier and `close_and_suppress` in the outreach reply handler) honour them; the unsubscribe link and SMTP rejections never read them. Shown on `/settings/outreach` to every member, changed by workspace admins only (`services/reply-auto-actions.ts`, audited as `reply_auto_actions.changed` with from/to per switch). The card reports what the auto paths did in the last 30 days (suppressions by provenance + `suppression.add` audit, lead closes tagged `replyAutoAction` on `pipeline_events`) and warns while unsubscribe auto-suppression is on. Migration 0062 made the suppression/close switches default off and switched them off on every workspace (audited, actor null); it also switched autopilot auto-approve off everywhere. Since F-01 the bounce switch is inert until F-32.
  - *Inbound relevance gate (Phase 0, flow:F-01).* `mail_messages.outreach_relevance` (`prospect_reply` / `auto_reply` / `bounce` / `bulk` / `unrelated`, NULL on outbound and on not-yet-backfilled legacy inbound) plus `relevance_signals` (header signals captured at parse time — List-*, Precedence, Auto-Submitted, ESP markers, the parsed delivery-status report — and the evidence behind the verdict). Pure decision in `lib/mail/relevance.ts`, DB facts in `services/inbound-relevance.ts`: a reference to one of OUR sent Message-IDs (case-insensitive), a DSN about our mail, mail from a lead's contact address we have mailed (no bulk signals), never our own mailbox. Every message is still stored and threaded; only prospect_reply / auto_reply / bounce are classified (on the sender's own words — `lib/mail/reply-text.ts` strips quotes and our footer) and run auto-actions, the outreach handler and follow-up cancellation; contacts and auto-translation only for prospect_reply / auto_reply; `lead.replied` only for prospect_reply. Both auto-suppression call sites refuse unless the message is a prospect_reply (`autoSuppressionRefusal`, refusals audited as `reply.auto_suppress_refused`). `backfillInboundRelevance` (dry run by default, admin-only, idempotent) labels pre-F-01 inbound from what survived on the row; `assessStoredInbound` is that per-row logic, which the F-06 remediation (R0) reuses for the prod run.
  - *Safe manual mail (Phase 0, flow:F-05).* `sendMessage(ctx, { mode })` is required: `one_to_one` (compose, thread replies, a queued draft past discovery that was triggered by an inbound reply — `sendModeForDraft`) has no unsubscribe footer / List-Unsubscribe headers; `sequence` (cold, referral intros, follow-ups) keeps them; Retry reads the mode back from the original's headers. Compose no longer pre-fills the signature — a picker (mailbox default / none / a signature) and `sendMessage` append it once. `/api/unsubscribe/<token>`: GET renders a confirmation page in the email's language (masked address, a POST button, "Wrong person? Tell us who" as a reply to the mailbox), HEAD does nothing, POST (button or RFC 8058 one-click) suppresses with source `unsubscribe_link` and cancels that address's queued sends, pending / awaiting-approval follow-ups (skip reason `unsubscribed`) and open leads (`services/unsubscribe.ts`, audited `unsubscribe.outreach_stopped`, actor null). Send errors go through `lib/mail/smtp-errors.ts`: only a RCPT-stage 5.1.x (not 5.1.7 / 5.1.8) / 5.2.1 or 550-class "user unknown" refusal suppresses (source `smtp`, `source_ref` the failed row, status `bounced`), also for refusals on an otherwise accepted send; EAUTH / 534 / 535 calls `markMailboxFailing` (status, `lastError` "SMTP: …", non-null `imap_next_sync_after`, one deduped `mailbox.failing` notification); everything else is a plain `failed` row and stays retryable. The queue and follow-ups hold (stay queued / pending, no compose) while the mailbox is failing, and follow-ups to a suppressed address are cancelled (`suppressed`) before composing.
  - *Failing mailboxes (Phase 0, flow:F-04).* `markMailboxFailing` (services/mailbox.ts) is the one way into `failing`: send-time EAUTH, the IMAP auto-pause (a refused login — now also imapflow's bare "Command failed" with `authenticationFailed` — or 10 transient failures in a row), and a failed Test again / re-check. It writes `last_error` + `last_error_at`, starts `failing_since` on the transition, always sets `imap_next_sync_after` (the re-check gate: as long as the mailbox has been failing, clamped to 1 h — 6 h after a refused login — … 24 h, so a shared Plesk host's fail2ban never sees a burst), and raises one workspace-wide `mailbox.failing` notification (dedupe key `mailbox.failing:<id>`, deduped while unread) whose copy says what stops working and the next step (`lib/mail/connection-errors.ts`; e.g. a refused SMTP 587 → "set the SMTP port to 465", which the transport always runs as implicit TLS). Every failed sync leaves a non-null gate. The IMAP tick (`runImapTick`) adopts failing rows with no gate in every active workspace without touching the server (one notification each, within one tick), and in auto-sync workspaces re-checks due failing mailboxes with a full SMTP + IMAP test instead of syncing them (`safeSyncOne`, also behind manual Sync); a pass — or Test again, Reactivate, pause, archive — ends the episode and resolves the notification (`resolveNotifications`). The health check adds a `mailbox.failing` finding per failing mailbox (name, since, advice, link) and words `mailbox.none` accurately. The mailbox page shows it in the `Alert` primitive (`components/Alert.tsx`, the DS Phase 4 API minus `onDismiss`) with the last error, its time and Test again.
  - *Production remediation A (Phase 0, flow:F-06).* `scripts/remediation/2026-10-funnel/` (mail module; runbook in its README) repairs the X1 damage in reviewed, revertible steps: R0 relevance labels for pre-F-01 inbound, R1 suppressions whose every `suppression.add` was the reply classifier acting on bulk/unrelated mail (origin rebuilt from `audit_log`: a `reply.classify` unsubscribe/bounce for a message from that address ≤120 s before a legacy add) are revoked — anything manual, link, import, send-time or without a trail is listed and kept; R2 clears reply labels on bulk/unrelated mail; R3 archives + tags `inbound-auto` inbound-only junk contacts (own-domain colleagues kept); R4 deletes `lead.replied` on threads without outbound; R5–R8 are checks, decision sheets (flags, failing mailboxes) and an optional ledgered token credit. A dry run writes a hashed plan + `decisions.csv`; `--apply` recomputes and refuses on any drift, runs one transaction per category and logs before/after images in `remediation_log` (`remediation_runs` per batch); `--revert` restores them. The generic engine (`scripts/remediation/lib/`) is reused by later modules (discovery, F-16).
- **Qualified leads pipeline** (Phase 11). Table: `qualified_leads` with extended state machine separating raw discovery, qualification, outreach, and CRM hand-over.
- **CRM export** (Phase 13). Tables: `crm_connections`, `crm_sync_log`. Excel/CSV first, HubSpot/Pipedrive/Salesforce later.
- **God Mode** (Phase 14). Platform-wide super admin views and impersonation. Audit-heavy.
- **Notifications** (later). In-app + email + Telegram/Slack.
- **Billing** (later). Plan limits + usage caps.

## Module template

When you build a new module, drop a `README.md` in `src/lib/services/<module>/` covering: purpose, public API, table list, error types, dependencies on other modules, and known limitations.
