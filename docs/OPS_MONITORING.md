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
  host). It is the only check that does not depend on the app process: the
  in-app watchdog (below) runs inside that process and dies with it. Until
  the dedicated worker (PC-36) it stays the independent check.
- Alert destination: the owner's ntfy topic, the same one the in-app
  alerts use (see "Owner alerts" below), so everything lands in one place.

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
| `ops.reaper.tick` | 5 min | 10 min |
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
| `tick.workspace_failed` | workspace | one workspace's step inside a tick throws (every tick, incl. the reaper; compaction and synthesis separately; a failed knowledge-cluster merge counts) | that workspace's step next succeeds |
| `tick.failed` | platform | a whole tick throws | the tick next finishes |
| `job.failed` | platform | `connector.run` throws, or a BullMQ job without an instrumented handler fails | the next success of that job name |
| `worker.error` | platform (critical) | the BullMQ worker emits `error` (usually Redis) | the next completed job |
| `jobs.schedule_registration_failed` | platform (critical) | startup could not schedule the ticks | the next successful registration |
| `tick.stale` | platform | the watchdog sees a tick stale (outside the boot grace) on 2 consecutive checks (PC-08) | a watchdog check sees it running again |
| `send.interrupted` | workspace (error) | the stuck-work reaper failed a queued send cut off mid-flight with no sent copy (PC-10); one per queue row | an operator retries or requeues that row |
| `run.failed` | workspace (warning) | a discovery run ended `failed`, incl. every search query failing (PC-10); one per recipe, occurrences counted | the recipe's next run that succeeds or partly succeeds |
| `run.stuck` | workspace (error) | the reaper failed a run with no progress for 15 min or pending for 60 min (PC-10); one per recipe | as `run.failed` |
| `alerts.delivery_failed` | platform (warning) | the ntfy server refuses an owner alert or does not answer (PC-08); never alerted itself | the next delivered alert |

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

### Stuck work (PC-10)

`ops.reaper.tick` (every 5 min, per active workspace,
`src/lib/services/stuck-work.ts`) settles work a restart or crash left
behind. Every write is conditional on the state it read, and the
reaper's own changes are audited as system events (`user_id` NULL,
`outreach.queue.reaped`, `connector_run.reaped`).

| Stuck | After | Becomes |
|---|---|---|
| `outreach_queue` row in `sending` | 10 min after `claimed_at` | `sent` when a sent / delivered copy of its draft exists from the claim on; otherwise `failed`, kind `interrupted`, "Interrupted: delivery unknown" + `send.interrupted`. Never re-sent automatically. |
| `connector_runs` `running`, no `last_progress_at` | 15 min | `failed` + `run.stuck` + the tenant's `run.failed` notification |
| `connector_runs` `running` with an unanswered cancel request | 2 min | `cancelled` |
| `connector_runs` `pending` | 60 min | `failed` (never started). Longer because under BullMQ a run can wait behind others; the runner only starts `pending` runs, so a reaped run never starts late. |

Send failures are classified before the queue acts
(`src/lib/mail/send-failure.ts`): transient (SMTP 4xx, no reply) 5
attempts and local (before the SMTP submission) 3, with backoff 5, 10,
20, 40 min (cap 2 h); a refused login holds the row behind the failing
mailbox; recipient-hard and policy refusals fail. A delivered send is
`sent` in the same transaction as its `mail_messages` row.

To see what is stuck right now:

```sql
SELECT id, workspace_id, claimed_at, attempt_count FROM outreach_queue
WHERE status = 'sending' ORDER BY claimed_at;

SELECT id, workspace_id, status, last_progress_at, cancel_requested_at
FROM connector_runs WHERE status IN ('pending', 'running') ORDER BY id;
```

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

## Owner alerts (ntfy)

PC-08 pushes what needs the owner to an [ntfy](https://ntfy.sh) topic: the
phone app subscribed to it rings. Nothing to install on the server.

### Setup

Set these in the production `.env` and restart the app:

| Variable | Default | Meaning |
|---|---|---|
| `NTFY_TOPIC` | unset (alerts off) | The topic to publish to. **Required to enable alerts.** Letters, digits, `-` and `_`, at most 64. |
| `NTFY_URL` | `https://ntfy.sh` | The ntfy server. A self-hosted one works the same (base URL, no credentials in it). |
| `NTFY_TOKEN` | unset | Access token (`tk_…`) for a reserved topic on ntfy.sh or a self-hosted server with access control. Sent as `Authorization: Bearer`. |
| `OPS_ALERT_MIN_SEVERITY` | `error` | `warning`, `error` or `critical`: the lowest incident severity that alerts. |

On the public ntfy.sh server **the topic name is the password**: anyone who
knows it can read the alerts. Use a long random name
(`leadsonar-$(openssl rand -hex 12)`) or reserve the topic and set
`NTFY_TOKEN`. The topic and the token are never shown in the console, never
logged and never stored; failures are scrubbed of both.

Without `NTFY_TOPIC` the app runs normally with alerts off, and logs
`[ops] Owner alerts are off: NTFY_TOPIC is not set` once per process.

Check it from the platform console: **Providers → Owner alerts** shows the
status (server host, whether the topic and token are set, the threshold,
messages sent in the last hour, the last alerts) and has **Send test
alert**. The test is audited (`ops.alert.test`).

### What alerts

1. **Incidents** (`ops_events` above) of severity `OPS_ALERT_MIN_SEVERITY`
   and up. ntfy priority follows the severity: `critical` 5 (urgent),
   `error` 4 (high), `warning` 3, `info` 2.
2. **Stale ticks.** The watchdog checks the tick heartbeats every minute. A
   tick that is stale (the expected-slot rule above, outside the boot grace)
   on **two consecutive checks** opens a `tick.stale` incident (error), which
   alerts like any other. One stale observation never alerts.
3. **Platform stop and hold changes.** The platform-wide outbound stop (set
   priority 4, cleared 3), workspace holds (placed, released, expired,
   legacy confirmed or discarded) and the workspace automation pause, sent
   right after the change commits. The message names the workspace and
   what is held, and carries the masked reason; who acted is in the audit
   log. The same change twice within a minute (a double submit) is one
   alert. These do not spend the hourly budget.
4. **Daily digest** at 07:00 UTC (the first watchdog check after it): every
   open incident of severity `warning` and up, grouped by kind and source
   with counts, workspaces and the oldest first-seen time. Nothing open,
   nothing sent.

### Rules that keep it quiet

- **One alert per incident.** Repeats of an open incident only count
  occurrences. Still open after **6 hours**: one reminder ("still open"),
  then every 6 hours.
- **Per incident key, not per row.** An incident that resolves and reopens
  within 6 hours of its last alert (a flapping tick) does not page again.
- **Digest when many fire.** More than **3** incidents due at once, or more
  than the budget has left, go out as **one** message that groups them.
- **Budget.** At most **10** incident or digest messages per rolling hour,
  platform-wide. Over budget, incidents wait and go out (as a digest) when
  the hour frees; critical ones still go out at once.
- **Noise.** Errors matching `Failed to find Server Action` (scanners
  probing server actions, X10) never alert and never appear in a digest.
- **Exactly once.** Each alert key is claimed in `ops_alert_state` before
  the message is sent, so two app processes or two overlapping checks
  cannot both send it. A failed send gives the claim back and the next
  check retries; the failure is logged in `ops_alert_deliveries` and opens
  an `alerts.delivery_failed` warning. A failed control-change alert is
  recorded but not retried.

### The watchdog

A timer in the app process, started at boot by the Next.js startup hook
(`src/lib/ops/watchdog.ts`), first check 30 s after boot, then every 60 s.
It is not a queued job, so it keeps working when Redis or the BullMQ worker
is what broke. It does **not** survive the app process: if the process dies
or hangs, so does the watchdog, which is why the external monitor above is
still required. It does not start with `SCHEDULE_BACKGROUND_JOBS=0`.

### Reading the alert log

```sql
SELECT created_at, kind, status, priority, title, event_count, http_status, error
FROM ops_alert_deliveries ORDER BY created_at DESC LIMIT 20;

SELECT alert_key, last_alerted_at, alert_count
FROM ops_alert_state ORDER BY last_alerted_at DESC LIMIT 20;
```

`ops_alert_deliveries` follows the 90-day retention of `ops_events` (PC-35).

## Build SHA

The detail reports `buildSha` from the `BUILD_SHA` environment variable. The
Dockerfile takes it as a build argument, and `docker-compose.prod.yml` passes
`BUILD_SHA` from the shell. Build with:

```bash
BUILD_SHA=$(git rev-parse --short HEAD) docker-compose -f docker-compose.yml -f docker-compose.prod.yml build app
```

Without it, the detail reports `unknown`.
