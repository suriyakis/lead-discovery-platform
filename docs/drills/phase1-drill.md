# Phase 1 drill — safe and controllable

Re-run before every go-live. It proves, on the real production build and
the real worker, that the controls Phase 1 added do what the handbook says:
one pause stops all automation, holds refuse even a person's mail, a
failing mailbox holds its queue and pages the owner, a dead tick fails
readiness, and every surface names the same problems.

**Script:** `scripts/drill/phase1-drill.ts` (automates every step below and
writes a markdown report). **Helpers:** `scripts/drill/smtp-sink.ts` (local
SMTP sink, can be switched to refuse logins) and `scripts/drill/ntfy-stub.ts`
(records owner alerts instead of sending them).

## How to run

Inside WSL, from the repo root, with the local Postgres container
(`lead-discovery-platform-postgres-1`, port 5432) and Docker available:

```sh
pnpm build && pnpm build:worker
pnpm exec tsx scripts/drill/phase1-drill.ts --report /tmp/phase1-drill.md
```

It takes about 15 minutes (step 8 has to wait out the 10-minute boot grace
of `/api/ready`). Exit code 0 = every check passed.

What it sets up, all local and thrown away afterwards:

| Piece | How |
| --- | --- |
| Database | `lead_drill` (any name containing `drill`; `DRILL_DATABASE_URL`): dropped, created, migrated with `pnpm db:migrate` |
| Redis | a `redis:7-alpine` container `ldp-drill-redis` on 127.0.0.1:6391 (or `DRILL_REDIS_URL`) |
| Web | `next start -p 3310` with `ROLE=web`, `JOB_QUEUE_PROVIDER=bullmq`, `SCHEDULE_BACKGROUND_JOBS` unset |
| Worker | `node dist/worker/worker.cjs` with `ROLE=worker` (the production split, PC-36) |
| Mail | the SMTP sink on 127.0.0.1:2525 (records envelope + subject, relays nothing); one mailbox, SMTP only, no IMAP |
| Alerts | `NTFY_URL=http://127.0.0.1:2580`, `NTFY_TOPIC=leadsonar-drill`: the ntfy stub records every request |
| AI / search | the mock providers; every real provider key blanked |
| Secrets | `MASTER_KEY`, `AUTH_SECRET`, `OPS_READY_TOKEN` and both passwords are random per run, never printed |
| Data | a dedicated drill seed: one owner (team login), one super-admin, one workspace on Pro with a wallet, send limits opened up (500/day, no domain cooldown, mailbox 1000/h), the go-live hold released by the super-admin (audited), and one learning decision event left pending 20 minutes in the past |

## The checks

| # | Check | Pass when |
| --- | --- | --- |
| 1–2 | **pause** — 60 emails queued; the sink delays each by 1.5 s; after 10 arrive the owner pauses (`pauseAutomation`) | 75 s later no `outreach_queue` row has `claimed_at` later than `workspaces.automation_paused_at`, at most the one email in flight finished, the rest are still `queued` |
| 3 | **resume** — the owner resumes | all 60 rows `sent`, the sink holds 60 messages with 60 distinct subjects (nothing twice) |
| 4 | **hold** — a tenant Sending hold, then a manual compose (the compose action's own input builder + `sendMessage`) | the send is refused with the gate's reason and the sink receives nothing; the hold is released |
| 5 | **failing** — the sink refuses every login (535); 5 more emails are queued | the mailbox is `failing` with class `auth` within 5 minutes, the ntfy stub records an alert about it, the 5 emails stay `queued` (held, not failed) |
| 6 | **recover** — the sink accepts logins again; the owner runs Test again | the mailbox is `active`, its failure class cleared, no open `mailbox.failing` incident |
| 7 | **outbox** — the learning outbox sweeper (KL-03) | no `learning_events` row is `pending` with `created_at` older than 15 minutes (the seeded one was drained) |
| 8 | **ready** — after the boot grace, `/api/ready` is 200; the drill removes the BullMQ repeatable of `outreach.drain.tick` | `/api/ready` answers 503 and its detail (with `OPS_READY_TOKEN`) names `outreach.drain.tick` as stale |
| 9 | **findings** — signed in as the owner | `/health` "Problems", `/today` "Needs fixing" (first 5), `/api/attention` findings (first 20) and the assistant's `findings` name the same problems, `jobs.stale` among them |

## Last run

2026-10-02 on `phase1/integration` after wave B: a production build of
95bc982 (`next start` + `dist/worker/worker.cjs`) and the drill scripts as
committed with this file; WSL2 Ubuntu 24.04, Postgres 17 + pgvector in
Docker, Redis 7 in a throwaway container. The script counts 8 checks:
pause and resume are one row each, the table above splits the drain.

**Result: PASS** (8/8 checks, 12 minutes)

| Check | Result | Time | Evidence |
| --- | --- | --- | --- |
| pause: pause half-way through a 60-email drain | pass | 113 s | paused at 2026-10-02T19:41:49.000Z with 10 emails at the sink<br>75 s later: 11 at the sink (1 finished in flight), sent=11, queued=49<br>rows claimed after the pause: 0; latest claim 2026-10-02 19:41:48.841524+00 |
| resume: resume drains the rest, each email exactly once | pass | 44 s | sent=60, failed=0, sink received 60, distinct subjects 60 |
| hold: a Sending hold refuses a manual compose | pass | 2 s | refused — AutomationGateError: Sending is on hold (placed by this workspace): Phase 1 drill: sending hold<br>sink: 60 before, 60 after |
| failing: refused logins: failing within 5 min, an ntfy alert, emails held | pass | 50 s | failing after 12 s, class auth, next probe none (a person acts)<br>ntfy alert after 49 s: "Leadsonar: A mailbox is failing: the mail server refused the login"<br>held emails: queued ×5; e.g. "Held: the mailbox is failing (see its last error). Fix it under Edit settings and Reactivate — this then goes out; …" |
| recover: logins accepted again: Test again recovers the mailbox | pass | 0 s | Test again: SMTP ok; mailbox active, class none; open mailbox incidents: 0 |
| outbox: the learning outbox has no pending event older than 15 minutes | pass | 0 s | pending events older than 15 min: 0; the seeded 20-minute-old event is now skipped_no_tokens (held) |
| ready: a stopped tick (outreach.drain.tick) turns /api/ready 503 | pass | 472 s | before: /api/ready 200<br>removed 1 repeatable schedule(s) of outreach.drain.tick<br>503 after 70 s; failing ticks: outreach.drain.tick |
| findings: /health, /today, /api/attention and the assistant show the same findings | pass | 1 s | health 200 [products.none, jobs.stale] · today 200 [products.none, jobs.stale] · attention 200 [products.none, jobs.stale] · assistant 200 [products.none, jobs.stale] |

Notes on this run:

- **pause**: the pause landed while the 11th email was at the sink. That
  one finished (it was claimed before the pause); nothing was claimed
  after it, and the drain tick logged `skipped (paused)` until the resume.
- **failing**: the drain's next send got 535 from the sink. The mailbox
  went `failing` with class `auth` (never retried automatically), and its
  `mailbox.failing` incident reached the ntfy stub on the web process's
  next watchdog pass. The 5 emails stayed `queued`, deferred 15 minutes
  with the reason on each row (P1-F12 in TODO.md).
- **outbox**: the seeded decision event was claimed while the workspace
  was paused and closed as `skipped_no_tokens` (note `held`), so it left
  the outbox. It stays parked in the drill because learning never
  extracts with the mock AI provider; with a real provider the sweeper
  resumes it once the gate is open.
- **ready**: `/api/ready` was 200 once the boot grace was over and 503
  about 70 s after the drain tick's schedule was removed (a 30 s tick is
  stale 60 s after its missed slot).
- **findings**: the stale tick is the one problem every surface adds
  (`jobs.stale`); `products.none` is the drill workspace having no product.
- An earlier run the same evening, before the evidence lines were made
  more readable, passed the same 8 checks.
