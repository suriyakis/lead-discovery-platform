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
  host). It is the only check that does not depend on the web process: the
  in-app watchdog (below) runs inside that process and dies with it. The
  dedicated worker (PC-36) does not change that: the watchdog watches the
  worker (stale ticks), and this monitor watches the web process.
- Alert destination: the owner's ntfy topic, the same one the in-app
  alerts use (see "Owner alerts" below), so everything lands in one place.

### When it fires

Read the detail with the curl above, then:

| Failing check | Likely cause | First step |
|---|---|---|
| `database` | Postgres container down or unreachable | `docker-compose -f docker-compose.yml -f docker-compose.prod.yml ps`, then the postgres logs |
| `redis` | Redis container down; nothing is scheduled or run | the same `ps`, then the redis logs |
| `migrations` (`pending` lists tags) | the deploy skipped the migration step | host-side `pnpm db:migrate` |
| `ticks` (`stale` lists names) | the worker is not running ticks: the `worker` container stopped or crash-loops, one of its lanes is blocked, or Redis is lost | `docker-compose -f docker-compose.yml -f docker-compose.prod.yml ps worker`, then its logs (`… logs --tail=200 worker`, `grep -E '\[worker\]|\[jobs\]|\[startup\]'`), then the open incidents below |

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
| `mail.probe.tick` | 5 min | 10 min |
| `autopilot.tick` | 5 min | 10 min |
| `crawl.engine.tick` | 5 min | 10 min |
| `outreach.follow_up.tick` | 1 h | 1 h |
| `health.check.tick` | 6 h | 1 h |
| `ops.reaper.tick` | 5 min | 10 min |
| `mail.trash.purge.tick` | 24 h | 1 h |
| `ops.retention.tick` | 24 h | 1 h |
| `knowledge.compact.tick` | 7 days | 1 h |

Since PC-36 the short ticks have their own BullMQ queue and worker slots
(the ticks lane, concurrency 4, in the `worker` service); the long AI ticks
(autopilot, follow-ups, health check, compaction) run on the batch lane
(concurrency 3), and discovery runs, knowledge indexing, learning and
Re-classify all on the runs lane (concurrency 2). Long runs and long AI
passes therefore no longer delay the 30 s drain tick. A stale drain tick
now means the worker itself is down or its ticks lane is blocked, which is
a true signal that sending is delayed. A stale autopilot or follow-up tick
with a fresh drain points at the batch lane: three long passes at once.
Under the in-memory queue (dev) each lane runs one job at a time and a
tick is never stacked: while one waits, its interval adds no other.

A tick whose runs keep throwing is not stale (it still starts). It shows
`failing` with its `consecutiveFailures`, and it has an open `tick.failed`
incident.

## The incident stream: `ops_events`

Background failures that used to reach only `console.error` are recorded as
incidents:

| Kind | Scope | Raised when | Resolved when |
|---|---|---|---|
| `tick.workspace_failed` | workspace | one workspace's step inside a tick throws (every tick, incl. the reaper; compaction and synthesis separately; a failed knowledge-cluster merge counts) | that workspace's step next succeeds |
| `tick.failed` | platform | a whole tick throws (incl. a retention policy failing, PC-35) | the tick next finishes |
| `job.failed` | platform | `connector.run` throws, or a BullMQ job without an instrumented handler fails | the next success of that job name |
| `worker.error` | platform (critical) | the BullMQ worker emits `error` (usually Redis) | the next completed job |
| `jobs.schedule_registration_failed` | platform (critical) | startup could not schedule the ticks | the next successful registration |
| `tick.stale` | platform | the watchdog sees a tick stale (outside the boot grace) on 2 consecutive checks (PC-08) | a watchdog check sees it running again |
| `worker.absent` | platform (critical) | the watchdog of a web process sees a job lane (ticks, batch, runs) with no worker consuming it, 3 min or more after that process booted, on 2 consecutive checks (PC-36): the `worker` service is not running, so nothing in the background runs. One incident, `payload.lanesWithoutWorker` names the lanes; every such check also logs `[ops] CRITICAL: no background worker consumes …` | a watchdog check sees a worker on every lane |
| `send.interrupted` | workspace (error) | the stuck-work reaper failed a queued send cut off mid-flight with no sent copy (PC-10); one per queue row | an operator retries, requeues or marks that row delivered (manual); or the row turns out sent: a late drain or an Errors-folder retry settles it (auto) |
| `run.failed` | workspace (warning) | a discovery run ended `failed`, incl. every search query failing (PC-10); one per recipe, occurrences counted | the recipe's next run that succeeds or partly succeeds |
| `run.stuck` | workspace (error) | the reaper failed a run with no progress for 15 min, or pending for 60 min with its job gone from the queue (PC-10); one per recipe | as `run.failed`, and the recipe's next run that ends by itself (failed, cancelled). Both run kinds also resolve once the recipe or connector is deleted or switched off (the reaper tick checks) |
| `mailbox.failing` | workspace (error) | a mailbox turned failing — an IMAP sync, Test connection, a refused login at send time or a health probe (PC-09); one per mailbox, `payload.failureClass` = auth / connection / ambiguous, a repeat counts an occurrence | a check passes (auto), or a person reactivates, pauses or archives the mailbox (manual) |
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
  `OPS_EVENTS_RETENTION_DAYS` = 90 days after they resolved. The deletion
  runs in the retention tick (below). Open incidents are never deleted.

### Log retention (PC-35)

`ops.retention.tick` (daily, 00:00 UTC under BullMQ,
`src/lib/services/retention.ts`) deletes log rows past their window, across
every workspace, active or archived:

| Policy | Deletes | Kept for | Measured on |
|---|---|---|---|
| `autopilot_log` | every autopilot activity row | 30 days | `created_at` |
| `audit_log.mail_sync_inbound` | audit rows of kind `mail.sync_inbound` only | 30 days | `created_at` |
| `notifications.read` | notifications that were read (unread ones stay, whatever their age) | 90 days | `created_at` |
| `ops_events.resolved` | resolved incidents (open ones stay) | 90 days | `resolved_at` |
| `ops_alert_deliveries` | the owner-alert delivery log | 90 days | `created_at` |
| `ops_alert_state` | owner-alert keys not alerted since | 90 days | `last_alerted_at` |
| `job_heartbeats.retired` | heartbeat rows of jobs that are no longer catalogued ticks (a catalogued tick's row is never deleted) | 90 days | `updated_at` |
| `work_leases.expired` | PC-12: work leases a dead holder left that no acquire took over since (a deleted mailbox's or recipe's, mostly) | 7 days | `expires_at` |
| `rate_limit_buckets.expired` | PC-38: rate-limiter windows that ended and no request reopened | 1 day | `expires_at` |

Nothing else is deleted: every other audit kind, `usage_log` (it backs
token debits), mail and every tenant record stay. Each policy deletes at
most 5,000 rows per statement and 200 statements per run; a table with
more due rows finishes on the following days (the run summary says
`capped`).

- **Not gated.** It is platform housekeeping: it sends, spends and starts
  nothing, so neither a workspace pause, a hold nor the platform outbound
  stop holds it.
- **Recorded.** Its heartbeat (`job_heartbeats`, name `ops.retention.tick`)
  carries the last run's per-policy counts and cutoffs. A run that deleted
  anything writes one platform audit row, `ops.retention.run`, with the
  counts.
- **Failures.** Each policy runs on its own. If one fails, the others still
  run, then the tick fails: its heartbeat shows `failed` with the policy
  name and the masked error, and a `tick.failed` incident opens (and
  alerts). The next clean run resolves it.

The noise itself was cut at the source: the autopilot tick only visits
workspaces whose policy runs autopilot and that the automation gate lets
through, and logs its guard (`guard · skipped — autopilot_disabled`,
`held: <the gate's reason>`, `plan_no_autopilot`,
`guard · success — resumed`) only when the guard's state changes
(`autopilot_settings.guard_state`). An inbox sync writes its
`mail.sync_inbound` audit row only when it stored new messages.

```sql
SELECT last_status, last_ok_at, last_summary
FROM job_heartbeats WHERE name = 'ops.retention.tick';

SELECT created_at, payload FROM audit_log
WHERE kind = 'ops.retention.run' ORDER BY created_at DESC LIMIT 7;
```

### Stuck work (PC-10)

`ops.reaper.tick` (every 5 min, per active workspace and per any other
workspace with stuck work, `src/lib/services/stuck-work.ts`) settles work a restart or crash left
behind. Every write is conditional on the state it read, and the
reaper's own changes are audited as system events (`user_id` NULL,
`outreach.queue.reaped`, `connector_run.reaped`).

| Stuck | After | Becomes |
|---|---|---|
| `outreach_queue` row in `sending` | 10 min after `claimed_at` | `sent` when a sent / delivered copy of its draft exists from the claim on; otherwise `failed`, kind `interrupted`, "Interrupted: delivery unknown" + `send.interrupted`. Never re-sent automatically. |
| `connector_runs` `running`, no `last_progress_at` | 15 min | `failed` + `run.stuck` + the tenant's `run.failed` notification |
| `connector_runs` `running` with an unanswered cancel request | 2 min | `cancelled` |
| `connector_runs` `pending` | 60 min, and its `connector.run` job no longer waiting, delayed (a retry) or active in the job queue | `failed` (never started). Under BullMQ a run can wait behind other long runs on the runs lane (concurrency 2, PC-36), so a run whose job is still queued is left alone; when the queue cannot answer (Redis down) it waits for the next pass. The runner only starts `pending` runs, so a reaped run never starts late, and a queue retry of a run (3 attempts, PC-36) that was claimed or reaped meanwhile is skipped. |
| `outreach_follow_ups` in `processing` (PC-12) | 30 min after `claimed_at` | `pending` again when it never reached the mail server (`sending_at` NULL); `sent` when an outbound copy is on its thread from `sending_at` on; otherwise `failed`, "Interrupted: delivery unknown". Never re-sent automatically. Audited `follow_up.reaped`. |

PC-12: a send or follow-up claim is settled only when no pass that is
alive may own it — the workspace's `outreach.drain` / `outreach.follow_up`
lease is not held, or was taken after the claim (by a later pass).

### Mailbox health (PC-09)

`mail.probe.tick` (every 5 min, `src/lib/services/mailbox-probes.ts`, rules
in `mailbox-health.ts`) watches every active and failing mailbox, under
the mailbox's `mailbox.sync` lease (a sync or Test running → `busy`):

- **Active.** A credential-free SMTP probe every 30 min (`lib/mail/probe.ts`:
  TCP, TLS on connect for 465, the 220 greeting, EHLO, STARTTLS when a plain
  port offers it, QUIT — never AUTH), and one authenticated SMTP verify a day
  (`smtp_verified_at`). A failed probe is retried 5 min later; two in a row
  mark the mailbox failing (`connection`). A verify the server refuses marks
  it failing (`auth`) after that one attempt.
- **Failing, by `failure_class`.** `auth`: never retried automatically
  (`next_probe_at` NULL) — saving new connection settings schedules ONE
  check, Test again and Reactivate are the person's. `connection`:
  credential-free probes of every configured server, 30 min → 1 h → 2 h →
  4 h → 6 h; once all answer, one authenticated SMTP + IMAP check.
  `ambiguous`: one authenticated check per 6 h, four in all
  (`probe_attempts`), then nothing until a person acts.
- **Not probed:** paused and archived mailboxes, and failing mailboxes with
  no class (failing since before PC-09) until the reviewed backfill.
- The IMAP tick only syncs active mailboxes; it never logs in to a failing
  one.

Find what the probes are doing:

```sql
SELECT workspace_id, id, status, failure_class, probe_attempts, next_probe_at,
       smtp_verified_at, failing_since, left(last_error, 80) AS last_error
FROM mailboxes WHERE status IN ('active', 'failing') ORDER BY status, next_probe_at;
```

**Backfill (once, after the deploy).** Mailboxes already failing before
PC-09 are neither announced nor probed until the owner has reviewed them:

```sh
# dry run, read only: ids, failing since, side, class, host:port
DATABASE_URL=... pnpm exec tsx scripts/remediation/mailbox-health-backfill.ts
# after sign-off of exactly that list
DATABASE_URL=... pnpm exec tsx scripts/remediation/mailbox-health-backfill.ts --apply --expect <fingerprint>
```

`--apply` gives each listed mailbox its class, opens its `mailbox.failing`
incident (the ntfy alert follows) and notifies its owners and admins; the
mailboxes stay unprobed until someone fixes their settings or clicks Test
again.

### Work leases (PC-12)

Work that must not overlap in a workspace holds a row in `work_leases`
(`src/lib/services/work-leases.ts`): `autopilot.run`, `outreach.drain`,
`outreach.follow_up`, `mailbox.sync` (per mailbox), `connector.recipe`
(per recipe) and, since PC-38, `action` (an operator's AI button, per
action name; see "Rate limits and single-flight" below). A second caller does nothing and the ticks count it as
`busy` in their heartbeat summary (`autopilot.tick`,
`outreach.drain.tick`, `outreach.follow_up.tick`, `mail.imap.tick`,
`mail.probe.tick`); it is
neither a failure nor an incident. A lease lasts 2 minutes without renewal
(a discovery run's 15, renewed at its progress checkpoints), so a crashed
holder blocks its work for that long at most; a holder gives its lease up
after 10–50 minutes whatever happens. `listWorkLeases(PlatformContext)` is
the console's read model; until the console page ships, read it with psql:

```sql
SELECT workspace_id, kind, resource_key, purpose, holder_label,
       acquired_at, renewed_at, expires_at, expires_at > now() AS live
FROM work_leases ORDER BY live DESC, workspace_id, kind;
```

A row with `live = false` is a holder that died; the next acquire takes it
over. Deleting a live row by hand lets a second pass start beside the
first — wait for it to expire instead.

Send failures are classified before the queue acts
(`src/lib/mail/send-failure.ts`): transient (SMTP 4xx, no reply) 5
attempts and local (before the SMTP submission) 3, with backoff 5, 10,
20, 40 min (cap 2 h); a refused login holds the row behind the failing
mailbox; recipient-hard and policy refusals fail. A delivered send is
`sent` in the same transaction as its `mail_messages` row.

One draft is one email: no path sends a draft whose email already went
out (a sent / delivered copy of it, or a `sent` queue row of it). The
drain skips such a row, Retry now / Requeue refuse it, and the
Errors-folder Retry trashes such copies instead of sending them, tries a
draft once per batch and waits while the queue is sending it. The drain
and Retry now ask one pre-send gate (`evaluateSendGate` in
`services/outreach-queue.ts`): the automation gate for Sending (the
platform outbound stop, the holds, the workspace pause — which Retry now
passes only with the operator's "send anyway" — and, for the drain, the
accountable owner), then the daily cap. The drain re-asks the gate per
row for the go-live hold and the mailbox.
The bounce-loop check counts emails, not one email's automatic retries.

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

### Rate limits and single-flight (PC-38)

The app limits AI work in two places, both shared by every process (the
web server and the worker) and surviving deploys, because the state is in
Postgres:

- **API routes** (`src/lib/rate-limit.ts`, table `rate_limit_buckets`):
  `/api/assistant` 20 a minute per workspace and 10 per user,
  `/api/translate` 30 and `/api/communication/suggest-reply` 20 a minute
  per workspace (unchanged), `/api/signatures/redesign` 10 a minute per
  workspace (new). Over the limit: 429 `rate_limited` with `Retry-After`
  (seconds until the window ends). If the database is
  unreachable the limiter falls back to an in-process window and logs
  `[rate-limit] postgres store unavailable` once a minute.
- **AI buttons** (`src/lib/services/action-guards.ts`): each start counts
  against `action:<name>:ws:<id>` and runs under the work lease `action` /
  `<name>`, so a double-click or a second tab gets "already running":

  | Button | Action | Per workspace | Single-flight |
  |---|---|---|---|
  | Re-classify all | `qualification.reclassify_all` | 6 an hour | the whole background run |
  | Synthesize now | `learning.synthesize` | 6 an hour | yes |
  | Compact now | `knowledge.compact` | 6 an hour | yes |
  | Generate product profile | `product.autofill` | 20 an hour | yes |
  | Run check now (health) | `health.check_now` | 6 an hour | yes |
  | Crawl plan Run now | `crawl_plan.run_now` | 30 an hour | per plan |
  | Autopilot Run now | `autopilot.run_now` | 30 an hour | by `autopilot.run` |
  | Recipe Run now | `connector.recipe_run_now` | 60 an hour | by `connector.recipe` |

  Re-classify all, Synthesize now and product autofill refuse an empty
  wallet before any AI call.

**Re-classify all** is a background job (`qualification.reclassify`, runs
lane): admins only, one `qualification_runs` row per run, batches of 50
records with progress saved after each, stopped by an empty wallet
(`no_tokens`) or a Background AI hold (`held`); the Crawl Engine page shows
the progress. A run whose worker died (its lease expired) or whose job was
lost is failed as interrupted the next time someone presses the button. To
see runs:

```sql
SELECT id, workspace_id, status, stop_reason, processed_records, total_records,
       qualification_count, failed_records, created_at, heartbeat_at, finished_at
FROM qualification_runs ORDER BY id DESC LIMIT 20;
```

To see who is being limited right now:

```sql
SELECT key, count, window_start, expires_at FROM rate_limit_buckets
WHERE expires_at > now() ORDER BY count DESC LIMIT 20;
```

In front of all this, nginx limits `/api/` and server-action POSTs per
client address (scanners probing server actions, X10): the snippet and how
to apply it are in docs/DEPLOYMENT.md, "Release steps: Phase 1 shared rate
limits (PC-38)".

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

A timer in the web process (the `app` container, `ROLE=web`; or the single
process with `ROLE=all`), started at boot by the Next.js startup hook
(`src/lib/ops/watchdog.ts`), first check 30 s after boot, then every 60 s.
It is not a queued job, and since PC-36 it does not run in the worker: it
keeps working when Redis, the `worker` container or one of its lanes is what
broke, and reports that as stale ticks. Each check also asks Redis how many
workers consume each lane (`Queue.getWorkersCount`, `src/lib/ops/worker-presence.ts`):
from 3 minutes after the web process booted, a lane with no worker on two
consecutive checks opens the critical `worker.absent` incident above, which
pages the owner at once. That is the case of a deploy that recreated `app`
but not `worker` (the pre-PC-36 `~/deploy-discover.sh`). On the in-memory
queue there is nothing to check; if Redis cannot answer, the check is
skipped (logged once) and the readiness `redis` check reports it. It does **not** survive the web
process: if that process dies or hangs, so does the watchdog, which is why
the external monitor above is still required. It does not start with
`SCHEDULE_BACKGROUND_JOBS=0`.

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
