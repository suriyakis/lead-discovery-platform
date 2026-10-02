# signal/works — operator guide

This is the practical, end-to-end guide for getting the platform productive
once the locked roadmap is shipped (Phases 0..14, all on prod 2026-05-02).

It assumes you are signed in as the bootstrap super-admin (the email matching
`OWNER_EMAIL` in `/opt/lead-discovery-platform/.env`).

## 1. Verify the build is healthy

From your laptop or phone:

- https://discover.nulife.pl/api/health → `{"ok": true}`
- https://discover.nulife.pl/dashboard → renders the module list (you must be
  signed in via Google).

If anything is wrong, ping Sancho — VPS-side ops are his job.

## 2. The module map (top-down)

| Module          | Path                          | What it does |
| --------------- | ----------------------------- | -------------|
| Products        | `/products`                    | Define what you sell. Drives discovery, classification, and outreach. |
| Connectors      | `/connectors`                  | Discovery sources (mock + internet_search) and recipes that run them. |
| Review          | `/review`                      | Records harvested by connectors, awaiting human triage. |
| Leads           | `/leads`                       | Records the rule engine ranked as relevant. Promote-to-pipeline lives here. |
| Pipeline        | `/pipeline`                    | Commercial leads pipeline (relevant → … → closed). Kanban + list views. |
| Drafts          | `/drafts`                      | Outreach drafts generated from approved review items. Manual approval. |
| Mailbox         | `/mailbox`                     | SMTP/IMAP, threads, signatures, suppression. RAG-grounded reply assistant. |
| Documents       | `/documents`                   | Files. Re-index buttons populate `document_chunks`. |
| Knowledge       | `/knowledge`                   | Documents + URLs + text excerpts attached to product profiles. |
| Settings        | `/settings/integrations`       | BYOK API keys (SerpAPI today). |
| Settings → CRM  | `/settings/crm`                | CRM connections + bulk CSV export. |
| Settings → Usage| `/settings/usage`              | Per-provider cost view, BYOK vs platform key breakdown. |
| Learning        | `/learning`                    | Workspace lessons distilled from review feedback. Embedding-aware. |
| Admin (god mode)| `/admin`                       | Super-admin only. Workspaces, users, billing, support inbox, providers, platform audit log, holds. |

## 3. First-day setup (one product, one mailbox, one connector)

### 3.1 Create a product profile

`/products/new`. Fields that drive the rest of the platform:

- **Include keywords** — boost relevance score per match.
- **Exclude keywords** — penalize.
- **Target sectors** — boost.
- **Forbidden phrases** — outreach engine NEVER lets these through.
- **Outreach instructions** — style hint for the draft engine.
- **Relevance threshold** — minimum score to count as relevant (default 50).

The values are arbitrary text; the platform is generic on purpose.

### 3.2 Provision SerpAPI key (BYOK or platform default)

`/settings/integrations`. Either:

- **BYOK**: paste your own key — costs hit your account, totally isolated.
- **Platform default**: leave blank and set `SERPAPI_KEY` in the prod `.env`
  on agregat. All workspaces share that pool.

`payload.keySource` on every `usage_log` row distinguishes the two.

### 3.3 Run a connector

`/connectors/new` → pick `internet_search` → name it.
Then add a recipe (`/connectors/<id>/recipes/new`) with `searchQueries` like
`["acoustic glass facade tender 2026"]` and a small `count`.
Click **Run now** on the recipe. Within a few seconds the run completes,
records land in `/review`, qualifications are auto-computed.

The run page refreshes itself while the run is pending or running and
has a **Cancel run** button (any role that can edit): the run stops
after the search query it is on and keeps the records found so far.
A run ends `failed` (with a notification) when every query failed,
`partial` when only some did. A run with no progress for 15 minutes
(or still pending after an hour) is failed automatically.

### 3.4 Configure a mailbox

`/mailbox/new`. SMTP host/port/user/password + IMAP host/port/user/password.
After creating, click **Test connection**. Status flips to `failing` if SMTP
or IMAP errors.

The PASSWORDS are encrypted into `workspace_secrets` at rest (AES-256-GCM,
keyed by `MASTER_KEY` env). They never live on the `mailboxes` row.

### 3.5 Compose / reply

- New outbound: `/mailbox/<id>/compose`. Default signature auto-appended.
- Inbound: hit **Sync inbound** on `/mailbox/<id>`. Threads appear below.
- Reply: open a thread, hit **Suggest reply (RAG)** to draft a grounded
  response — uses indexed `document_chunks` + relevant `learning_lessons`.

## 4. Provisioning the optional providers

### 4.1 OpenAI for embeddings + (later) drafting

```env
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
EMBEDDING_MODEL=text-embedding-3-small   # default
```

Restart the docker app. Re-index documents under `/documents/<id>` to switch
from `mock` embeddings to OpenAI. Existing chunks keep their model id, so a
mixed deployment is fine — but cosine across two model spaces is meaningless,
so a full re-index is recommended after the switch.

### 4.2 HubSpot

`/settings/crm/new` → system=HubSpot → name=HubSpot prod → paste the
**Private App** access token (PAT). The token is encrypted into
`workspace_secrets`.

Test the connection. The adapter calls `GET /crm/v3/objects/contacts?limit=1`
under the hood; HTTP 200 = OK.

Push a lead from `/pipeline/<id>` — pick the connection, leave the
"Advance to synced_to_crm" checkbox on. The first push creates a contact;
subsequent pushes update the same contact via the stored externalId.

### 4.3 Hetzner Object Storage (or any S3-compatible)

```env
STORAGE_PROVIDER=s3
S3_BUCKET=lead-discovery
S3_REGION=eu-central-1
S3_ENDPOINT=https://hel1.your-objectstorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

`S3_FORCE_PATH_STYLE` defaults to `true` when `S3_ENDPOINT` is set (Hetzner,
MinIO, R2 all need path style). For native AWS, leave it false.

## 5. Day-to-day workflows

### Discovery → Pipeline

1. Run a connector recipe.
2. Open `/review`, scan new records.
3. Approve good ones; reject with reason on bad ones (the reason becomes
   a learning event automatically).
4. Open `/leads`, sort by score; click **Promote to pipeline →** on relevant
   ones. The pipeline view is the working surface from there.

### Pipeline → CRM

1. In `/pipeline/[id]`, walk the lead through the states. The state-transition
   buttons only show forward moves the rule engine permits.
2. At `qualified` or `handed_over`, push to CRM via the **CRM** section.
3. Bulk CSV export from `/settings/crm` (Quick CSV button) bundles every
   lead with its contact + state + tags into one file.

### Knowledge curation

1. Upload sources into `/documents` (text, PDF and DOCX are indexed in
   the background right after the upload; the page shows the status and
   updates on its own). Tick the products the file is about; **no product
   ticked = available to every product**. The upload creates the
   document's knowledge source with that scope and indexes it once.
   Scanned PDFs are OCR'd once (with a Mistral key); owners and admins can
   force a fresh read with **Re-extract with OCR**, which shows the cost.
2. Or paste a URL or text excerpt at `/knowledge/new`, with the same rule
   for products.
3. To change who may use a source later, edit its products on
   `/knowledge/<id>` — retrieval follows at once. Editing a source's text,
   URL, summary or products marks it **stale** and re-indexes it
   automatically; a failed run is retried, then you get one notification.
   Deleting a source needs its title typed to confirm. A source whose products were all
   deleted shows **Needs a scope** and is used nowhere until you re-scope
   it. Archiving a document stops its use at once; restoring brings it
   back.
4. The reply assistant on `/mailbox/threads/<id>` is now grounded.

### Pausing all automation

Something looks wrong (wrong list, wrong copy, a complaint)? Press **Pause
all automation** on `/autopilot` or `/mailbox/queue`. Anyone who can edit
can press it, on any plan and with an empty wallet. At the next item it
stops everything that runs on its own: the send queue, follow-ups (nothing
is composed), autopilot, scheduled crawls, reply auto-actions, background
AI, auto top-up and the trash purge. Nothing fails — it waits. Mailboxes
keep syncing, so replies still arrive. A banner on every page says who
paused and when; the person who paused can **Undo** for 10 seconds.
Emails you write yourself (a thread reply, compose, approving a follow-up)
still go out after you tick "send anyway" (recorded in the audit log).
Owners and admins **Resume**; the confirm lists what starts again,
including reply auto-actions that waited (they are not applied — check
those replies yourself).

A new workspace is also **not live** for outreach until the platform
releases it: its cold emails, follow-ups and AI reply drafts wait in the
queue (a banner says so) while email you write yourself sends normally.

### Pausing one product, and what autopilot really does

Only one product is the problem? Open `/autopilot`, pick the product and
press **Pause <product>** (anyone who can edit). Autopilot then does
nothing for it — no approvals, drafts, queueing or CRM pushes — and its
queued emails and follow-ups wait (still queued, with the reason shown;
nothing fails). Owners and admins **Resume** it. Email you write yourself
still sends.

A product can only narrow what the workspace runs: on `/autopilot` each of
its steps either inherits the workspace or is off for it, and its approval
threshold can only be higher. To run a step for some products only, switch
it on for the workspace and off for the others.

What autopilot picks each run: auto-approve takes the best-scoring
"new" items that reach their product's threshold, one item at a time
however many products it fits, and records the approval as autopilot's
(no person's name). Generate + queue takes approved items oldest first,
but only those whose pipeline lead has a contact email; the others get
no draft and wait — the autopilot log counts them as `needs_contact` —
until you add an email on the lead's page. A product switched off or
paused never uses up the per-run limits of the others. CRM pushes appear
on the lead's timeline, and a lead is pushed again only after it changed.

Approved emails in the send queue always go out (every 30 seconds, within
each mailbox's window) and mailboxes are read every 2 minutes while
**Mailbox auto-sync** is on in `/settings/outreach` — neither is an
autopilot switch. `/connectors/engine` shows the autopilot steps read-only;
change them on `/autopilot`.

## 6. Admin operations (super-admin only)

- `/admin` — platform totals, workspace metrics, billing and token grants
  per workspace, recent audit feed across the platform.
- `/admin/workspaces/<id>` — profile, billing and tokens, lifecycle
  (archive / restore / delete), members and roles, and **Holds**: place a
  hold on all work or on chosen capabilities (Sending, Inbox sync,
  Discovery, Autopilot, CRM sync, Background AI, Reply auto-actions, Auto
  top-up) with a reason and an optional duration, or release one with a
  reason. A hold stops that work for automatic and manual use alike; the
  tenant sees it on a banner, its owners and admins are notified, and they
  cannot release it. **Legacy flags to review** lists the old feature
  flags (never enforced) imported as pending holds: Confirm enforces one,
  Discard drops it. Automatic work also stops by itself while the
  workspace owner is not active or no longer a member (a suspended owner
  stops their workspace's automation; members can still work by hand).
  **Outreach go-live** (above Holds): every workspace starts not live —
  its cold emails, follow-ups and AI reply drafts wait in the queue (never
  failed) while email its members write themselves sends. Release it with
  an audited reason once it is ready; "Put back on hold" reverses it. The
  section also shows whether the tenant has paused its automation.
- `/admin/users`, `/admin/users/<id>` — account status, pre-authorisation,
  password users, platform role, memberships.
- `/admin/support` — the support inbox across every workspace.
- `/admin/providers` — platform API keys and default providers/models,
  and **Owner alerts**: whether alerts to the owner's ntfy topic are on
  (configured in the server environment; the topic is never shown), the
  last alerts sent, and **Send test alert**.
- `/admin/audit` — the audit log across every workspace. Pick
  **Platform events** to see platform-level events (filed in no
  workspace on purpose), or **Deleted workspaces** to see rows whose
  workspace was deleted later (audit rows outlive their workspace and
  lose the pointer; the `admin.workspace.delete` row names the
  workspace). Rows are labelled `platform` and `no workspace`
  accordingly.

**Where console actions are logged.** Every action in the console records
YOUR `user_id`. Where the row is filed depends on what you changed, never
on which workspace your switcher points at:

- **Platform level** (`workspace_id` empty, visible only in `/admin/audit`):
  account status, pre-authorisations, password users and resets, platform
  roles, user profile edits, user deletion, workspace deletion, provider
  keys and platform settings, and the platform-wide outbound stop. These rows name people, so no tenant sees
  them.
- **The affected workspace** (also visible to its admins in Settings →
  Audit): billing exemption, token grants, workspace profile and lifecycle,
  members and roles, holds, support replies and status changes.

**There is no impersonation.** The old "Impersonate" button recorded a
session but never changed who you were acting as, so it was removed. To see
a workspace the way its members do, leave the console and pick it under
**god mode** in the workspace switcher. Whatever you do there is logged in
that workspace under your own `user_id`.

**High-impact buttons ask first.** Archive/restore, token grants, billing
exemption, platform role, account status, removing a member, revoking a
pre-authorisation, closing a support thread, removing a console key and
saving platform defaults all show a confirmation that names the workspace
or user; Cancel sends nothing. A workspace is named with its slug, e.g.
`"Personal" (personal-1a2b3c4d)`, because names repeat (every self-signup
workspace is called Personal). A token grant reads `+1,000 tokens to
<workspace> (<slug>)` (or `-1,000 tokens from ...`) with the balance
before and after, so a wrong row, a stray minus or an extra zero shows up
before it is applied.
**Promote to super-admin** asks you to type the user's email and **Make
billing exempt** the workspace slug. Workspace admins get the same
confirmations for removing a member, switching to Simple setup, clearing a
workspace API key, clearing a product's autopilot overrides and archiving a
CRM connection.

## 7. Operational quirks (saved as memories)

- Compose port mapping must live in **exactly one** of base/prod
  docker-compose. Compose merges port lists; duplicates re-bind the
  container on multiple ports. Postgres is on host **:5433** to avoid
  the unrelated host postgres on :5432.
- Drizzle migrations run from the **host**, not from inside the app
  container (`tsx` is not on the container PATH). `pnpm db:migrate` from
  `/opt/lead-discovery-platform`.
- Postgres image is `pgvector/pgvector:pg17` (Phase 12). Volume data
  persists across image swaps.

## 8. When things go wrong

- "discover.nulife.pl shows error" → check `/api/health`. If failing, ssh
  to agregat and `docker compose logs app | tail -100`.
- "lead.nulife.pl is broken" → that's Wandizz, a separate app on the same
  VPS. See `wandizz_project.md` memory; not part of this platform.
- "embeddings are 0" → check `EMBEDDING_PROVIDER` env. If `mock`, that's
  by design — vectors are deterministic but synthetic.
- "Push to CRM failed" → open `/settings/crm/<id>`; the recent-syncs
  timeline shows HTTP code + error body.
- "An email failed in the send queue" → `/mailbox/queue`, Failed tab.
  The badge says why (temporary failure, mailbox login refused,
  address does not exist, refused, interrupted). Temporary failures
  are retried automatically (5 attempts, 3 for errors before sending).
  **Retry now** sends it again at once, **Requeue** puts it back for
  the background sender; both re-check suppression, limits and the
  domain cooldown. "Interrupted: delivery unknown" means the send was
  cut off and may have gone out: check the mailbox's Sent folder
  first; if it is there, **Mark as delivered** records it as sent.
  Entries stuck in `sending` are settled after 10 minutes. An email
  that has already gone out is never sent again, from the queue or
  from the Errors folder (extra copies there are moved to Trash).

Anything outside this guide is either in `docs/ARCHITECTURE.md`,
`docs/MODULES.md`, or `docs/ROADMAP.md`.
