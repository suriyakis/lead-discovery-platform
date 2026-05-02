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
| Admin (god mode)| `/admin`                       | Super-admin only. Workspace overview, impersonation, feature flags. |

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

1. Upload sources into `/documents` (PDFs, text, etc. — only text-based mime
   types index out of the box; for PDFs convert to text first or wait for
   the PDF extractor upgrade).
2. Or paste a URL or text excerpt at `/knowledge/new`, attach to one or
   more product profiles.
3. Click **Index now** on each. A successful run populates
   `document_chunks` + the HNSW vector index.
4. The reply assistant on `/mailbox/threads/<id>` is now grounded.

## 6. Admin operations (super-admin only)

- `/admin` — workspace metrics + active impersonation sessions + recent
  audit feed across the platform.
- `/admin/workspaces/<id>` — member list with per-user **Impersonate** button
  (requires a reason; auto-closes any prior session by you), feature flag
  matrix.

Impersonation does NOT change the audit trail. Every action you take while
impersonating still records YOUR `user_id` on `audit_log` + `pipeline_events`.
There is no escape hatch from blame.

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

Anything outside this guide is either in `docs/ARCHITECTURE.md`,
`docs/MODULES.md`, or `docs/ROADMAP.md`.
