# Diagnostics engine (`src/lib/diagnostics`, AP-06)

One answer to "what is wrong in this workspace right now, and where do I fix
it". Every surface reads it; none keeps a second diagnostic query (I129):

| Reader | Call | Memo |
|---|---|---|
| `/health` (live list and score) | `getWorkspaceDiagnostics(ctx, { fresh: true })` | refreshes it |
| Weekly report (`runWorkspaceHealthCheck`) | same, plus the AI conversation review | refreshes it |
| 6-hourly notify sweep (`runDiagnosticsSweep`, `health.check.tick`) | same, every active workspace, no AI | refreshes it |
| Assistant `<workspace_state>` (`assistant.ts`) | same, the 12 most severe findings plus counts | refreshes it |
| Today "Needs fixing" (`app/today/_attention.tsx`) | `getWorkspaceDiagnostics(ctx)` | 30 s per workspace |

## Files

- `types.ts` — the `Finding` shape, severities, notify policies, `findingMessage`, `isProblem`. Pure.
- `rule.ts` — the `DiagnosticRule` contract and `defineRule`.
- `registry.ts` — `DIAGNOSTIC_RULES`, in display order within a severity.
- `rules/*.ts` — the rules, grouped by area (automation, mail, setup, work, ops).
- `env.ts` — what one evaluation shares: the clock, the workspace row, the automation policy, the mailboxes; each loaded at most once, lazily.
- `engine.ts` — `getWorkspaceDiagnostics`: runs every rule in parallel, isolates each one, normalises, sorts, scores, memoises.
- `score.ts` — the calibrated score and the AI-review blend.
- `notify.ts` — the free sweep, its policies and the `diagnostic_notices` ledger.
- `hrefs.ts` — fix links, from the navigation registry.

## A finding

```ts
{
  code: 'mailbox.failing',          // = the rule id (ops incidents: 'ops.<kind>')
  rule: 'mailbox.failing',
  severity: 'critical' | 'warning' | 'info',
  advisory: false,                  // context only: info, never notifies, never scores
  title: 'Mailbox "Sales" is failing',     // short, no trailing period
  detail: 'It has been failing since …',   // full sentences: what it means, what to do
  facts: { consecutiveFailures: 13, backoffMissing: true },  // small, serialisable
  href: '/mailbox/12',              // where to fix it; null = nothing to do here
  entity: { type: 'mailbox', id: '12', label: 'Sales' },
  since: '2026-07-01T10:00:00.000Z',
  actionKinds: ['open'],            // 'open' | 'pause_automation' | 'contact_support'
  notify: { policy: { kind: 'on_appear' }, dedupeKey: 'mailbox.failing:12', kind: 'mailbox.failing' },
  source: 'rule' | 'ops_event',
}
```

Severity means:

- **critical**: live damage or everything stopping without anyone choosing it
  (a failing mailbox, a suppression spike, mock search results stored, an
  empty wallet, no accountable owner);
- **warning**: something is wrong or stopped and someone should act (no
  mailbox, no product, a pause or hold, recipes without a country, a noisy
  review queue, failed runs, open incidents);
- **info**: the state is worth knowing but costs nothing (a paused mailbox,
  not live yet, autopilot on, waiting work);
- **advisory** (info + `advisory: true`): context for questions, not a
  problem (plan limits, nothing has taught the qualifier yet).

## Score

`100 − Σ over rules of the rule's worst severity`: critical 25, warning 10,
info and advisory 0. A rule costs once, however many findings it has (two
failing mailboxes are one problem area). The weekly report blends the AI
conversation review in as before: 60% rules, 40% average naturalness, only
when a review ran. Calibration is fixture-tested (`src/tests/diagnostics.test.ts`):
a healthy trial workspace scores at least 90 with no notification; the
production-shaped fixture scores 20 and gets 3 notifications.

## Notifications

The sweep notifies the workspace's owners and admins (`notifyWorkspaceAdmins`)
by each finding's policy:

- `never` (the default): shown, never announced;
- `on_appear`: once per episode. An episode ends when a sweep no longer sees
  the finding, and its unread alert is then resolved;
- `max_once_per_days(n)`: at most every n days while present.

Whatever the policy, at most **one notification per rule per workspace per
24 hours**; several due findings of one rule are folded into one. A finding
whose rule threw is unknown, not gone: its episode stays open. A finding
that has a source-side alert uses the source's dedupe key (`mailbox.failing:<id>`),
so an alert the IMAP tick raised and nobody has read yet is not repeated.

## Contributing a rule (Ops, Outreach, Discovery, Knowledge)

The engine is the contract: a workstream that finds a new way the product
can be broken adds a rule in its fix PR instead of a new banner, query or
notification path.

1. **Write the rule** in the matching `rules/*.ts` with `defineRule({ id, owner, summary, evaluate })`.
   - `id` is the code of every finding it returns, in `area.what` form
     (`queue.stuck_sending`, `worker.heartbeat_stale`). Stable: the ledger
     and saved reports key on it.
   - `owner` is your workstream (`ops`, `outreach`, `discovery`, `knowledge`,
     `billing`, `diagnostics`).
   - `evaluate(env)` is **read-only**: no writes, no AI, no network, no
     tokens. Use `env.now` for every window, with the `gte()` / `lt()`
     builders (never a JS `Date` inside a raw `sql` template), `inArray()`
     for lists, `isNull()` for NULL. Reuse `env.policy()`,
     `env.mailboxes()` and `env.workspace()` instead of querying them again.
     Inside a raw `sql` template, a single-table select renders columns
     unqualified, so a correlated subquery cannot tell the inner table from
     the outer one: use `inArray(column, subquery)` or a join.
   - Return `[]` when all is well. Throwing is allowed (the engine turns it
     into `diagnostics.partial`), but prefer returning nothing for missing
     data you can explain.
2. **Pick the severity** by the definitions above, and a **fix link** from
   `fixHref` (add a helper there: links come from the navigation registry,
   and a test checks every finding's href resolves).
3. **Pick the notify policy.** Default `never`. Use `on_appear` only for live
   damage nobody else announces; `max_once_per_days(n)` for a standing
   problem that needs a periodic nudge. If your source already notifies,
   either keep `never` or use the source's dedupe key. Advisory findings
   never notify.
4. **Copy**: title short and concrete; detail says what it means for the
   operator, what keeps working, and what to do. No codes, no blame.
5. **Register** it in `registry.ts` where it should sort within its severity.
6. **Test**: one fixture test per rule in `src/tests/diagnostics.test.ts`
   (fires, does not fire, the boundary), and re-check the two calibration
   fixtures: a new warning or critical in the healthy trial fixture is a
   calibration bug, not a test to update.

Rules contributed from other workstreams' fix PRs (planned): `send.cap_exhausted`
landed with I070 here; `queue.stuck_sending` (Ops/Outreach, today covered by
the reaper's `send.interrupted` incident), `follow_ups.unreviewed` (Outreach I005),
`worker.heartbeat_stale` (Ops I022, today `jobs.stale`), `records.unqualified`
(Discovery I077: records never qualified for an active product) and
`qualification.rules_fallback` (Discovery I025: verdicts the rules made when
the AI failed).

## Incidents

Open workspace incidents from the ops stream (`ops_events`, PC-07) become
`ops.<kind>` findings, one per kind. Kinds another rule already reports from
live state are left out (`OPS_KINDS_COVERED_BY_RULES`: the owner incident,
`run.failed`). A new incident kind needs no code here; give it a title in
`KIND_TITLES` and a fix link in `hrefOf` when the default ("Health checks")
is not the right place.
