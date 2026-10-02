# Operations monitoring

How to tell from outside whether Leadsonar is doing its job, and where
background failures are recorded (PC-07, audit issues I021/I022).

## Two endpoints

| Endpoint | Answers | Checks | Use it for |
|---|---|---|---|
| `GET /api/health` | `200 {"ok":true}` while the process answers | none (I/O-free on purpose) | container / nginx liveness only |
| `GET /api/ready` | `200` ready, `503` not ready | database, Redis, migrations, tick heartbeats | the external uptime monitor |

`/api/health` never touches the database or Redis, so a slow dependency
cannot make the container look dead and get it restarted. It is also why it
stayed green while nothing ran: point paging at `/api/ready`.

### What `/api/ready` checks

1. **database**: `SELECT 1`.
2. **redis**: `PING` on its own short-timeout connection. Only when
   `JOB_QUEUE_PROVIDER=bullmq`; with the memory queue it reports `skipped`.
3. **migrations**: every migration in the journal bundled with this build
   is applied (`drizzle.__drizzle_migrations`). A database that is ahead of
   the code (a rolled-back deploy) passes.
4. **ticks**: no repeatable tick is stale (rule below).

Each check times out after 3 s. If the database is down, the migration and
tick checks are reported as skipped.

### The detail is token-protected

An anonymous caller gets only `{"ok": …, "checkedAt": …}`. Send the token to
get every check, each tick's state, open incident counts, the queue provider
and the build SHA:

```bash
curl -s -H "Authorization: Bearer $OPS_READY_TOKEN" https://discover.nulife.pl/api/ready | jq
```

`OPS_READY_TOKEN` lives in the production `.env` (at least 16 characters,
e.g. `openssl rand -hex 24`). If it is unset or shorter than 16 characters,
the detail is never shown. Never put the token in a monitor URL.

## External uptime monitor

- HTTP(S) monitor on `https://discover.nulife.pl/api/ready`, every 60 s,
  10 s timeout, expected status `200`. Ignore the body.
- Alert after **2 consecutive failures**. A single 503 can be the edge of a
  deploy or one slow check.
- Run it **off agregat** (UptimeRobot, Better Stack, Uptime Kuma on another
  host). Until the dedicated worker (PC-36) and the alert watchdog (PC-08)
  ship, it is the only check that does not depend on the app process.
- Alert destination: the owner's ntfy topic. PC-08 adds in-app alerting
  through `NTFY_URL` + `NTFY_TOPIC`.

### When it fires

Read the detail with the curl above, then:

| Failing check | Likely cause | First step |
|---|---|---|
| `database` | Postgres container down or unreachable | `docker-compose -f docker-compose.yml -f docker-compose.prod.yml ps`, then the postgres logs |
| `redis` | Redis container down; nothing is scheduled or run | the same `ps`, then the redis logs |
| `migrations` (`pending` lists tags) | the deploy skipped the migration step | host-side `pnpm db:migrate` |
| `ticks` (`stale` lists names) | the worker is not running ticks: crashed, blocked, or Redis lost | app logs (`grep -E '\[jobs\]|\[startup\]|\[ops\]'`), then the open incidents below |

## Tick staleness: the expected-slot rule

Every repeatable tick writes a heartbeat (`job_heartbeats`) when it starts
and when it finishes. Staleness is computed when it is read, never stored,
so a dead worker that writes nothing still turns stale.

- **Slots.** Under BullMQ, ticks fire on slots aligned to the Unix epoch
  (`k × interval`). The weekly compaction fires Thursdays 00:00 UTC, the
  daily purge at 00:00 UTC, the 6-hourly health check at 00/06/12/18 UTC.
  Under the memory queue, slots count from the schedule registration at
  boot.
- **Stale.** After a start, the next start is expected at the next slot. The
  tick is stale once that slot plus a tolerance has passed with no new
  start. The tolerance is 2 × interval, clamped to between 1 minute and
  1 hour.
- **Pending.** A tick that has not started since its schedule was registered
  (this boot) is `pending` until its first slot plus the tolerance. A weekly
  tick right after a deploy is pending for days, not stale.
- **Boot grace.** For 10 minutes after a schedule registration (a new
  `boot_id`) or after the process boots, a stale tick is reported but does
  not fail readiness. A deploy restarts the worker and must not page anyone.

| Tick | Interval | Stale after its expected slot + |
|---|---|---|
| `outreach.drain.tick` | 30 s | 1 min (about 90 s after the last start) |
| `mail.imap.tick` | 2 min | 4 min |
| `autopilot.tick` | 5 min | 10 min |
| `crawl.engine.tick` | 5 min | 10 min |
| `outreach.follow_up.tick` | 1 h | 1 h |
| `health.check.tick` | 6 h | 1 h |
| `mail.trash.purge.tick` | 24 h | 1 h |
| `knowledge.compact.tick` | 7 days | 1 h |

Until PC-36 splits the queues, ticks share the BullMQ worker (concurrency 4)
with discovery runs. If four long runs occupy it, the 30 s drain tick can
start late enough to show as stale. That is a true signal that sending is
delayed.

A tick whose runs keep throwing is not stale (it still starts). It shows
`failing` with its `consecutiveFailures`, and it has an open `tick.failed`
incident.

## The incident stream: `ops_events`

Background failures that used to reach only `console.error` are recorded as
incidents:

| Kind | Scope | Raised when | Resolved when |
|---|---|---|---|
| `tick.workspace_failed` | workspace | one workspace's step inside a tick throws (all 8 ticks; compaction and synthesis separately; a failed knowledge-cluster merge counts) | that workspace's step next succeeds |
| `tick.failed` | platform | a whole tick throws | the tick next finishes |
| `job.failed` | platform | `connector.run` throws, or a BullMQ job without an instrumented handler fails | the next success of that job name |
| `worker.error` | platform (critical) | the BullMQ worker emits `error` (usually Redis) | the next completed job |
| `jobs.schedule_registration_failed` | platform (critical) | startup could not schedule the ticks | the next successful registration |

- **Fingerprinted and deduplicated.** The fingerprint covers scope,
  workspace, kind and dedupe key, never the error text. While an incident is
  open, a repeat only increments `occurrences` and `last_seen_at`. After it
  resolves, the next failure opens a new row, so history keeps one row per
  incident.
- **Masked.** Messages and payloads are masked before they are stored:
  e-mail local parts, URL credentials, `password=` / `token=` / API-key
  values, bearer tokens and long opaque tokens.
- **Retention.** Resolved incidents are kept for
  `OPS_EVENTS_RETENTION_DAYS` = 90 days. The deletion runs in the retention
  tick (PC-35). Open incidents are never deleted.

Until the console pages ship (PC-31 platform, PC-22 / PC-32 tenant), read
both tables with psql:

```sql
SELECT id, scope, workspace_id, kind, severity, source, title, occurrences,
       first_seen_at, last_seen_at
FROM ops_events WHERE resolved_at IS NULL ORDER BY last_seen_at DESC;

SELECT name, last_status, last_started_at, last_ok_at, consecutive_failures,
       run_count, last_error, registered_at, boot_id
FROM job_heartbeats ORDER BY name;
```

## Build SHA

The detail reports `buildSha` from the `BUILD_SHA` environment variable. The
Dockerfile takes it as a build argument, and `docker-compose.prod.yml` passes
`BUILD_SHA` from the shell. Build with:

```bash
BUILD_SHA=$(git rev-parse --short HEAD) docker-compose -f docker-compose.yml -f docker-compose.prod.yml build app
```

Without it, the detail reports `unknown`.
