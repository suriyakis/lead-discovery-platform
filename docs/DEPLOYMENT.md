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
| `pnpm build:worker` | Bundle the background-job worker into `dist/worker/worker.cjs` (PC-36) |
| `pnpm worker` / `pnpm worker:dev` | Run the worker bundle / run `src/worker.ts` with tsx (needs `JOB_QUEUE_PROVIDER=bullmq` and Redis) |
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
- **`JOB_QUEUE_PROVIDER`** — `memory` in dev, `bullmq` once Redis is up. Production pins `bullmq` in `docker-compose.prod.yml` for both services (the split below needs the shared queue), whatever `.env` says.
- **`ROLE`** (PC-36) — what a process does: `web` serves HTTP and only enqueues jobs, `worker` (the `node worker/worker.cjs` entry) runs the background jobs and schedules the ticks and serves no HTTP, `all` (the default, unset) does both in one process, as in local development. Production sets `ROLE` per service in `docker-compose.prod.yml` (`app` = web, `worker` = worker). A web server started with `ROLE=worker`, or any other value, refuses to start; the worker entry refuses anything but `worker` and refuses the in-memory queue. `ROLE=web` with the in-memory queue runs the jobs itself, with a warning.
- **`JOB_TICKS_CONCURRENCY`** / **`JOB_RUNS_CONCURRENCY`** (PC-36) — how many jobs of each lane one worker runs at once: the ticks lane (every repeatable tick: send-queue drain, inbox sync, autopilot, sweepers, reaper; default 4) and the runs lane (discovery runs, knowledge indexing, learning; default 2). An integer 1–32; anything else stops the worker at boot.
- **`OPS_READY_TOKEN`**: unlocks the full `/api/ready` report (at least 16 characters). **`BUILD_SHA`**: build argument naming the deployed commit (`BUILD_SHA=$(git rev-parse --short HEAD)` before `docker-compose ... build app`). See `docs/OPS_MONITORING.md`.
- **Owner alerts (PC-08)**: pushed to an [ntfy](https://ntfy.sh) topic. **`NTFY_TOPIC`** enables them (unset = alerts off, logged once at startup; letters, digits, `-` and `_`, at most 64). On ntfy.sh the topic name is the password, so use a long random one (`leadsonar-$(openssl rand -hex 12)`) or reserve it and set **`NTFY_TOKEN`** (access token, sent as a bearer token). **`NTFY_URL`** is the server, default `https://ntfy.sh` (a self-hosted base URL works; never put credentials in it). **`OPS_ALERT_MIN_SEVERITY`** is the lowest incident severity that alerts: `warning`, `error` (default) or `critical`. `APP_URL` makes each notification open the platform console. The topic and token are never shown, logged or stored; check the setup with **Send test alert** under Platform console → Providers → Owner alerts. Rules (dedupe, 6-hour reminders, digest, hourly budget, daily digest) are in [`docs/OPS_MONITORING.md`](OPS_MONITORING.md#owner-alerts-ntfy).

## Production: Hetzner deployment

### Topology

- One Hetzner VPS (`agregat`, 2 CPUs) running Docker Compose. It has **docker-compose v1 only** (the hyphenated `docker-compose`; `docker compose` is not installed), and every command names both files: `docker-compose -f docker-compose.yml -f docker-compose.prod.yml …`.
- Nginx in front handling TLS via Let's Encrypt and proxying to the app container.
- PostgreSQL: a Postgres container (`postgres`) with a dedicated volume + backups, on host port 5433 (loopback).
- Redis: a Redis 7 container (`redis`) for BullMQ.
- **Two app containers from one image (PC-36):**
  - `app` (`node server.js`, `ROLE=web`, 127.0.0.1:3001) serves pages and API routes and only enqueues jobs. The ops watchdog (owner alerts, PC-08) runs here, independent of the worker.
  - `worker` (`node worker/worker.cjs`, `ROLE=worker`, no ports) runs every background job on two BullMQ queues and schedules the repeatable ticks:

    | Lane | Redis queue | Jobs | Concurrency |
    |---|---|---|---|
    | ticks | `lead-platform-ticks` | every repeatable tick (`src/lib/jobs/tick-catalog.ts`): send-queue drain (30 s), inbox sync (2 min), autopilot, crawl engine, follow-ups, health check, compaction, trash purge, reaper, retention, the learning and indexing sweepers | 4 (`JOB_TICKS_CONCURRENCY`) |
    | runs | `lead-platform-runs` | on-demand work: `connector.run` (discovery runs; 3 attempts, backoff 30 s / 60 s), `knowledge.index`, `learning.process` | 2 (`JOB_RUNS_CONCURRENCY`) |

    A crawl plan that fires five long discovery runs fills the runs lane; the drain tick still starts every 30 s. The worker shares the `app-storage` volume (knowledge indexing reads uploaded documents). On `docker stop` it stops taking jobs and gives running ones 25 s to finish (`stop_grace_period: 30s`); a discovery run cut off there is failed by the stuck-work reaper (PC-10) within 15 minutes and can be started again.

### First deploy

```bash
ssh root@agregat
cd /opt
git clone git@github.com:<owner>/lead-discovery-platform.git
cd lead-discovery-platform

# Production env: copy template, fill in real secrets, never commit.
cp .env.example .env
$EDITOR .env

export BUILD_SHA=$(git rev-parse --short HEAD)
docker-compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --build
pnpm install --frozen-lockfile && pnpm db:migrate   # host-side: the image has no tsx

# Nginx vhost (managed outside the repo, alongside other apps)
$EDITOR /etc/nginx/sites-available/discover.nulife.pl
ln -s /etc/nginx/sites-available/discover.nulife.pl /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# TLS
certbot --nginx -d discover.nulife.pl
```

### Routine deploy

From the operator's machine (WSL), with the change merged to `main`:

```bash
scripts/deploy/deploy-agregat.sh              # pull, validate, build, recreate app + worker
scripts/deploy/deploy-agregat.sh --migrate    # the same, plus host-side `pnpm db:migrate`
scripts/deploy/deploy-agregat.sh --dry-run    # print the remote command sequence, run nothing
```

The script is versioned (PC-00 / PC-36), so every deploy change is reviewed in a PR. Over one SSH session to `root@195.201.16.169` it runs, each step on its own line under `set -euo pipefail` (the first failure stops the deploy with the old containers still running):

1. `git pull origin main` in `/opt/lead-discovery-platform`, and `BUILD_SHA=$(git rev-parse --short HEAD)` for `/api/ready`;
2. `docker-compose … --profile app config -q`: the server's own docker-compose validates the merged files before anything is built or stopped;
3. `docker-compose … build app`: one image, tagged `lead-discovery-platform-app:latest`, which the worker runs too;
4. with `--migrate`: host-side `pnpm db:migrate`, before the new code starts (migrations are additive). If `pnpm-lock.yaml` changed, run `pnpm install --frozen-lockfile` on the host first;
5. `docker-compose … up -d --no-build --force-recreate --no-deps app worker`: postgres and redis are left alone;
6. the status of both containers, the worker's first log lines (`[worker] running; no HTTP is served by this process.`), and `/api/health` on 127.0.0.1:3001.

`DEPLOY_HOST`, `DEPLOY_DIR` and `DEPLOY_BRANCH` override the defaults. The old WSL script `~/deploy-discover.sh` becomes a one-line wrapper once this is on `main` (before that, `main` has no `worker` service and the new script would fail at step 5):

```bash
#!/usr/bin/env bash
exec ~/projects/lead-discovery-platform/scripts/deploy/deploy-agregat.sh "$@"
```

The same by hand on the server:

```bash
cd /opt/lead-discovery-platform
git pull origin main
export BUILD_SHA=$(git rev-parse --short HEAD)
docker-compose -f docker-compose.yml -f docker-compose.prod.yml --profile app config -q
docker-compose -f docker-compose.yml -f docker-compose.prod.yml build app
pnpm db:migrate          # only when the schema changed
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --force-recreate --no-deps app worker
```

That's the whole deploy. **No manual editing on the server.** If you need to debug, copy logs out, fix in the repo, push, redeploy. Logs: `docker-compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=200 app` (web, `[startup]`) and `… logs --tail=200 worker` (background jobs, `[worker]`, `[jobs]`, the ticks).

### Release steps: Phase 1 dedicated worker (PC-36)

The release that adds the `worker` service:

1. **Before the deploy.** Redis runs (`docker-compose … ps redis`). `.env` has `APP_URL` set to the public URL (`https://discover.nulife.pl`): the base compose file used to override it with `http://localhost:3000` in production, which was the base of the tracking-pixel and unsubscribe links in sent mail; from this release the app and the worker take it from `.env`. Nothing in `.env` needs `ROLE` or `JOB_QUEUE_PROVIDER` (the prod compose file sets both per service).
2. **Deploy** with the script above. The first run creates the `worker` container. At its boot the worker moves what still waits on the old single queue (`lead-platform`) onto the lanes and removes the old tick schedules (log line `Pre-lane queue migrated: …`); a job that was running in the old app container when it stopped is settled by the reaper (discovery runs) or the outbox sweepers (learning, indexing).
3. **Check.** `docker-compose … ps` shows `app` and `worker` up; `docker-compose … logs app | grep ROLE=web` shows the web role; within about 2 minutes the token-protected `/api/ready` detail lists every tick `ok` or `pending` with the worker's `bootId` (docs/OPS_MONITORING.md).

### Release steps: Phase 1 automation control (PC-05, PC-06, PC-13, flow:F-07)

The release that brings the workspace pause, holds, the accountable-owner rule and the go-live hold needs these extra steps. Run the scripts from the host checkout against the prod `DATABASE_URL`, with a `pg_dump` taken first.

1. **Before the deploy: accountable owners.** From this release on, an active workspace whose owner account is not active, or whose owner is not a member, runs no automatic work (inbox sync included) from the first tick after the deploy. Check first (read only, works before the migration):

   ```bash
   DATABASE_URL=... pnpm exec tsx scripts/remediation/check-accountable-owners.ts
   ```

   Exit 0 means every active workspace passes. Exit 1 lists the workspaces that would stop: reactivate the owner or transfer ownership in the super-admin console before deploying, or accept that they stop.
2. **Deploy and migrate** as above. The migrations carry over the old Emergency pause switches (a workspace with either one on starts paused) and clear the dead autopilot toggles.
3. **After the deploy: go-live.** Every workspace starts not live, existing ones included. Cold, follow-up and AI-reply mail is held `not_live` (manual mail still sends) until a super-admin releases the workspace on `/admin/workspaces/[id]` with a reason. Release the workspaces that should keep sending.
4. **After the deploy: legacy feature flags.** The old `feature_flags` were never enforced. Import the disabled ones as `pending_review` holds, which are not enforced until the platform owner confirms them on `/admin/workspaces/[id]` ("Legacy flags to review"):

   ```bash
   DATABASE_URL=... pnpm exec tsx scripts/remediation/import-legacy-feature-flags.ts          # dry run
   DATABASE_URL=... pnpm exec tsx scripts/remediation/import-legacy-feature-flags.ts --apply  # idempotent
   ```

   `pnpm db:migrate` does not run this import. It must run, and the owner must review the rows, before the release that drops `feature_flags`.

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
docker-compose -f docker-compose.yml -f docker-compose.prod.yml build app
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --force-recreate --no-deps app worker
```

**Rolling back to a commit before PC-36** (its compose file has no `worker` service): stop and remove the worker *first*, while the current compose file is still checked out, or it keeps running ticks on the lane queues next to the old app's single queue:

```bash
docker-compose -f docker-compose.yml -f docker-compose.prod.yml stop worker
docker-compose -f docker-compose.yml -f docker-compose.prod.yml rm -f worker
git checkout <sha>
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build app
```

The lane schedules stay in Redis unread; rolling forward again reuses them.

If a migration is the problem, **reverting code is not enough**. Revert the schema with the previous-migration SQL (kept in `drizzle/` history) and `pnpm db:migrate` to the desired state. Coordinate with anyone using the system before destructive rollbacks.

### Health checks

- `GET /api/health`: liveness. Returns 200 `{ ok: true }` whenever the process answers and does no I/O (no database, Redis or queue check), so container and nginx checks never flap on a slow dependency.
- `GET /api/ready`: readiness (PC-07). Returns 200 or 503 after checking the database, Redis (with `JOB_QUEUE_PROVIDER=bullmq`), applied migrations and every background tick's heartbeat (the expected-slot rule, with a 10-minute grace after a deploy). Point the external uptime monitor here. The full report needs `Authorization: Bearer $OPS_READY_TOKEN`. Setup, the staleness table and the incident stream (`ops_events`) are in [`docs/OPS_MONITORING.md`](OPS_MONITORING.md).
- The worker serves no HTTP and has no endpoint of its own. A worker that is down, stuck or cut off from Redis shows as stale ticks: `/api/ready` turns 503 (after the boot grace) and the watchdog in the web process sends a `tick.stale` owner alert. `docker-compose … logs --tail=200 worker` is the first step.
- Nginx `proxy_read_timeout` is generous because some background jobs are long; user-facing endpoints stay snappy. Run heavy work as jobs.

### What goes where on the server

- App code: `/opt/lead-discovery-platform`
- Containers: `app` (web, port 127.0.0.1:3001) and `worker` (background jobs, no port), one image `lead-discovery-platform-app:latest`; `postgres`, `redis`.
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
