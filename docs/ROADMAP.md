# Roadmap

Phased build plan. Each phase ends with the app **runnable, tested, committed, and deployed**. No phase leaves the codebase in an inconsistent state.

The brief at `LEAD DISCOVERY PLATFORM INFO.txt` (preserved out-of-tree on the operator's machine) is the canonical source for product intent. This roadmap is the engineering plan that delivers it.

## Phase 0 — Repo + docs + Docker skeleton ← **current**

Files: this `README.md`, `AGENTS.md`, `TODO.md`, `.env.example`, `.gitignore`, `docker-compose.yml`, `Dockerfile`, the `docs/` set, and the empty source folders.

No application code. No database schema. The next phase starts the foundation.

## Phase 1 — Core platform foundation

**Goal.** Multi-tenant workspace + auth + database + abstractions, all tested. The app shows a logged-in user a workspace selection screen and an empty dashboard.

Build:
- PostgreSQL connection (Drizzle).
- `workspaces`, `users`, `workspace_members`, `workspace_settings`, `workspace_secrets`, `audit_log`, `usage_log` tables. Auth.js tables.
- Auth.js with Google OAuth.
- `WorkspaceContext` shape and middleware.
- Role-based permission helpers.
- Provider abstractions for AI, Search, Jobs, Storage. Mock + local-FS implementations.
- `/api/health` endpoint.
- Workspace CRUD, member invite, role change.
- Bootstrap path: first login by `OWNER_EMAIL` creates initial workspace + super_admin.
- Tests: workspace isolation tests are non-skippable.

Out of scope: any product or connector logic.

## Phase 2 — Product Profiles

**Goal.** Workspace can create, edit, list product profiles. Profiles are the source of truth for what the workspace sells.

Build:
- `product_profiles` table.
- CRUD service + Zod schemas.
- `/products` UI: list, create, edit, archive.
- Tests for tenant isolation, role permissions, validation.

Reserved fields (Phase 9 documents, Phase 13 CRM mapping) added now so later phases don't migrate this table.

## Phase 3 — Connector Framework

**Goal.** A connector + recipe + run system, with a mock connector implementation that produces deterministic source records. Real connectors come in Phase 6.

Build:
- `connectors`, `connector_recipes`, `connector_runs`, `connector_run_logs` tables.
- `ISourceConnector` interface, registry, runner.
- `source_records`, `companies`, `contacts`, `evidence` tables (skeletal, the records arrive empty of product fit info).
- Dedupe foundation (unique key + similarity helpers).
- Mock connector + mock search provider.
- `/discovery` UI: pick connector + recipe + product profiles, run, see results in a raw list.
- Tests: connector runs are workspace-scoped, dedupe works within a workspace and never crosses.

## Phase 4 — Review Queue

**Goal.** Records can be approved, rejected, commented on, assigned. Comments become learning events.

Build:
- `review_items`, `review_comments` tables.
- Service + UI for review actions.
- Audit log entries on every action.
- Learning event emission on every comment.
- Tests for state transitions and audit completeness.

## Phase 5 — Learning Memory Foundation

**Goal.** Comments turn into structured lessons. Lessons can be browsed, enabled, disabled, and edited.

Build:
- `learning_events`, `learning_lessons` tables.
- `ILearningMemory` interface + implementation (no vector store).
- Lesson extractor running as a job using the AI provider abstraction (mock by default).
- `/learning` UI: list, edit, enable/disable.
- Tests for retrieval ranking and category filtering.

## Phase 6 — First real discovery source

**Goal.** A single real-world connector or search provider end-to-end, with caching and rate-limit handling.

Choice between (whichever has better fit at that point):
- Internet Search Harvester wired to **SerpAPI** (paid).
- Directory Harvester with one carefully chosen public directory.

Switch the job queue to BullMQ + Redis at this phase if connector runs become long enough to need durability.

## Phase 7 — Classification Engine

**Goal.** Records get classified against product profiles. Rules first; AI optional.

Build:
- `qualifications` table.
- Rule engine: keyword match, sector match, evidence quality, learning lessons.
- AI classifier path using the AI provider abstraction (still optional, controlled by env + per-workspace setting).
- `/leads` UI: filter, sort, see "why" panel.
- Tests for explainability (every classification has a reason and an evidence list) and for rules-vs-AI parity (mock AI agrees with rules in tests).

## Phase 8 — Outreach Drafts

**Goal.** Generate drafts from approved records using product-specific style. **No sending.**

Build:
- `outreach_drafts` table.
- Draft generation service.
- `/drafts` UI: list, generate, edit, mark approved.
- Tests including forbidden-phrase enforcement and learning-lesson injection.

## Phase 9 — Document Storage

**Goal.** Upload, tag, list documents. Link them to product profiles, leads, and other entities.

Build:
- `documents`, `knowledge_sources` tables.
- S3-compatible `IStorage` implementation.
- Upload UI, file library, document detail.
- Migration from local-FS → S3 on production.

No RAG yet.

## Phase 10 — Mailing Client

**Goal.** Configure a mailbox, send and receive email through it, with thread view and signatures. **Manual sending only.**

Build:
- `mailboxes`, `mail_messages`, `mail_threads`, `signatures`, `suppression_list`.
- IMAP and SMTP integration with credentials in `workspace_secrets`.
- `/mailbox` UI.
- No automatic outreach. Drafts go via human approval.

## Phase 11 — Qualified Leads pipeline

**Goal.** Separate raw discovery from a commercial leads pipeline (`raw_discovered → relevant → contacted → replied → contact_identified → qualified → handed_over → synced_to_crm → closed`).

Build:
- `qualified_leads` view + table.
- Pipeline UI.
- Tests for state transitions and audit log shape.

## Phase 12 — Document Knowledge / RAG

**Goal.** Retrieval-augmented generation for technical replies and qualification. Add `pgvector` and embeddings.

Build:
- `document_chunks` with `embedding vector(1536)`.
- Indexing job.
- `IKnowledgeRetriever` implementation.
- Technical reply assistant for the mailbox module.
- Lesson embeddings (the column is already on `learning_lessons` from Phase 5; here we populate it).

## Phase 13 — CRM / Export

**Goal.** Export approved leads to Excel/CSV. Then HubSpot. Then others.

Build:
- `crm_connections`, `crm_sync_log`.
- Excel/CSV export.
- HubSpot adapter via abstraction layer.

## Phase 14 — God Mode

**Goal.** Platform admin views: workspace list, usage analytics, impersonation with full audit, premium-module enable/disable.

Build:
- `/admin` UI gated by `super_admin` role.
- Impersonation tokens (audited start/end events).
- Per-workspace and global cost views.

## Future / unscheduled

- Notifications (in-app, email, Slack/Telegram).
- Billing / plan limits.
- Quotation / commercial workflow.
- Recommendation / intelligence layer (next-best-action, missed-opportunity detection).
- Localization beyond English/Polish.

These have data-model hooks but no implementation timeline yet. They will be inserted into the roadmap when justified by product needs.
