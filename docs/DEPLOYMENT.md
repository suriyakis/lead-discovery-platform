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
- **`STORAGE_PROVIDER`** — `local` in dev, `s3` in production.
- **`JOB_QUEUE_PROVIDER`** — `memory` in dev, `bullmq` once Redis is up.

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
- **Storage volume (when using local storage):** rsync to the same off-host bucket. Once we're on S3-compatible, the storage backend handles its own durability.
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

- `GET /api/health` — returns 200 with `{ ok: true, db: 'up', queue: 'up' }`. Wired up in Phase 1.
- Nginx `proxy_read_timeout` is generous because some background jobs are long; user-facing endpoints stay snappy. Run heavy work as jobs.

### What goes where on the server

- App code: `/opt/lead-discovery-platform`
- Local file storage (until S3): `/opt/lead-discovery-platform/storage` mounted into the app container.
- Postgres data (until managed): `/var/lib/docker/volumes/lead-discovery-platform_postgres-data`.
- Backups: `/var/backups/lead-discovery-platform/`.

## Emergency procedures

If you must edit something on the server:

1. **Snapshot first.** `tar czf /tmp/lead-pre-emergency.tar.gz -C /opt lead-discovery-platform`.
2. **Note exactly what you changed** in `docs/DEPLOYMENT.md` under "emergency log."
3. **Reproduce the change in the repo** the same day.
4. **Push the fix** and redeploy from clean state.

The point is not to forbid emergency edits; the point is to never let them silently diverge.

### Emergency log

```
(empty)
```
