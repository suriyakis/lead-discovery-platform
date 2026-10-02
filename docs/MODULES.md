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
- `listMembers(ctx) -> WorkspaceMember[]`
- Member changes live in `src/lib/services/users.ts`, the one guarded implementation (the `/settings/members` actions call it): `addMember(ctx, userId, role)`, `removeMember(ctx, userId)`, `setMemberRole(ctx, userId, role)`, `listWorkspaceMembers(ctx)`.

**Roles.** `owner | admin | manager | member | viewer`. Plus a platform-wide `super_admin` granted only to the bootstrap user (whose email matches `OWNER_EMAIL`).

**Permission rules.**
- `owner`, `admin` — full workspace control, including settings and member management.
- Only an `owner` (or a `super_admin`) may grant `owner`, or change the role of or remove a member who is an owner. Nobody changes their own role, and the last owner can be neither demoted nor removed.
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

**Future hooks (reserved fields).** `pricingSnapshotId`, `crmMapping` (JSONB), `learningMemoryScopeId`. (Knowledge reaches a product through `knowledge_source_products`, KL-05; the old `documentSourceIds[]` was dropped.)

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

**Tables.** `learning_events`, `learning_lessons`, `lesson_scopes`.

**`LearningEvent`.** Raw input: workspace, user, entity, action, original comment, optional product profile context.

**`LearningLesson`.** Extracted, durable lesson with a scope (workspace-wide or a set of products via `lesson_scopes`), a lifecycle (`active | proposed | disabled | retired`) and a polarity (PREFER / AVOID / neutral). Categories come from the registry in `src/lib/services/learning-categories.ts`: `qualification_positive | qualification_negative | sector_preference | contact_role | false_positive | false_negative | outreach_style | product_positioning | reply_quality | general_instruction` (KL-01 removed `dedupe_hint` and `connector_quality`). Every reader applies `lessonInScope(pid)`.

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

**Phase.** 1 (interface + in-memory impl), 6+ (BullMQ for production), Phase 1 remediation PC-36 (a dedicated worker process, three lanes).

**Lanes and processes (PC-36).** `src/lib/jobs/lanes.ts` (which lane a job type runs on — `ticks` for every catalogued tick, `runs` for `connector.run`, `knowledge.index`, `learning.process` — the lane concurrency and the `connector.run` retry policy), `src/lib/jobs/role.ts` (`ROLE=web|worker|all`: who consumes, who schedules, who runs the watchdog), `src/lib/jobs/background.ts` (the boot of a consuming process: handlers, the move off the pre-lane BullMQ queue, the tick schedule), `src/lib/jobs/worker-process.ts` + `src/worker.ts` (the worker entry, bundled by `scripts/build-worker.mjs`), `src/instrumentation-node.ts` (the web server's boot by role). Deploy: `docker-compose.prod.yml` (`app` + `worker`), `scripts/deploy/deploy-agregat.sh`, `docs/DEPLOYMENT.md`.

See `IJobQueue` in `docs/ARCHITECTURE.md`. Job types defined as the system grows: `run_connector`, `run_recipe`, `enrich_website`, `classify_records`, `generate_draft`, `process_feedback`, `extract_document_text` (later), `sync_crm` (later), `sync_email` (later).

**Ops visibility (PC-07).** Every handler registered with the queue is wrapped by `instrumented()` (`src/lib/jobs/instrumented.ts`): `job_heartbeats` per job name, per-workspace failures as `ops_events` through `TickIncidents` (`src/lib/ops/tick-incidents.ts`), whole-job failures as platform incidents. The tick catalogue (names, cadences, labels) is `src/lib/jobs/tick-catalog.ts`; the expected-slot staleness rule is `src/lib/jobs/tick-schedule.ts`; readiness (`/api/ready`) is `src/lib/services/readiness.ts`. Writers: `services/job-heartbeats.ts`, `services/ops-events.ts`. See `docs/OPS_MONITORING.md`.

**Owner alerts (PC-08).** `src/lib/ops/watchdog.ts` (in-process timer: stale ticks on two consecutive checks become `tick.stale` incidents, then the dispatcher and the daily digest run), `src/lib/services/ops-alerts.ts` (`dispatchOpsAlerts`, `sendDailyDigestIfDue`, `alertControlChange` / `notifyControlChange` for the stop, hold and pause controls, `sendTestAlert` and `getOwnerAlertStatus` for the console), `src/lib/ops/alert-config.ts` (env), `src/lib/ops/alert-messages.ts` (message formats, grouping, noise), `src/lib/ops/ntfy.ts` (the sink). Console: `src/components/OwnerAlertsPanel.tsx` on `/admin/providers`.

**Stuck work and send failures (PC-10).** `src/lib/services/stuck-work.ts` (the `ops.reaper.tick`: queue rows stuck in `sending`, runs without progress or never started), `src/lib/mail/send-failure.ts` (failure kinds, retry policy and backoff, the error tags `sendMessage` sets), `src/lib/services/outreach-queue-sent.ts` (settling queue rows as sent inside the mail insert transaction), `src/lib/ops/work-incidents.ts` (`send.interrupted`, `run.failed`, `run.stuck`). Queue recovery: `requeueQueueEntry` / `retryQueueEntry` / `markQueueEntryDelivered` in `services/outreach-queue.ts`, behind the shared pre-send gate `evaluateSendGate`; `findDeliveredCopyOfDraft` (`outreach-queue-sent.ts`) keeps every re-send path from sending a draft twice; run Cancel: `requestRunCancel` in `services/connector-run.ts`, polled by `connectors/runner.ts`.

**Work leases (PC-12).** `src/lib/services/work-leases.ts` (`acquireWorkLease` / `withWorkLease`, the `WorkLease` handle with `checkpoint()` / `renew()` / `release()`, `WORK_LEASE_POLICY` per kind, `liveWorkLease` / `leaseCoversClaim` for the reaper, `listWorkLeases` for the console; table `work_leases`). Holders: `runOnce` (`services/autopilot.ts`, result `leaseHeld`), `drainQueue` and `retryQueueEntry` (`services/outreach-queue.ts`, refusal `send_pass_running`; `processEntry` also skips a row whose draft is no longer approved), `processDueFollowUps` (`services/follow-up.ts`, `followUpPass`; steps claimed `pending → processing`), `safeSyncOne` / `syncInbound` (`services/mail.ts`, outcome `busy` / `MAILBOX_BUSY`) and `testMailboxConnection` (`services/mailbox.ts`, code `busy`), and the discovery runner (`connectors/runner.ts`, per recipe). One run per recipe: `startRun` throws `RecipeRunInFlightError` (`services/connector-run.ts`); the crawl plans record it in `recipeSkips` (`services/crawl-engine.ts`). The reaper's follow-up pass: `reapStuckFollowUps` (`services/stuck-work.ts`).

**Log noise and retention (PC-35).** `src/lib/services/retention.ts` (`RETENTION_POLICIES`, `runRetention`, `runRetentionTick`: the daily `ops.retention.tick` deleting autopilot_log > 30 d, `mail.sync_inbound` audit rows > 30 d, read notifications > 90 d, resolved ops_events, the alert log and unused alert keys > 90 d, retired heartbeat rows > 90 d; batched, per policy, not gated by any pause). In `services/autopilot.ts`: `recordGuardState` (a `guard` row only when `autopilot_settings.guard_state` changes) and `guardStateOf` (the gate refusal as a guard state); the tick visits only workspaces whose policy runs autopilot and that the gate lets through (`tickVerdict`, `jobs/repeatables.ts`). `syncInbound` (`services/mail.ts`) audits only syncs that stored new messages.

### File Storage

**Phase.** 1 (interface + local-FS impl), 9+ (S3-compatible for production).

See `IStorage` in `docs/ARCHITECTURE.md`.

## Future modules

These are sketched in the brief but **not implemented** in Phase 1. The data model has reserved hooks for each.

- **Document storage + RAG** (Phase 9 + 12). Tables: `documents`, `document_chunks`, `knowledge_sources`, `knowledge_source_products`. RAG via vector index in Phase 12.
  - *Knowledge scope (KL-05).* Every chunk belongs to exactly one knowledge source; a source is available to every product (`scope_kind = 'workspace'`) or to exactly its `knowledge_source_products` rows. One predicate (`services/knowledge-scope.ts`) gates `retrieve()`, product coverage, Suggest reply and the pgvector provider; archived documents drop out at once. Uploads create the document's one source with the scope the form states (no product ticked = every product); "Index now" on a document re-indexes its sources in place.
  - *Indexing as a job (KL-06).* Creating a source, editing its text / URL / summary / products, Re-index and the admin's "Re-extract with OCR" only write a queued `indexing_jobs` row and the source's `index_status` in their own transaction, then enqueue `knowledge.index` (`services/knowledge-index-queue.ts`); requests coalesce into one queued run per source. The job (`services/knowledge-indexing.ts`) reads the document text from the extraction cache on `documents` (`services/document-extraction.ts`: OCR once per SHA, failures never cached), embeds ONCE per source and only when the text's sha256 or the embedding model changed (`rag.replaceSourceChunks` stamps both), then attaches per product — bookkeeping only on pgvector, which declares `indexesPerSource` and derives its product counters from the chunks (`recomputePgvectorProductUsage`). Transient failures retry with backoff (1, 2, 4 min, 4 runs); deterministic ones (unsupported file, no text, no OCR key, no scope) fail at once; a failure ends in one `knowledge.index_failed` notification per source, resolved by the next success. `knowledge.index.sweep` (2 min) fails runs older than 15 min and re-enqueues lost or due rows. Pages show the status badge and poll (`components/AutoRefresh.tsx`) while a source is queued or indexing. Deleting a source needs its title typed and detaches it from the provider that holds it.
- **Mailing client** (Phase 10). Tables: `mailboxes`, `mail_messages`, `mail_threads`, `signatures`, `suppression_list`.
  - *Suppression provenance (Phase 0, F-03).* Every `suppression_list` row records the `source` of the suppression in force (`unsubscribe_link`, `reply`, `dsn`, `smtp`, `manual`, `import`; `legacy_auto` / `legacy_unknown` only for rows that predate provenance) plus a `source_ref` evidence pointer (e.g. `mail_message:123`). `addSuppression` merges instead of overwriting: a stronger reason (opt-out / complaint / manual, then hard bounce, then soft bounce) is never downgraded, an expiry is never added to a permanent row or shortened, and at equal strength explicit evidence takes over an inferred (`reply` / legacy) row. Rows are revoked (admin-only, with a reason), never deleted; revoked rows never suppress and a new add re-activates them. Every add — including one that changes nothing — and every revoke writes an audit event with its source and the prior state.
  - *Reply auto-actions (Phase 0, ia:F-03).* `reply_auto_actions` holds four per-workspace switches for what happens on its own when an inbound message is classified: suppress the sender (and close the lead) on an unsubscribe reply, the same on a bounce, close the lead on a negative reply, create contacts from a redirect reply. Both auto paths (`applyAutoActions` in the classifier and `close_and_suppress` in the outreach reply handler) honour them; the unsubscribe link and SMTP rejections never read them. Shown on `/settings/outreach` to every member, changed by workspace admins only (`services/reply-auto-actions.ts`, audited as `reply_auto_actions.changed` with from/to per switch). The card reports what the auto paths did in the last 30 days (suppressions by provenance + `suppression.add` audit, lead closes tagged `replyAutoAction` on `pipeline_events`) and warns while unsubscribe auto-suppression is on. Migration 0062 made the suppression/close switches default off and switched them off on every workspace (audited, actor null); it also switched autopilot auto-approve off everywhere. Since F-01 the bounce switch is inert until F-32.
  - *Inbound relevance gate (Phase 0, flow:F-01).* `mail_messages.outreach_relevance` (`prospect_reply` / `auto_reply` / `bounce` / `bulk` / `unrelated`, NULL on outbound and on not-yet-backfilled legacy inbound) plus `relevance_signals` (header signals captured at parse time — List-*, Precedence, Auto-Submitted, ESP markers, the parsed delivery-status report — and the evidence behind the verdict). Pure decision in `lib/mail/relevance.ts`, DB facts in `services/inbound-relevance.ts`: a reference to one of OUR sent Message-IDs (case-insensitive), a DSN about our mail, mail from a lead's contact address we have mailed (no bulk signals), never our own mailbox. Every message is still stored and threaded; only prospect_reply / auto_reply / bounce are classified (on the sender's own words — `lib/mail/reply-text.ts` strips quotes and our footer) and run auto-actions, the outreach handler and follow-up cancellation; contacts and auto-translation only for prospect_reply / auto_reply; `lead.replied` only for prospect_reply. Both auto-suppression call sites refuse unless the message is a prospect_reply (`autoSuppressionRefusal`, refusals audited as `reply.auto_suppress_refused`). `backfillInboundRelevance` (dry run by default, admin-only, idempotent) labels pre-F-01 inbound from what survived on the row; `assessStoredInbound` is that per-row logic, which the F-06 remediation (R0) reuses for the prod run.
  - *Safe manual mail (Phase 0, flow:F-05).* `sendMessage(ctx, { mode })` is required: `one_to_one` (compose, thread replies, a queued draft past discovery that was triggered by an inbound reply — `sendModeForDraft`) has no unsubscribe footer / List-Unsubscribe headers; `sequence` (cold, referral intros, follow-ups) keeps them; Retry reads the mode back from the original's headers. Compose no longer pre-fills the signature — a picker (mailbox default / none / a signature) and `sendMessage` append it once. `/api/unsubscribe/<token>`: GET renders a confirmation page in the email's language (masked address, a POST button, "Wrong person? Tell us who" as a reply to the mailbox), HEAD does nothing, POST (button or RFC 8058 one-click) suppresses with source `unsubscribe_link` and cancels that address's queued sends, pending / awaiting-approval follow-ups (skip reason `unsubscribed`) and open leads (`services/unsubscribe.ts`, audited `unsubscribe.outreach_stopped`, actor null). Send errors go through `lib/mail/smtp-errors.ts`: only a RCPT-stage 5.1.x (not 5.1.7 / 5.1.8) / 5.2.1 or 550-class "user unknown" refusal suppresses (source `smtp`, `source_ref` the failed row, status `bounced`), also for refusals on an otherwise accepted send; EAUTH / 534 / 535 calls `markMailboxFailing` (status, `lastError` "SMTP: …", non-null `imap_next_sync_after`, one deduped `mailbox.failing` notification); everything else is a plain `failed` row and stays retryable. The queue and follow-ups hold (stay queued / pending, no compose) while the mailbox is failing, and follow-ups to a suppressed address are cancelled (`suppressed`) before composing.
  - *Failing mailboxes and mailbox health (Phase 0 flow:F-04, Phase 1 PC-09).* `markMailboxFailing` (services/mailbox.ts) is the one way into `failing`: send-time EAUTH, an IMAP sync (a refused login — also imapflow's bare "Command failed" with `authenticationFailed` — or, in a row, 10 network failures / 3 unclear ones), a failed Test again and the health probes. It classifies the failure (`failure_class`: auth / connection / ambiguous, `lib/mail/connection-errors.ts classifyMailboxFailure`), writes `last_error` + `last_error_at`, starts `failing_since` on the transition, sets the class's probe schedule (`next_probe_at`, `probe_attempts`; `services/mailbox-health.ts`), raises the mailbox's `mailbox.failing` ops_event (one per mailbox, occurrences counted, PC-08 alerts it) and — when the episode starts or the class changes — notifies the owners / admins (dedupe key = the incident fingerprint, link `/mailbox/<id>#fix`, the copy says what stops, the fix and what happens on its own). `mail.probe.tick` (`services/mailbox-probes.ts`, every 5 min, under the mailbox lease) probes active mailboxes without credentials every 30 min (`lib/mail/probe.ts`: EHLO / CAPABILITY, never AUTH / LOGIN), verifies the SMTP login once a day (`smtp_verified_at`), and recovers failing ones by class: auth never automatically (an owner's settings edit schedules one check), connection by credential-free probes backing off 30 min → 6 h then one login, ambiguous at most 4 logins 6 h apart. A passing check (probe, Test again, a manual Sync) makes it active, resolves the incident and notifications and says "back online" (`mailbox.recovered`); Reactivate, pause and archive end the episode by hand. The IMAP tick syncs active mailboxes only (flow:F-04's adoption pass and failing re-check are gone); mailboxes failing since before PC-09 (no class) wait for the reviewed backfill (`scripts/remediation/mailbox-health-backfill.ts`). The health check adds a `mailbox.failing` finding per failing mailbox (name, since, advice, recovery plan, link) and words `mailbox.none` accurately. The mailbox page shows it in the `Alert` primitive with the last error, its class and what happens next, Test again and Reactivate.
  - *Production remediation A (Phase 0, flow:F-06).* `scripts/remediation/2026-10-funnel/` (mail module; runbook in its README) repairs the X1 damage in reviewed, revertible steps: R0 relevance labels for pre-F-01 inbound, R1 suppressions whose every `suppression.add` was the reply classifier acting on bulk/unrelated mail (origin rebuilt from `audit_log`: a `reply.classify` unsubscribe/bounce for a message from that address ≤120 s before a legacy add) are revoked — anything manual, link, import, send-time or without a trail is listed and kept; R2 clears reply labels on bulk/unrelated mail; R3 archives + tags `inbound-auto` inbound-only junk contacts — senders of bulk/unrelated mail and addresses the old auto-redirect extracted from it (`redirect_target`) — with own-domain colleagues kept; R4 deletes `lead.replied` on threads without outbound; R5–R8 are checks, decision sheets (flags, failing mailboxes) and an optional ledgered token credit. A dry run writes a hashed plan + `decisions.csv`; `--apply` recomputes and refuses on any drift, runs one transaction per category and logs before/after images in `remediation_log` (`remediation_runs` per batch); `--revert` restores them. The generic engine (`scripts/remediation/lib/`) is reused by later modules (discovery, F-16).
- **Qualified leads pipeline** (Phase 11). Table: `qualified_leads` with extended state machine separating raw discovery, qualification, outreach, and CRM hand-over.
- **CRM export** (Phase 13). Tables: `crm_connections`, `crm_sync_log`. Excel/CSV first, HubSpot/Pipedrive/Salesforce later.
- **God Mode** (Phase 14). Platform-wide super admin views. Audit-heavy. Console services take a `PlatformContext` (see `docs/ARCHITECTURE.md`, Workspace-first rule 3). The Phase 14 impersonation control was a no-op and was removed (PC-03); `impersonation_sessions` is kept as history.
- **Notifications** (later). In-app + email + Telegram/Slack.
- **Billing** (later). Plan limits + usage caps.

## Module template

When you build a new module, drop a `README.md` in `src/lib/services/<module>/` covering: purpose, public API, table list, error types, dependencies on other modules, and known limitations.
