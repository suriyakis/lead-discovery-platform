# Remediation 2026-10-funnel — mail module (flow:F-06)

Repairs the production mail data damaged by X1: before the F-01 relevance
gate, the reply classifier ran over every IMAP-synced message, so newsletter
footers became "unsubscribes" and keyword matches became "bounces". With the
auto-actions on, that suppressed about 141 innocent addresses (some of them
the owner's own colleagues), created about 221 junk contacts and 359 false
"Reply from" notifications, and paid for translating newsletters.

The script **never runs by itself and never runs without the owner's review**.
A dry run writes a report; the owner decides; an apply executes exactly the
reviewed plan and can be reverted.

## Categories

|     | What                | Selector                                                                                                                                | Action                                                                      | Decided                          |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------- |
| R0  | Relevance labels    | inbound rows synced before F-01 (`outreach_relevance` NULL)                                                                             | set the F-01 label (same logic as `backfillInboundRelevance`)               | per workspace                    |
| R1a | Wrong suppressions  | every `suppression.add` in the row's audit history was the reply classifier, and every source message is bulk/unrelated                 | **revoke** (`revoke_reason` "remediation 2026-10 X1")                       | per row, default revoke          |
| R1b | Other suppressions  | any manual / link / import / send-time add, no audit trail, or a prospect message                                                       | keep                                                                        | per row, default keep            |
| R2  | Reply labels        | bulk/unrelated inbound carrying `reply_classification` / confidence / date / extracted e-mails                                          | clear                                                                       | per workspace                    |
| R3  | Junk contacts       | active, only `inbound_sender` and/or `redirect_target` thread links (column Origin), never an outbound recipient, no lead, empty notes and tags; the mail from them and the inbound mail on their redirect threads all bulk/unrelated | **archive** + tag `inbound-auto`                                            | per row; own-domain default keep |
| R4  | False notifications | `lead.replied` on a thread with no outbound message                                                                                     | delete (whole row logged)                                                   | per workspace                    |
| R5  | Zero-impact checks  | thread states, auto-closes, learning events, reply drafts from non-prospect mail; queued sends to addresses R1 would un-suppress        | report only (a queued send **blocks** R1)                                   | –                                |
| R6  | Feature flags       | every `feature_flags` row and what F-07 will do with it                                                                                 | report only — **sign off before F-07 deploys**                              | owner                            |
| R7  | Failing mailboxes   | `status = 'failing'`                                                                                                                    | `recheck_now` sets `imap_next_sync_after = now()`; fix or archive in the UI | per mailbox, default keep        |
| R8  | Token credit        | token debits attributed to translating non-prospect mail                                                                                | ledgered adjustment (credit)                                                | per workspace, default skip      |

**How R1 rebuilds a suppression's origin.** Rows from before F-03 carry no
provenance, and their note keeps only the last writer. So each add is read
from `audit_log`: a post-F-03 add declares its `source`; a legacy add counts
as automatic only when a `reply.classify` event of type unsubscribe/bounce
for a message **from that address** precedes it by at most 120 s in the same
workspace. A pre-F-03 unsubscribe-link event for the address counts as a
link add. The note is only a cross-check (shown as a warning). An address
someone suppressed by hand and the classifier touched later therefore lands
in R1b, not R1a.

**Own domains** are found from the workspace's mailbox addresses and its
members' (non-webmail) addresses; addresses of the same brand (e.g.
`ecobeton.pl` next to `ecobeton-uk.ro`) count too. Add more with
`--own-domain example.com` (all workspaces) or `--own-domain 4:example.com`.
Own-domain rows are listed first.

## Safety

- **Read-only dry run.** Writes `report.json` (the plan and its hash),
  `report.md` (for the owner) and `decisions.csv` into
  `remediation-reports/<batch>/` (git-ignored, files mode 0600). Reports
  contain addresses only where a row needs judgement (R1, R3) and never a
  subject or body. **Never commit them**; the script refuses an output folder
  inside the repository other than `remediation-reports/`.
- **Apply recomputes.** `--apply` recomputes the plan from the database and
  refuses unless its hash equals the reviewed report's — any drift means a
  new dry run. Only the batch id, options and hash come from the report.
- **Preconditions.** F-01 must have labelled mail at sync time for at least
  48 h, with no reply-classifier suppression from non-prospect mail since.
  `--skip-preconditions` exists for rehearsals on a restored snapshot only.
- **One transaction per category**; each UPDATE / DELETE re-checks the
  planned state, so a row changed meanwhile is skipped, never overwritten.
- **Revoke / archive, never delete** suppressions or contacts. Only the false
  notifications are deleted.
- **Before- and after-image** of every changed row in `remediation_log`
  (migration 0065); the run itself in `remediation_runs` (id = batch id, so a
  report can be applied once; re-applying it reports "already applied" and
  changes nothing). Platform-scoped `remediation.apply` / `remediation.revert`
  audit events (listed in `PLATFORM_AUDIT_KINDS`, so `/admin/audit` shows
  them under `?workspace=platform`), a workspace summary event, and a
  `suppression.revoke` event per lifted suppression.
- **Revert** restores every logged row in one transaction. A row someone
  changed after the apply is a conflict: the revert aborts and lists them,
  or with `--skip-conflicts` reverts everything else (status
  `revert_partial`; run it again later to retry). An R8 credit is reverted
  by an opposite ledgered adjustment (the ledger is append-only).
- `--apply` and `--revert` need `--confirm-db <database name>` and
  `--actor <e-mail of an active super admin>`.

## Runbook (production)

Run from the **host** in `/opt/lead-discovery-platform` (tracks origin/main),
never inside the container, with `DATABASE_URL` pointing at the prod
database.

1. Preconditions: F-01, F-03 and migration 0065 are deployed; F-01 has run
   for 48 h.
2. Rehearse on a restored snapshot first: dry run, apply with
   `--skip-preconditions`, check, revert, compare.
3. Dry run on prod:
   ```
   pnpm tsx scripts/remediation/2026-10-funnel/index.ts
   ```
   Expected on the 2026-10-01 data: R1a ≈ 143 (110 unsubscribe + 33
   bounce_hard, ≈ 141 addresses, own-domain rows listed first), R1b listed
   (expected 0), R3 ≈ 221 sender contacts plus the auto-redirect contacts
   extracted from the ~17 inbound messages classified `redirect` (Origin
   `redirect_target` / `both`), R4 ≥ 359. Send `report.md` to the owner through a
   private channel.
4. The owner edits `decisions.csv` (column `decision`) and signs off R6
   (needed before F-07 deploys).
5. `pg_dump` the database.
6. Apply:
   ```
   pnpm tsx scripts/remediation/2026-10-funnel/index.ts --apply \
     --report remediation-reports/<batch>/report.json \
     --decisions remediation-reports/<batch>/decisions.csv \
     --actor <super-admin e-mail> --confirm-db <database name>
   ```
   The apply report (`apply-*.md`) shows what changed and the post-apply
   checks, which must read 0 (except rows the owner kept): active
   auto-suppressions from non-prospect mail, `lead.replied` on threads without
   outbound, visible `inbound-auto` contacts, labelled bulk/unrelated mail.
   `--check` prints the same counts at any time.
7. Undo, if needed: `--revert <batch> --actor … --confirm-db …`.

If an apply crashes mid-way, its run stays `applying`; categories that
committed are in `remediation_log`. Set the run to `failed`
(`UPDATE remediation_runs SET status = 'failed' WHERE id = '<batch>'`) and
revert it, then start again from a new dry run.

## Tests

`src/tests/remediation-mail-f06.test.ts` runs every category, the apply,
idempotence, the byte-for-byte revert, conflicts, refusals and the CLI
against a seeded fixture.
