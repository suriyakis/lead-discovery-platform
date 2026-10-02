// Phase 34: scheduled background work. The tick handlers fan out across
// the active workspaces / mailboxes so the platform actually does its job
// without anyone clicking buttons. Names, cadences and labels are in
// tick-catalog.ts.
//
//   autopilot.tick          every 5 min  → for each active workspace with
//                                           autopilot ON and its emergency
//                                           pause OFF (PC-35,
//                                           listAutopilotTickWorkspaces),
//                                           autopilot.runOnce(ctx)
//   outreach.drain.tick     every 30 s   → for each active workspace, drain
//                                           the send queue
//   mail.imap.tick          every 2 min  → for each active mailbox with IMAP,
//                                           mail.safeSyncOne(ctx, mb); failing
//                                           mailboxes get a slow re-check
//                                           instead (flow:F-04, runImapTick)
//   outreach.follow_up.tick every 1 h    → Phase 58: for each active
//                                           workspace (processDueFollowUps
//                                           no-ops where follow-ups are off),
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
//
// Each handler iterates serially and swallows per-tenant errors so one
// stuck workspace can't block the whole platform.
//
// PC-07 (I021/I022): every handler is registered through instrumented(),
// which writes the job_heartbeats row (start, finish, duration, status,
// consecutive failures, the structured summary each handler returns) and
// hands the handler a TickIncidents: a per-workspace error becomes an
// ops_event (one open incident per workspace + step, occurrences counted)
// and that workspace's next success resolves it. Cadences and labels live
// in tick-catalog.ts; the schedule registration stamps registered_at and
// boot_id on each tick's heartbeat.

import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import { mailboxes } from '@/lib/db/schema/mailing';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { listAutopilotTickWorkspaces, runOnce } from '@/lib/services/autopilot';
import { drainQueue } from '@/lib/services/outreach-queue';
import { purgeOldTrashUnattended, safeSyncOne } from '@/lib/services/mail';
import { processDueCrawlPlans } from '@/lib/services/crawl-engine';
import { processDueFollowUps } from '@/lib/services/follow-up';
import { compactWorkspaceKnowledgeUnattended } from '@/lib/services/knowledge-compaction';
import { synthesizeWorkspaceLearningUnattended } from '@/lib/services/learning-synthesis';
import { processDueHealthChecks } from '@/lib/services/health-check';
import {
  listWorkspacesWithStuckWork,
  reapStuckWork,
  resolveOrphanedRunIncidents,
} from '@/lib/services/stuck-work';
import { runRetentionTick } from '@/lib/services/retention';
import { adoptUntrackedFailingMailboxes } from '@/lib/services/mailbox';
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

function ownerCtx(workspaceId: bigint, ownerUserId: string): WorkspaceContext {
  return makeWorkspaceContext({
    workspaceId,
    userId: ownerUserId,
    role: 'owner',
  });
}

function activeWorkspaces() {
  return db.select().from(workspaces).where(eq(workspaces.status, 'active'));
}

/**
 * autopilot.tick body. PC-35 (I066): only workspaces whose autopilot is on
 * and unpaused are run, so a workspace with autopilot off writes nothing
 * (it used to log a 'guard skipped' row every 5 minutes). Exported for
 * tests (deterministic, unlike enqueue-and-wait).
 */
export async function runAutopilotTick(
  incidents: TickIncidents = NOOP_TICK_INCIDENTS,
): Promise<{ workspaces: number; stepsRun: number; failed: number }> {
  const wss = await listAutopilotTickWorkspaces();
  let ran = 0;
  let failed = 0;
  for (const ws of wss) {
    try {
      const ctx = ownerCtx(ws.id, ws.ownerUserId);
      const result = await runOnce(ctx);
      ran += result.steps.length;
    } catch (err) {
      failed++;
      console.error(
        `[autopilot.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId: ws.id }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId: ws.id });
  }
  return { workspaces: wss.length, stepsRun: ran, failed };
}

const handleAutopilotTick: InstrumentedHandler = (_payload, { incidents }) =>
  runAutopilotTick(incidents);

const handleDrainTick: InstrumentedHandler = async (_payload, { incidents }) => {
  const wss = await activeWorkspaces();
  let totalSent = 0;
  let totalSkipped = 0;
  let failed = 0;
  for (const ws of wss) {
    try {
      const ctx = ownerCtx(ws.id, ws.ownerUserId);
      const r = await drainQueue(ctx);
      totalSent += r.sent;
      totalSkipped += r.skipped;
    } catch (err) {
      failed++;
      console.error(
        `[drain.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId: ws.id }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId: ws.id });
  }
  return { workspaces: wss.length, totalSent, totalSkipped, failed };
};

/**
 * mail.imap.tick. flow:F-04 makes it two passes:
 *
 *  1. Every active workspace, also with IMAP auto-sync off: failing
 *     mailboxes with no re-check gate yet are adopted
 *     (adoptUntrackedFailingMailboxes, no network) — each gets its gate
 *     and the deduped mailbox.failing notification, so prod's two silent
 *     failing mailboxes (X7) are announced by the first tick after deploy.
 *  2. Workspaces with IMAP auto-sync on (P61-23: off means the operator
 *     only pulls via the manual Sync button), mailboxes whose gate has
 *     passed: active ones with IMAP are synced, failing ones (with or
 *     without IMAP) get their SMTP + IMAP re-check. Both through
 *     safeSyncOne, so every failure leaves a non-null gate.
 *
 * PC-07: a workspace whose adoption pass throws, or a mailbox whose sync
 * crashes (a DB error, not a mailbox one), is an incident; its next clean
 * pass resolves it. Mailbox auth / connection failures are mailbox health,
 * not tick crashes — they stay with safeSyncOne (flow:F-04).
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
  rechecked: number;
  recovered: number;
  adopted: number;
  /** Workspaces whose adoption pass threw. */
  workspacesFailed: number;
}> {
  const wss = await activeWorkspaces();

  let adopted = 0;
  let workspacesFailed = 0;
  for (const ws of wss) {
    const subject = { workspaceId: ws.id, part: 'adopt' };
    try {
      adopted += await adoptUntrackedFailingMailboxes(ownerCtx(ws.id, ws.ownerUserId));
    } catch (err) {
      workspacesFailed++;
      console.error(
        `[imap.tick] workspace=${ws.id} adopting failing mailboxes failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed(subject, err);
      continue;
    }
    await incidents.succeeded(subject);
  }

  let synced = 0;
  let failed = 0;
  let skipped = 0;
  let markedFailing = 0;
  let rechecked = 0;
  let recovered = 0;
  for (const ws of wss) {
    if (!ws.imapAutoSyncEnabled) continue;
    const mbs = await db
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.workspaceId, ws.id),
          inArray(mailboxes.status, ['active', 'failing']),
          or(
            isNull(mailboxes.imapNextSyncAfter),
            lte(mailboxes.imapNextSyncAfter, now),
          ),
        ),
      );
    const eligible = mbs.filter((m) => m.status === 'failing' || m.imapHost);
    skipped += mbs.length - eligible.length;
    if (eligible.length === 0) continue;
    const ctx = ownerCtx(ws.id, ws.ownerUserId);
    for (const mb of eligible) {
      if (mb.status === 'failing') rechecked++;
      const subject = { workspaceId: ws.id, part: `mailbox:${mb.id}` };
      let outcome: Awaited<ReturnType<typeof safeSyncOne>>;
      try {
        outcome = await safeSyncOne(ctx, mb);
      } catch (err) {
        // A DB error, not a mailbox one — one bad row must not stop the tick.
        failed++;
        console.error(
          `[imap.tick] workspace=${ws.id} mailbox=${mb.id} sync crashed:`,
          err instanceof Error ? err.message : err,
        );
        await incidents.failed(subject, err);
        continue;
      }
      await incidents.succeeded(subject);
      if (outcome.kind === 'synced') {
        synced++;
        if (outcome.recovered) recovered++;
      } else if (outcome.kind === 'failing') {
        failed++;
        if (mb.status === 'active') markedFailing++;
        console.error(
          `[imap.tick] workspace=${ws.id} mailbox=${mb.id} failing (next check ${outcome.nextSyncAfter?.toISOString() ?? 'n/a'}): ${outcome.message}`,
        );
      } else {
        failed++;
        console.error(
          `[imap.tick] workspace=${ws.id} mailbox=${mb.id} transient failure ${outcome.consecutiveFailures}: ${outcome.message}`,
        );
      }
    }
  }
  return {
    mailboxesSynced: synced,
    failed,
    skipped,
    markedFailing,
    rechecked,
    recovered,
    adopted,
    workspacesFailed,
  };
}

const handleImapTick: InstrumentedHandler = (_payload, { incidents }) =>
  runImapTick(new Date(), incidents);

const handleFollowUpTick: InstrumentedHandler = async (_payload, { incidents }) => {
  // Phase 58: every active workspace with follow-ups enabled. The
  // service-level loadSettings() is the source of truth — we just
  // iterate the workspace list and let processDueFollowUps no-op
  // for any that have follow-ups disabled.
  const wss = await activeWorkspaces();
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let checked = 0;
  let workspacesFailed = 0;
  for (const ws of wss) {
    const ctx = ownerCtx(ws.id, ws.ownerUserId);
    try {
      const result = await processDueFollowUps(ctx);
      checked += result.checked;
      sent += result.sent;
      skipped += result.skipped;
      failed += result.failed;
    } catch (err) {
      workspacesFailed++;
      console.error(
        `[follow_up.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId: ws.id }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId: ws.id });
  }
  return { workspaces: wss.length, checked, sent, skipped, failed, workspacesFailed };
};

const handleCrawlEngineTick: InstrumentedHandler = async (_payload, { incidents }) => {
  const wss = await activeWorkspaces();
  const now = new Date();
  let processed = 0;
  let inQuiet = 0;
  let totalStarted = 0;
  let totalFailed = 0;
  let workspacesFailed = 0;
  for (const ws of wss) {
    const ctx = ownerCtx(ws.id, ws.ownerUserId);
    try {
      const result = await processDueCrawlPlans(ctx, now);
      processed += result.processed;
      inQuiet += result.inQuietHours;
      totalStarted += result.totalStartedRuns;
      totalFailed += result.totalFailedRecipes;
    } catch (err) {
      workspacesFailed++;
      console.error(
        `[crawl.engine.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId: ws.id }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId: ws.id });
  }
  return {
    workspaces: wss.length,
    processed,
    inQuietHours: inQuiet,
    totalStartedRuns: totalStarted,
    totalFailedRecipes: totalFailed,
    workspacesFailed,
  };
};

const handleMailTrashPurgeTick: InstrumentedHandler = async (_payload, { incidents }) => {
  const wss = await activeWorkspaces();
  let totalDeleted = 0;
  let failed = 0;
  for (const ws of wss) {
    try {
      const result = await purgeOldTrashUnattended(ws.id);
      totalDeleted += result.deleted;
    } catch (err) {
      failed++;
      console.error(
        `[mail.trash.purge.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed({ workspaceId: ws.id }, err);
      continue;
    }
    await incidents.succeeded({ workspaceId: ws.id });
  }
  return { workspaces: wss.length, deleted: totalDeleted, failed };
};

const handleKnowledgeCompactTick: InstrumentedHandler = async (_payload, { incidents }) => {
  const wss = await activeWorkspaces();
  let processed = 0;
  let merged = 0;
  let retired = 0;
  let synthesized = 0;
  let failed = 0;
  let clusterFailures = 0;
  let synthesisFailed = 0;
  for (const ws of wss) {
    const compaction = { workspaceId: ws.id, part: 'compaction' };
    try {
      const summary = await compactWorkspaceKnowledgeUnattended(ws.id);
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
        `[knowledge.compact.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      await incidents.failed(compaction, err);
    }
    // Self-learning synthesis rides the same weekly cadence, AFTER
    // compaction so it mines a deduplicated rule base. Its own failure
    // must not count against compaction (and vice versa): a separate
    // incident subject.
    const synthesis = { workspaceId: ws.id, part: 'synthesis', label: 'Learning synthesis' };
    try {
      const s = await synthesizeWorkspaceLearningUnattended(ws.id);
      synthesized += s.lessonsCreated;
    } catch (err) {
      synthesisFailed++;
      console.error(
        `[knowledge.compact.tick] synthesis workspace=${ws.id} failed:`,
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
  };
};

const handleHealthCheckTick: InstrumentedHandler = async (_payload, { incidents }) => {
  return processDueHealthChecks({
    onWorkspaceFailed: (workspaceId, err) => incidents.failed({ workspaceId }, err),
    onWorkspaceSucceeded: (workspaceId) => incidents.succeeded({ workspaceId }),
  });
};

/**
 * PC-10: settle stuck work — sends stuck in 'sending' for more than 10
 * minutes, runs without progress for 15 (or pending for 60 with their job
 * gone from the queue). Every active workspace, plus any other workspace
 * with stuck work (an archived one's stuck rows are settled too).
 * Platform maintenance, not automation: it sends nothing and starts
 * nothing, so it runs whatever the workspace's pause says.
 */
const handleStuckWorkTick: InstrumentedHandler = async (_payload, { incidents }) => {
  const now = new Date();
  const wss = new Map((await activeWorkspaces()).map((ws) => [ws.id.toString(), ws.id]));
  for (const id of await listWorkspacesWithStuckWork(now)) wss.set(id.toString(), id);
  let sendsSettledSent = 0;
  let sendsFailed = 0;
  let runsFailed = 0;
  let runsCancelled = 0;
  let workspacesFailed = 0;
  for (const workspaceId of wss.values()) {
    try {
      const r = await reapStuckWork({ workspaceId }, now);
      sendsSettledSent += r.sendsSettledSent;
      sendsFailed += r.sendsFailed;
      runsFailed += r.runsFailed;
      runsCancelled += r.runsCancelled;
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

const TICK_HANDLERS: Record<TickName, InstrumentedHandler> = {
  'autopilot.tick': handleAutopilotTick,
  'outreach.drain.tick': handleDrainTick,
  'mail.imap.tick': handleImapTick,
  'outreach.follow_up.tick': handleFollowUpTick,
  'knowledge.compact.tick': handleKnowledgeCompactTick,
  'mail.trash.purge.tick': handleMailTrashPurgeTick,
  'crawl.engine.tick': handleCrawlEngineTick,
  'health.check.tick': handleHealthCheckTick,
  'ops.reaper.tick': handleStuckWorkTick,
  'ops.retention.tick': handleRetentionTick,
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
