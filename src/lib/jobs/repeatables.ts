// Phase 34: scheduled background work. The tick handlers fan out across
// the active workspaces / mailboxes so the platform actually does its job
// without anyone clicking buttons. Names, cadences and labels are in
// tick-catalog.ts.
//
//   autopilot.tick          every 5 min  → for each active workspace whose
//                                           policy runs autopilot and the
//                                           gate lets it (PC-13 / PC-35:
//                                           autopilot off is skipped
//                                           silently, no log row),
//                                           autopilot.runOnce(ctx)
//   outreach.drain.tick     every 30 s   → for each active workspace, drain
//                                           the send queue
//   mail.imap.tick          every 2 min  → for each active mailbox with IMAP,
//                                           mail.safeSyncOne(ctx, mb)
//                                           (runImapTick; failing mailboxes
//                                           are the probe tick's)
//   mail.probe.tick         every 5 min  → PC-09 mailbox health: due
//                                           credential-free probes, the daily
//                                           login check and failing mailboxes'
//                                           recovery by class (runMailProbeTick,
//                                           services/mailbox-probes.ts)
//   outreach.follow_up.tick every 1 h    → Phase 58: for each active
//                                           workspace with follow-ups on,
//                                           send follow-ups that are due
//   knowledge.compact.tick  every 7 d    → compaction + learning synthesis
//   mail.trash.purge.tick   every 24 h   → per-workspace trash retention
//   crawl.engine.tick       every 5 min  → due crawl plans
//   health.check.tick       every 6 h    → due AI workspace health checks
//   ops.reaper.tick         every 5 min  → PC-10: settle stuck sends and
//                                           stuck discovery runs
//                                           (services/stuck-work.ts)
//   ops.retention.tick      every 24 h   → PC-35: platform housekeeping —
//                                           delete log rows past their
//                                           retention window
//                                           (services/retention.ts)
//   learning.sweep          every 2 min  → KL-03: the learning outbox's
//                                           sweeper (stale claims, lost jobs,
//                                           backoff retries, events waiting
//                                           for tokens or a hold, missed
//                                           compensations) — runLearningSweep
//   knowledge.index.sweep   every 2 min  → KL-06: the indexing outbox's
//                                           sweeper (runs older than 15 min
//                                           → failed + notified, due retries
//                                           and lost jobs re-enqueued) —
//                                           runKnowledgeIndexSweep
//
// Each handler iterates serially and swallows per-tenant errors so one
// stuck workspace can't block the whole platform.
//
// PC-06: every automation tick iterates the gate's tick list — active
// workspaces, selected from the workspace_automation_state view, each with
// its automation state and a context that acts as the accountable owner —
// and skips a workspace the automation gate holds for the tick's
// capability (a hold, the platform outbound stop for sending, or no
// accountable owner). A skip is not an error: it is counted as `held` in
// the tick's summary.
//
// PC-05: the workspace pause holds every automation tick except the IMAP
// one (replies keep arriving while paused), and each tick's service
// re-checks the gate before every item it works on (a queue row, a
// follow-up, a recipe, a mailbox), so a pause committed mid-tick stops it
// at the next item. The ops ticks (reaper, retention) and the two outbox
// sweepers (learning, knowledge indexing) are platform maintenance
// (MAINTENANCE_TICKS): they send nothing and start no new work — the
// learning job they re-drive asks the automation gate before any AI call
// (learning-processor.ts learningGate) — so no pause or hold gates them.
//
// PC-13: every automation tick iterates workspacesForTick() — the same
// workspaces, each with its resolved automation policy
// (services/automation-policy.ts, loaded in one batch) — and asks
// tickVerdict(policy, tick): held by the gate (counted as `held`), off by
// configuration (autopilot off, auto-sync off, follow-ups off, no crawl
// plan, trash kept, health check off: skipped silently, no work and no log
// rows), or run.
//
// PC-07 (I021/I022): every handler is registered through instrumented(),
// which writes the job_heartbeats row (start, finish, duration, status,
// consecutive failures, the structured summary each handler returns) and
// hands the handler a TickIncidents: a per-workspace error becomes an
// ops_event (one open incident per workspace + step, occurrences counted)
// and that workspace's next success resolves it. A held workspace is
// neither: the gate's refusal is not a tick failure. Cadences and labels
// live in tick-catalog.ts; the schedule registration stamps registered_at
// and boot_id on each tick's heartbeat.
//
// PC-12 (I064, I067): the work a tick starts runs under work leases
// (services/work-leases.ts) — autopilot runOnce, the drain and the
// follow-up pass per workspace, each mailbox sync and health probe per
// mailbox — so a tick
// never overlaps a Run now, a "Send due emails now", a manual Sync or its
// own previous slot still running. A workspace (or mailbox) whose lease is
// held is counted as `busy`: neither a failure nor a success.

import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import { mailboxes } from '@/lib/db/schema/mailing';
import {
  AutomationGateError,
  checkGate,
  logGateSkip,
} from '@/lib/services/automation-gate';
import {
  tickVerdict,
  workspacesForTick,
  type AutomationTick,
  type TickWorkspacePolicy,
} from '@/lib/services/automation-policy';
import { runOnce } from '@/lib/services/autopilot';
import { drainQueue } from '@/lib/services/outreach-queue';
import { purgeOldTrashUnattended, safeSyncOne } from '@/lib/services/mail';
import { processDueCrawlPlans } from '@/lib/services/crawl-engine';
import { processDueFollowUps } from '@/lib/services/follow-up';
import { compactWorkspaceKnowledgeUnattended } from '@/lib/services/knowledge-compaction';
import { synthesizeWorkspaceLearningUnattended } from '@/lib/services/learning-synthesis';
import { runLearningSweep } from '@/lib/services/learning-processor';
import { runKnowledgeIndexSweep } from '@/lib/services/knowledge-indexing';
import { processDueHealthChecks } from '@/lib/services/health-check';
import {
  listWorkspacesWithStuckWork,
  reapStuckWork,
  resolveOrphanedRunIncidents,
} from '@/lib/services/stuck-work';
import { runRetentionTick } from '@/lib/services/retention';
import { listMailboxesDueForProbe, probeMailbox } from '@/lib/services/mailbox-probes';
import { recordTickRegistration } from '@/lib/services/job-heartbeats';
import {
  opsEventFingerprint,
  raiseOpsEvent,
  resolveOpsEvent,
} from '@/lib/services/ops-events';
import { NOOP_TICK_INCIDENTS, type TickIncidents } from '@/lib/ops/tick-incidents';
import { getBootInfo } from './boot';
import { getJobQueue } from './index';
import { instrumented, type InstrumentedHandler } from './instrumented';
import { TICK_CATALOG, type TickName } from './tick-catalog';

export {
  AUTOPILOT_TICK_MS,
  CRAWL_ENGINE_TICK_MS,
  DRAIN_TICK_MS,
  FOLLOW_UP_TICK_MS,
  HEALTH_CHECK_TICK_MS,
  IMAP_TICK_MS,
  KNOWLEDGE_COMPACT_TICK_MS,
  MAIL_TRASH_PURGE_TICK_MS,
  RETENTION_TICK_MS,
  STUCK_WORK_TICK_MS,
} from './tick-catalog';

/**
 * PC-13: should `tick` work on this workspace? A workspace the gate holds
 * is counted (onHeld) and logged; one whose configuration has the path off
 * is skipped silently.
 */
function shouldRun(ws: TickWorkspacePolicy, tick: AutomationTick, onHeld: () => void): boolean {
  const verdict = tickVerdict(ws.policy, tick);
  if (verdict.run) return true;
  if ('held' in verdict) {
    onHeld();
    logGateSkip(tick, ws.workspaceId, verdict.held);
  }
  return false;
}

/**
 * autopilot.tick body. PC-13 / PC-35 (I066): only workspaces whose policy
 * runs autopilot and that the gate lets through are run, so a workspace
 * with autopilot off writes nothing (it used to log a 'guard skipped' row
 * every 5 minutes). Exported for tests (deterministic, unlike
 * enqueue-and-wait).
 */
export async function runAutopilotTick(
  incidents: TickIncidents = NOOP_TICK_INCIDENTS,
): Promise<{ workspaces: number; stepsRun: number; failed: number; held: number; busy: number }> {
  const wss = await workspacesForTick();
  let ran = 0;
  let failed = 0;
  let held = 0;
  let busy = 0;
  for (const ws of wss) {
    // Autopilot off: no run, and no 'autopilot_disabled' log row every
    // 5 minutes.
    if (!shouldRun(ws, 'autopilot.tick', () => held++)) continue;
    try {
      const result = await runOnce(ws.ctx, { purpose: 'tick' });
      // PC-12: a run already in progress (Run now, the post-crawl hook, a
      // tick still running) — neither a success nor a failure.
      if (result.leaseHeld) {
        busy++;
        continue;
      }
      ran += result.steps.length;
    } catch (err) {
      failed++;
      console.error(
        `[autopilot.tick] workspace=${ws.workspaceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId: ws.workspaceId }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId: ws.workspaceId });
  }
  return { workspaces: wss.length, stepsRun: ran, failed, held, busy };
}

const handleAutopilotTick: InstrumentedHandler = (_payload, { incidents }) =>
  runAutopilotTick(incidents);

/** Drain tick body. Exported for tests (deterministic). */
export async function runDrainTick(
  incidents: TickIncidents = NOOP_TICK_INCIDENTS,
): Promise<{
  workspaces: number;
  totalSent: number;
  totalSkipped: number;
  failed: number;
  held: number;
  /** PC-12: workspaces whose send pass was already running (lease held). */
  busy: number;
}> {
  const wss = await workspacesForTick();
  let totalSent = 0;
  let totalSkipped = 0;
  let failed = 0;
  let held = 0;
  let busy = 0;
  for (const ws of wss) {
    if (!shouldRun(ws, 'outreach.drain.tick', () => held++)) continue;
    try {
      const r = await drainQueue(ws.ctx, { purpose: 'tick' });
      if (r.blocked === 'send_pass_running') {
        busy++;
        continue;
      }
      totalSent += r.sent;
      totalSkipped += r.skipped;
      if (r.heldReason) held++;
    } catch (err) {
      failed++;
      console.error(
        `[drain.tick] workspace=${ws.workspaceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId: ws.workspaceId }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId: ws.workspaceId });
  }
  return { workspaces: wss.length, totalSent, totalSkipped, failed, held, busy };
}

const handleDrainTick: InstrumentedHandler = (_payload, { incidents }) =>
  runDrainTick(incidents);

/**
 * mail.imap.tick: workspaces with IMAP auto-sync on (P61-23: off means the
 * operator only pulls via the manual Sync button), their ACTIVE mailboxes
 * with IMAP whose sync gate has passed are synced through safeSyncOne, so
 * every failure is classified and leaves a gate (flow:F-04, PC-09).
 * PC-06: a workspace the automation gate holds for Inbox sync is skipped
 * whole (X6: 0 messages synced under an Inbox-sync hold).
 *
 * PC-09: a failing mailbox is no longer this tick's: its recovery follows
 * its failure class in the mail.probe.tick (runMailProbeTick), and a
 * mailbox failing since before PC-09 waits for the reviewed backfill
 * (src/lib/remediation/mailbox-health-backfill.ts) — flow:F-04's automatic
 * adoption pass is gone.
 *
 * PC-07: a mailbox whose sync crashes (a DB error, not a mailbox one) is
 * an incident; its next clean sync resolves it. Mailbox auth / connection
 * failures are mailbox health, not tick crashes — they become the
 * mailbox's own incident (services/mailbox-health.ts).
 *
 * Exported for tests (deterministic, unlike enqueue-and-wait).
 */
export async function runImapTick(
  now: Date = new Date(),
  incidents: TickIncidents = NOOP_TICK_INCIDENTS,
): Promise<{
  mailboxesSynced: number;
  failed: number;
  skipped: number;
  markedFailing: number;
  held: number;
  /** PC-12: mailboxes another sync or check was already working on. */
  busy: number;
}> {
  const tickWss = await workspacesForTick(now);

  let synced = 0;
  let failed = 0;
  let skipped = 0;
  let markedFailing = 0;
  let held = 0;
  let busy = 0;
  for (const ws of tickWss) {
    // Auto-sync off (P61-23): the operator pulls by hand only — not
    // counted as held even when a hold also applies.
    if (!ws.policy.inbox.autoSync) continue;
    if (!shouldRun(ws, 'mail.imap.tick', () => held++)) continue;
    const mbs = await db
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.workspaceId, ws.workspaceId),
          eq(mailboxes.status, 'active'),
          or(
            isNull(mailboxes.imapNextSyncAfter),
            lte(mailboxes.imapNextSyncAfter, now),
          ),
        ),
      );
    const eligible = mbs.filter((m) => m.imapHost);
    skipped += mbs.length - eligible.length;
    if (eligible.length === 0) continue;
    const ctx = ws.ctx;
    for (const mb of eligible) {
      // PC-05: re-check per mailbox — an Inbox-sync hold placed mid-tick
      // (or the owner losing access) stops this workspace's remaining
      // syncs. The workspace pause never does: inbox sync keeps reading.
      const recheck = await checkGate(ctx, 'inbox_sync', { manual: false, now });
      if (!recheck.allowed) {
        held++;
        logGateSkip('imap.tick', ws.workspaceId, recheck);
        break;
      }
      const subject = { workspaceId: ws.workspaceId, part: `mailbox:${mb.id}` };
      let outcome: Awaited<ReturnType<typeof safeSyncOne>>;
      try {
        outcome = await safeSyncOne(ctx, mb);
      } catch (err) {
        if (err instanceof AutomationGateError) {
          // The gate refused inside safeSyncOne (a hold between the
          // re-check and the sync): held, not a mailbox failure.
          held++;
          break;
        }
        // A DB error, not a mailbox one — one bad row must not stop the tick.
        failed++;
        console.error(
          `[imap.tick] workspace=${ws.workspaceId} mailbox=${mb.id} sync crashed:`,
          err instanceof Error ? err.message : err,
        );
        await incidents.failed(subject, err);
        continue;
      }
      // PC-12: a manual Sync, Test connection or health probe of this
      // mailbox is running (its lease): not a failure, and not a success
      // that would resolve an incident either. The next tick syncs it.
      if (outcome.kind === 'busy') {
        busy++;
        continue;
      }
      await incidents.succeeded(subject);
      if (outcome.kind === 'synced') {
        synced++;
      } else if (outcome.kind === 'skipped') {
        // It failed or was paused since the list was read.
        skipped++;
      } else if (outcome.kind === 'failing') {
        failed++;
        markedFailing++;
        console.error(
          `[imap.tick] workspace=${ws.workspaceId} mailbox=${mb.id} failing (${outcome.failureClass ?? 'unclassified'}; next probe ${outcome.nextProbeAt?.toISOString() ?? 'none — waits for a person'}): ${outcome.message}`,
        );
      } else {
        failed++;
        console.error(
          `[imap.tick] workspace=${ws.workspaceId} mailbox=${mb.id} transient failure ${outcome.consecutiveFailures}: ${outcome.message}`,
        );
      }
    }
  }
  return {
    mailboxesSynced: synced,
    failed,
    skipped,
    markedFailing,
    held,
    busy,
  };
}

const handleImapTick: InstrumentedHandler = (_payload, { incidents }) =>
  runImapTick(new Date(), incidents);

/**
 * PC-09: mail.probe.tick — mailbox health. Every 5 minutes, for every
 * active workspace the gate lets talk to its mail servers (tickVerdict:
 * the Inbox-sync capability, so the pause does not stop it and a hold
 * does; auto-sync off does not, a send-only mailbox needs watching too):
 * each active or failing mailbox with something due gets it
 * (services/mailbox-probes.ts) — a credential-free SMTP probe every 30
 * minutes, the authenticated SMTP verify once a day, and a failing
 * mailbox's recovery by class (an 'auth' failure never; 'connection' by
 * credential-free probes backing off to 6 h; 'ambiguous' at most four
 * logins, 6 h apart). Every probe holds the mailbox's lease.
 *
 * PC-07: a workspace whose due-list read throws, or a mailbox whose probe
 * crashes (a DB error — a mail-server failure is the mailbox's own
 * incident, never the tick's), is an incident until its next clean pass.
 *
 * Exported for tests (the fake clock drives `now`).
 */
export async function runMailProbeTick(
  now: Date = new Date(),
  incidents: TickIncidents = NOOP_TICK_INCIDENTS,
): Promise<{
  workspaces: number;
  probed: number;
  verified: number;
  rechecked: number;
  /** Authenticated checks run (each a login per protocol checked). */
  logins: number;
  recovered: number;
  markedFailing: number;
  held: number;
  busy: number;
  failed: number;
  workspacesFailed: number;
}> {
  const wss = await workspacesForTick(now);
  const out = {
    workspaces: wss.length,
    probed: 0,
    verified: 0,
    rechecked: 0,
    logins: 0,
    recovered: 0,
    markedFailing: 0,
    held: 0,
    busy: 0,
    failed: 0,
    workspacesFailed: 0,
  };
  for (const ws of wss) {
    if (!shouldRun(ws, 'mail.probe.tick', () => out.held++)) continue;
    let due: Awaited<ReturnType<typeof listMailboxesDueForProbe>>;
    try {
      due = await listMailboxesDueForProbe(ws.ctx, now);
    } catch (err) {
      out.workspacesFailed++;
      console.error(
        `[mail.probe.tick] workspace=${ws.workspaceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId: ws.workspaceId }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId: ws.workspaceId });
    for (const mb of due) {
      // PC-06: re-check per mailbox — a hold placed mid-tick stops the
      // rest of this workspace's probes.
      const recheck = await checkGate(ws.ctx, 'inbox_sync', { manual: false, now });
      if (!recheck.allowed) {
        out.held++;
        logGateSkip('mail.probe.tick', ws.workspaceId, recheck);
        break;
      }
      const subject = { workspaceId: ws.workspaceId, part: `mailbox:${mb.id}` };
      let outcome: Awaited<ReturnType<typeof probeMailbox>>;
      try {
        outcome = await probeMailbox(ws.ctx, mb.id, now);
      } catch (err) {
        out.failed++;
        console.error(
          `[mail.probe.tick] workspace=${ws.workspaceId} mailbox=${mb.id} probe crashed:`,
          err instanceof Error ? err.message : err,
        );
        await incidents.failed(subject, err);
        continue;
      }
      if (outcome.action === 'busy') {
        out.busy++;
        continue;
      }
      await incidents.succeeded(subject);
      if (outcome.action === 'probe') out.probed++;
      if (outcome.action === 'verify') out.verified++;
      if (outcome.action === 'recheck') out.rechecked++;
      out.logins += outcome.logins;
      if (outcome.recovered) out.recovered++;
      if (outcome.failing !== null && mb.status === 'active') out.markedFailing++;
    }
  }
  return out;
}

const handleMailProbeTick: InstrumentedHandler = (_payload, { incidents }) =>
  runMailProbeTick(new Date(), incidents);

/** Follow-up tick body. Exported for tests (deterministic). */
export async function runFollowUpTick(
  incidents: TickIncidents = NOOP_TICK_INCIDENTS,
): Promise<{
  workspaces: number;
  checked: number;
  sent: number;
  skipped: number;
  failed: number;
  held: number;
  /** PC-12: workspaces whose follow-up pass was already running. */
  busy: number;
  workspacesFailed: number;
}> {
  // Phase 58 / PC-13: every active workspace whose policy has follow-ups
  // on (tickVerdict); processDueFollowUps re-checks the gate per item.
  const wss = await workspacesForTick();
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let checked = 0;
  let held = 0;
  let busy = 0;
  let workspacesFailed = 0;
  for (const ws of wss) {
    if (!shouldRun(ws, 'outreach.follow_up.tick', () => held++)) continue;
    try {
      const result = await processDueFollowUps(ws.ctx, { purpose: 'tick' });
      if (result.followUpPass) {
        busy++;
        continue;
      }
      checked += result.checked;
      sent += result.sent;
      skipped += result.skipped;
      failed += result.failed;
      if (result.heldReason) held++;
    } catch (err) {
      workspacesFailed++;
      console.error(
        `[follow_up.tick] workspace=${ws.workspaceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId: ws.workspaceId }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId: ws.workspaceId });
  }
  return { workspaces: wss.length, checked, sent, skipped, failed, held, busy, workspacesFailed };
}

const handleFollowUpTick: InstrumentedHandler = (_payload, { incidents }) =>
  runFollowUpTick(incidents);

/** Crawl-engine tick body. Exported for tests (deterministic). */
export async function runCrawlEngineTick(
  now: Date = new Date(),
  incidents: TickIncidents = NOOP_TICK_INCIDENTS,
): Promise<{
  workspaces: number;
  processed: number;
  inQuietHours: number;
  totalStartedRuns: number;
  totalFailedRecipes: number;
  held: number;
  /** PC-05: due plans skipped (and moved on) for an empty wallet. */
  walletEmptySkipped: number;
  workspacesFailed: number;
}> {
  const wss = await workspacesForTick(now);
  let processed = 0;
  let inQuiet = 0;
  let totalStarted = 0;
  let totalFailed = 0;
  let held = 0;
  let walletEmptySkipped = 0;
  let workspacesFailed = 0;
  for (const ws of wss) {
    if (!shouldRun(ws, 'crawl.engine.tick', () => held++)) continue;
    try {
      const result = await processDueCrawlPlans(ws.ctx, now);
      processed += result.processed;
      inQuiet += result.inQuietHours;
      totalStarted += result.totalStartedRuns;
      totalFailed += result.totalFailedRecipes;
      walletEmptySkipped += result.walletEmptySkipped ?? 0;
      if (result.heldReason) held++;
    } catch (err) {
      workspacesFailed++;
      console.error(
        `[crawl.engine.tick] workspace=${ws.workspaceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId: ws.workspaceId }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId: ws.workspaceId });
  }
  return {
    workspaces: wss.length,
    processed,
    inQuietHours: inQuiet,
    totalStartedRuns: totalStarted,
    totalFailedRecipes: totalFailed,
    held,
    walletEmptySkipped,
    workspacesFailed,
  };
}

const handleCrawlEngineTick: InstrumentedHandler = (_payload, { incidents }) =>
  runCrawlEngineTick(new Date(), incidents);

/** Trash purge tick body. Exported for tests. PC-05: the purge is
 *  automatic work — held while the workspace is paused (and under a
 *  Trash purge hold, or without an accountable owner). */
export async function runMailTrashPurgeTick(
  incidents: TickIncidents = NOOP_TICK_INCIDENTS,
): Promise<{
  workspaces: number;
  deleted: number;
  failed: number;
  held: number;
}> {
  const wss = await workspacesForTick();
  let totalDeleted = 0;
  let failed = 0;
  let held = 0;
  for (const ws of wss) {
    if (!shouldRun(ws, 'mail.trash.purge.tick', () => held++)) continue;
    try {
      const result = await purgeOldTrashUnattended(ws.workspaceId);
      totalDeleted += result.deleted;
      if (result.heldReason) held++;
    } catch (err) {
      failed++;
      console.error(
        `[mail.trash.purge.tick] workspace=${ws.workspaceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId: ws.workspaceId }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId: ws.workspaceId });
  }
  return { workspaces: wss.length, deleted: totalDeleted, failed, held };
}

const handleMailTrashPurgeTick: InstrumentedHandler = (_payload, { incidents }) =>
  runMailTrashPurgeTick(incidents);

/** Knowledge-compaction (+ synthesis) tick body. Exported for tests. */
export async function runKnowledgeCompactTick(
  incidents: TickIncidents = NOOP_TICK_INCIDENTS,
): Promise<{
  workspaces: number;
  processed: number;
  merged: number;
  retired: number;
  synthesized: number;
  failed: number;
  clusterFailures: number;
  synthesisFailed: number;
  held: number;
}> {
  const wss = await workspacesForTick();
  let processed = 0;
  let merged = 0;
  let retired = 0;
  let synthesized = 0;
  let failed = 0;
  let clusterFailures = 0;
  let synthesisFailed = 0;
  let held = 0;
  for (const ws of wss) {
    // PC-06: compaction and synthesis are both Background AI. PC-05: both
    // call the AI, so an empty wallet skips them too (I110).
    if (!shouldRun(ws, 'knowledge.compact.tick', () => held++)) continue;
    const compaction = { workspaceId: ws.workspaceId, part: 'compaction' };
    try {
      const summary = await compactWorkspaceKnowledgeUnattended(ws.workspaceId);
      processed += 1;
      merged += summary.mergedClusters;
      retired += summary.retiredMergedCount + summary.retiredStaleCount;
      // The unattended pass swallows a failed cluster merge so the other
      // clusters still run (I021: that failure only reached the console).
      // Any failed merge makes the workspace's compaction an incident.
      if (summary.failedClusters > 0) {
        clusterFailures += summary.failedClusters;
        await incidents.failed(
          compaction,
          new Error(
            `${summary.failedClusters} cluster merge(s) failed: ${summary.lastClusterError ?? 'unknown error'}`,
          ),
        );
      } else {
        await incidents.succeeded(compaction);
      }
    } catch (err) {
      failed++;
      console.error(
        `[knowledge.compact.tick] workspace=${ws.workspaceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed(compaction, err);
    }
    // Self-learning synthesis rides the same weekly cadence, AFTER
    // compaction so it mines a deduplicated rule base. Its own failure
    // must not count against compaction (and vice versa): a separate
    // incident subject.
    const synthesis = {
      workspaceId: ws.workspaceId,
      part: 'synthesis',
      label: 'Learning synthesis',
    };
    try {
      const s = await synthesizeWorkspaceLearningUnattended(ws.workspaceId);
      synthesized += s.lessonsCreated;
    } catch (err) {
      synthesisFailed++;
      console.error(
        `[knowledge.compact.tick] synthesis workspace=${ws.workspaceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed(synthesis, err);
      continue;
    }
    await incidents.succeeded(synthesis);
  }
  return {
    workspaces: wss.length,
    processed,
    merged,
    retired,
    synthesized,
    failed,
    clusterFailures,
    synthesisFailed,
    held,
  };
}

const handleKnowledgeCompactTick: InstrumentedHandler = (_payload, { incidents }) =>
  runKnowledgeCompactTick(incidents);

/** Health-check tick body. Exported for tests. PC-13: only workspaces
 *  whose policy runs the health check are considered; processDueHealthChecks
 *  claims each due one atomically, and its AI review asks the gate itself.
 *  PC-07: a workspace whose check throws is an incident until its next
 *  clean check. */
export async function runHealthCheckTick(
  incidents: TickIncidents = NOOP_TICK_INCIDENTS,
): Promise<Awaited<ReturnType<typeof processDueHealthChecks>>> {
  const wss = await workspacesForTick();
  const workspaceIds = wss
    .filter((ws) => shouldRun(ws, 'health.check.tick', () => undefined))
    .map((ws) => ws.workspaceId);
  return processDueHealthChecks({
    workspaceIds,
    onWorkspaceFailed: (workspaceId, err) => incidents.failed({ workspaceId }, err),
    onWorkspaceSucceeded: (workspaceId) => incidents.succeeded({ workspaceId }),
  });
}

const handleHealthCheckTick: InstrumentedHandler = (_payload, { incidents }) =>
  runHealthCheckTick(incidents);

/**
 * PC-10: settle stuck work — sends stuck in 'sending' for more than 10
 * minutes, runs without progress for 15 (or pending for 60 with their job
 * gone from the queue), PC-12: follow-up claims a dead pass left for 30
 * (claims a live lease holder may own are left alone). Every active
 * workspace, plus any other workspace
 * with stuck work (an archived one's stuck rows are settled too).
 * Platform maintenance, not automation: it sends nothing and starts
 * nothing, so it runs whatever the workspace's pause or holds say.
 */
const handleStuckWorkTick: InstrumentedHandler = async (_payload, { incidents }) => {
  const now = new Date();
  const active = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
  const wss = new Map(active.map((ws) => [ws.id.toString(), ws.id]));
  for (const id of await listWorkspacesWithStuckWork(now)) wss.set(id.toString(), id);
  let sendsSettledSent = 0;
  let sendsFailed = 0;
  let runsFailed = 0;
  let runsCancelled = 0;
  let followUpsRequeued = 0;
  let followUpsSettledSent = 0;
  let followUpsFailed = 0;
  let workspacesFailed = 0;
  for (const workspaceId of wss.values()) {
    try {
      const r = await reapStuckWork({ workspaceId }, now);
      sendsSettledSent += r.sendsSettledSent;
      sendsFailed += r.sendsFailed;
      runsFailed += r.runsFailed;
      runsCancelled += r.runsCancelled;
      followUpsRequeued += r.followUpsRequeued;
      followUpsSettledSent += r.followUpsSettledSent;
      followUpsFailed += r.followUpsFailed;
    } catch (err) {
      workspacesFailed++;
      console.error(
        `[ops.reaper.tick] workspace=${workspaceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId });
  }
  // Run incidents whose recipe / connector is gone or switched off: no
  // next run can resolve them. Best-effort, platform-wide.
  let runIncidentsClosed = 0;
  try {
    runIncidentsClosed = await resolveOrphanedRunIncidents();
  } catch (err) {
    console.error(
      '[ops.reaper.tick] orphaned run incidents not resolved:',
      err instanceof Error ? err.message : err,
    );
  }
  return {
    workspaces: wss.size,
    sendsSettledSent,
    sendsFailed,
    runsFailed,
    runsCancelled,
    followUpsRequeued,
    followUpsSettledSent,
    followUpsFailed,
    workspacesFailed,
    runIncidentsClosed,
  };
};

/**
 * PC-35 (I066): delete log rows past their retention window
 * (services/retention.ts). Platform housekeeping, not automation: it
 * sends, spends and starts nothing, so no workspace pause, hold or the
 * platform outbound stop gates it. Not per workspace: one pass per table
 * across every workspace (suspended ones too). A failed policy fails the
 * tick (after the other policies ran), which opens its tick.failed
 * incident.
 */
const handleRetentionTick: InstrumentedHandler = () => runRetentionTick();

/** KL-03: per-workspace errors are caught inside runLearningSweep
 *  (workspacesFailed in the heartbeat summary). */
const handleLearningSweepTick: InstrumentedHandler = () => runLearningSweep();

/** KL-06: per-workspace errors are caught inside runKnowledgeIndexSweep. */
const handleKnowledgeIndexSweepTick: InstrumentedHandler = () => runKnowledgeIndexSweep();

const TICK_HANDLERS: Record<TickName, InstrumentedHandler> = {
  'autopilot.tick': handleAutopilotTick,
  'outreach.drain.tick': handleDrainTick,
  'mail.imap.tick': handleImapTick,
  'mail.probe.tick': handleMailProbeTick,
  'outreach.follow_up.tick': handleFollowUpTick,
  'knowledge.compact.tick': handleKnowledgeCompactTick,
  'mail.trash.purge.tick': handleMailTrashPurgeTick,
  'crawl.engine.tick': handleCrawlEngineTick,
  'health.check.tick': handleHealthCheckTick,
  'ops.reaper.tick': handleStuckWorkTick,
  'ops.retention.tick': handleRetentionTick,
  'learning.sweep': handleLearningSweepTick,
  'knowledge.index.sweep': handleKnowledgeIndexSweepTick,
};

/** Platform incident raised when startup could not schedule the ticks. */
export const SCHEDULE_REGISTRATION_FAILED = 'jobs.schedule_registration_failed';
const SCHEDULE_REGISTRATION_SOURCE = 'startup';

export function scheduleRegistrationFingerprint(): string {
  return opsEventFingerprint({
    scope: 'platform',
    kind: SCHEDULE_REGISTRATION_FAILED,
    dedupeKey: SCHEDULE_REGISTRATION_SOURCE,
  });
}

/**
 * Startup could not schedule the ticks (Redis down at boot, …): nothing
 * runs until the next boot, so it is a critical platform incident, not
 * just a console line (I022). The next successful registration resolves
 * it. Best-effort; never throws.
 */
export async function reportScheduleRegistrationFailure(err: unknown): Promise<void> {
  try {
    await raiseOpsEvent({
      scope: 'platform',
      kind: SCHEDULE_REGISTRATION_FAILED,
      severity: 'critical',
      source: SCHEDULE_REGISTRATION_SOURCE,
      dedupeKey: SCHEDULE_REGISTRATION_SOURCE,
      title: 'Background ticks could not be scheduled at startup',
      error: err,
    });
  } catch (recordErr) {
    console.error(
      '[startup] schedule registration incident not recorded:',
      recordErr instanceof Error ? recordErr.message : recordErr,
    );
  }
}

let registered = false;

/**
 * Register the tick handlers + their cron schedules. Idempotent — call once
 * at boot. Tests pass `skipSchedule: true` to register the handlers without
 * starting timers.
 *
 * Scheduling stamps each tick's heartbeat with registered_at, boot_id,
 * interval and queue provider (best-effort — a failed write is logged and
 * does not stop the schedule) and resolves an open "could not be
 * scheduled" incident from an earlier boot.
 */
export async function registerRepeatableJobs(
  options: { skipSchedule?: boolean } = {},
): Promise<void> {
  if (registered) return;
  const q = getJobQueue();
  for (const tick of TICK_CATALOG) {
    q.on(
      tick.name,
      instrumented(tick.name, TICK_HANDLERS[tick.name], { kind: 'tick', label: tick.label }),
    );
  }
  if (!options.skipSchedule) {
    const boot = getBootInfo();
    const queueProvider = q.id ?? process.env.JOB_QUEUE_PROVIDER ?? 'memory';
    for (const tick of TICK_CATALOG) {
      // Captured before scheduling: the memory queue's setInterval counts
      // its slots from this moment (PC-07 expected-slot rule).
      const registeredAt = new Date();
      await q.enqueueRepeatable(tick.name, {}, { everyMs: tick.everyMs, jobId: tick.jobId });
      try {
        await recordTickRegistration({
          name: tick.name,
          intervalMs: tick.everyMs,
          queueProvider,
          bootId: boot.id,
          registeredAt,
        });
      } catch (err) {
        console.error(
          `[jobs] ${tick.name}: schedule registration heartbeat not recorded:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    try {
      await resolveOpsEvent(scheduleRegistrationFingerprint(), { resolution: 'auto' });
    } catch (err) {
      console.error(
        '[jobs] schedule registration incident not resolved:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  registered = true;
}

/** For tests — clear the flag so registration can re-run after queue reset. */
export function _resetRepeatablesForTests(): void {
  registered = false;
}
