# Deployment

How to develop locally, deploy to Hetzner, and recover when things go wrong.

## Local development

### Prerequisites

- Node 22 LTS (or 20 LTS).
- `pnpm` 9+.
- Docker + Docker Compose.

### First-time setup

```bash
git clone git@github.com:<owner>/lead-discovery-platform.git
cd lead-discovery-platform

cp .env.example .env
# Edit .env and fill in:
#   AUTH_SECRET           — openssl rand -hex 32
#   GOOGLE_CLIENT_ID      — from Google Cloud Console
#   GOOGLE_CLIENT_SECRET  — same
#   OWNER_EMAIL           — your email; first login becomes super_admin

docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm dev
```

Visit `http://localhost:3000`. Sign in with Google. The first sign-in creates a workspace and promotes the matching `OWNER_EMAIL` user to `super_admin`.

### Useful scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Next.js dev server with hot reload |
| `pnpm build` | Production build |
| `pnpm start` | Run the production build |
| `pnpm test` | Vitest test suite |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm typecheck` | tsc --noEmit |
| `pnpm lint` | eslint |
| `pnpm db:generate` | Generate a Drizzle migration from schema diffs |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Drizzle Studio — visual DB inspector |

### Resetting local DB

```bash
docker compose down -v       # destroys the volume
docker compose up -d postgres
pnpm db:migrate
```

## Environment variables

See `.env.example` for the full list. Notable ones:

- **`DATABASE_URL`** — Postgres connection string. Local: `postgres://lead:lead@localhost:5432/lead`. Production: managed Postgres or container with proper credentials.
- **`AUTH_SECRET`** — required. 32-byte hex from `openssl rand -hex 32`. **Different per environment.**
- **`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`** — Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs. Configure authorized redirect URIs:
  - Dev: `http://localhost:3000/api/auth/callback/google`
  - Prod: `https://discover.nulife.pl/api/auth/callback/google` (or whatever subdomain we're on)
- **`OWNER_EMAIL`** — bootstrap super-admin. First login from this email auto-promotes.
- **`AI_PROVIDER`** — `mock` in dev/test, real provider id in production when wired.
- **`SEARCH_PROVIDER`** — same pattern.
- **`STORAGE_PROVIDER`** — `local` (the default) in dev **and in production today**. The Phase 9 deploy note (TODO.md P9-06) kept prod on `local`, and `docker-compose.prod.yml` mounts the `app-storage` volume at `/app/storage` for it (`STORAGE_LOCAL_ROOT` defaults to `./storage`). Check `.env` on the server before relying on this. `s3` (any S3-compatible bucket, `S3_*` vars in `.env.example`) is supported. Switching is an env change, but copy the existing objects into the bucket under the same keys first, or every stored document and export goes missing. Either way, browsers download through the authenticated routes `/api/documents/[id]/download` and `/api/crm/exports/[file]`, which check the workspace and stream from storage. No storage URL (file:// or presigned) ever reaches a page.
- **`JOB_QUEUE_PROVIDER`** — `memory` in dev, `bullmq` once Redis is up.
- **`OPS_READY_TOKEN`**: unlocks the full `/api/ready` report (at least 16 characters). **`BUILD_SHA`**: build argument naming the deployed commit (`BUILD_SHA=$(git rev-parse --short HEAD)` before `docker-compose ... build app`). See `docs/OPS_MONITORING.md`.

## Production: Hetzner deployment

### Topology

- One Hetzner VPS (`agregat`) running Docker Compose.
- Nginx in front handling TLS via Let's Encrypt and proxying to the app container.
- PostgreSQL: Hetzner-managed Postgres if available, otherwise a Postgres container with a dedicated volume + backups.
- Redis (Phase 6+): a Redis container for BullMQ.

### First deploy

```bash
ssh root@agregat
cd /opt
git clone git@github.com:<owner>/lead-discovery-platform.git
cd lead-discovery-platform

# Production env: copy template, fill in real secrets, never commit.
cp .env.example .env
$EDITOR .env

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose exec app pnpm db:migrate

# Nginx vhost (managed outside the repo, alongside other apps)
$EDITOR /etc/nginx/sites-available/discover.nulife.pl
ln -s /etc/nginx/sites-available/discover.nulife.pl /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# TLS
certbot --nginx -d discover.nulife.pl
```

### Routine deploy

```bash
ssh root@agregat
cd /opt/lead-discovery-platform
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
# DB migrations only when schema changed:
docker compose exec app pnpm db:migrate
```

That's the whole deploy. **No manual editing on the server.** If you need to debug, copy logs out, fix in the repo, push, redeploy.

### Backups

- **Postgres:** `pg_dump` once a day, written to a local backups directory and uploaded to off-host storage. Retention: 30 days. Script lives at `scripts/backup-postgres.sh`.
- **Storage volume (local storage, the current setup):** rsync the `app-storage` volume (`/var/lib/docker/volumes/lead-discovery-platform_app-storage/_data`) to the same off-host bucket. Once we're on S3-compatible, the storage backend handles its own durability.
- **Database master key (`MASTER_KEY`):** kept in the user's password manager AND in a printed sealed envelope. Losing it means workspace secrets become unrecoverable.

### Rollback

The fastest rollback is to a previous git commit:

```bash
ssh root@agregat
cd /opt/lead-discovery-platform
git log --oneline -10           # find the last good commit
git checkout <sha>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

If a migration is the problem, **reverting code is not enough**. Revert the schema with the previous-migration SQL (kept in `drizzle/` history) and `pnpm db:migrate` to the desired state. Coordinate with anyone using the system before destructive rollbacks.

### Health checks

- `GET /api/health`: liveness. Returns 200 `{ ok: true }` whenever the process answers and does no I/O (no database, Redis or queue check), so container and nginx checks never flap on a slow dependency.
- `GET /api/ready`: readiness (PC-07). Returns 200 or 503 after checking the database, Redis (with `JOB_QUEUE_PROVIDER=bullmq`), applied migrations and every background tick's heartbeat (the expected-slot rule, with a 10-minute grace after a deploy). Point the external uptime monitor here. The full report needs `Authorization: Bearer $OPS_READY_TOKEN`. Setup, the staleness table and the incident stream (`ops_events`) are in [`docs/OPS_MONITORING.md`](OPS_MONITORING.md).
- Nginx `proxy_read_timeout` is generous because some background jobs are long; user-facing endpoints stay snappy. Run heavy work as jobs.

### What goes where on the server

- App code: `/opt/lead-discovery-platform`
- Local file storage (until S3): the docker volume `lead-discovery-platform_app-storage` (`/var/lib/docker/volumes/lead-discovery-platform_app-storage/_data`), mounted into the app container at `/app/storage`.
- Postgres data (until managed): `/var/lib/docker/volumes/lead-discovery-platform_postgres-data`.
- Backups: `/var/backups/lead-discovery-platform/`.

## Emergency procedures

If you must edit something on the server:

1. **Snapshot first.** `tar czf /tmp/lead-pre-emergency.tar.gz -C /opt lead-discovery-platform`.
2. **Note exactly what you changed** in `docs/DEPLOYMENT.md` under "emergency log."
3. **Reproduce the change in the repo** the same day.
4. **Push the fix** and redeploy from clean state.

The point is not to forbid emergency edits; the point is to never let them silently diverge.

### Data remediation

Bad production data is never fixed with ad-hoc SQL. It is fixed with a versioned script under `scripts/remediation/` (dry run → owner review → `--apply` → optional `--revert`), run from the host checkout with a pg_dump taken first. The first one, `scripts/remediation/2026-10-funnel/` (flow:F-06), has its runbook in its README. Reports carry personal data: they stay in the git-ignored `remediation-reports/` and are never committed.

### Emergency log

```
(empty)
```
