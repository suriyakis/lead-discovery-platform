// Phase 34: scheduled background work. Four tick handlers fan out across
// every active workspace / mailbox so the platform actually does its job
// without anyone clicking buttons.
//
//   autopilot.tick         every 5 min  → for each ws with autopilot
//                                          enabled, call autopilot.runOnce(ctx)
//   outreach.drain.tick    every 30 sec → for each active workspace, drain
//                                          the send queue
//   mail.imap.tick         every 2 min  → for each active mailbox with IMAP,
//                                          mail.safeSyncOne(ctx, mb); failing
//                                          mailboxes get a slow re-check
//                                          instead (flow:F-04, runImapTick)
//   outreach.follow_up.tick every 1 h    → Phase 58: for each active
//                                          workspace with followUpEnabled,
//                                          process pending follow-ups whose
//                                          scheduled_for has passed.
//   learning.sweep         every 2 min  → KL-03: the learning outbox's
//                                          sweeper (stale claims, lost jobs,
//                                          backoff retries, events waiting
//                                          for tokens, missed compensations)
//                                          — runLearningSweep.
//
// Each handler iterates serially and swallows per-tenant errors so one
// stuck workspace can't block the whole platform.

import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import { mailboxes } from '@/lib/db/schema/mailing';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { runOnce } from '@/lib/services/autopilot';
import { drainQueue } from '@/lib/services/outreach-queue';
import { purgeOldTrashUnattended, safeSyncOne } from '@/lib/services/mail';
import { processDueCrawlPlans } from '@/lib/services/crawl-engine';
import { processDueFollowUps } from '@/lib/services/follow-up';
import { compactWorkspaceKnowledgeUnattended } from '@/lib/services/knowledge-compaction';
import { synthesizeWorkspaceLearningUnattended } from '@/lib/services/learning-synthesis';
import {
  LEARNING_SWEEP_JOB,
  LEARNING_SWEEP_TICK_MS,
  runLearningSweep,
} from '@/lib/services/learning-processor';
import { processDueHealthChecks } from '@/lib/services/health-check';
import { adoptUntrackedFailingMailboxes } from '@/lib/services/mailbox';
import { getJobQueue, type JobHandler } from './index';

export const AUTOPILOT_TICK_MS = 5 * 60 * 1000;
export const DRAIN_TICK_MS = 30 * 1000;
export const IMAP_TICK_MS = 2 * 60 * 1000;
export const FOLLOW_UP_TICK_MS = 60 * 60 * 1000;
/** P60-05: knowledge compaction is heavy (AI per cluster). Weekly is enough
 *  — lessons accumulate slowly and the platform can absorb a few days of
 *  duplicates before the dilution matters. */
export const KNOWLEDGE_COMPACT_TICK_MS = 7 * 24 * 60 * 60 * 1000;
/** P61-09: daily mail trash purge. The actual retention window is
 *  per-workspace (workspaces.trash_retention_days, default 30); this is
 *  just how often we check. */
export const MAIL_TRASH_PURGE_TICK_MS = 24 * 60 * 60 * 1000;
/** P62-02: Crawl Engine cadence. 5 min is the finest granularity any
 *  plan can ever fire at (validated by MIN_INTERVAL_MINUTES). Plans
 *  with longer intervals just get checked-and-skipped until due. */
export const CRAWL_ENGINE_TICK_MS = 5 * 60 * 1000;
/** AI workspace health check: per-workspace interval (default 7 days)
 *  lives on the workspace row; this is just how often we look for due
 *  ones. The service claims each due workspace atomically. */
export const HEALTH_CHECK_TICK_MS = 6 * 60 * 60 * 1000;

function ownerCtx(workspaceId: bigint, ownerUserId: string): WorkspaceContext {
  return makeWorkspaceContext({
    workspaceId,
    userId: ownerUserId,
    role: 'owner',
  });
}

const handleAutopilotTick: JobHandler = async () => {
  const wss = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
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
    }
  }
  return { workspaces: wss.length, stepsRun: ran, failed };
};

const handleDrainTick: JobHandler = async () => {
  const wss = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
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
    }
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
 * Exported for tests (deterministic, unlike enqueue-and-wait).
 */
export async function runImapTick(now: Date = new Date()): Promise<{
  mailboxesSynced: number;
  failed: number;
  skipped: number;
  markedFailing: number;
  rechecked: number;
  recovered: number;
  adopted: number;
}> {
  const wss = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));

  let adopted = 0;
  for (const ws of wss) {
    try {
      adopted += await adoptUntrackedFailingMailboxes(ownerCtx(ws.id, ws.ownerUserId));
    } catch (err) {
      console.error(
        `[imap.tick] workspace=${ws.id} adopting failing mailboxes failed:`,
        err instanceof Error ? err.message : err,
      );
    }
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
        continue;
      }
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
  };
}

const handleImapTick: JobHandler = () => runImapTick();

const handleFollowUpTick: JobHandler = async () => {
  // Phase 58: every active workspace with follow-ups enabled. The
  // service-level loadSettings() is the source of truth — we just
  // iterate the workspace list and let processDueFollowUps no-op
  // for any that have follow-ups disabled.
  const wss = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let checked = 0;
  for (const ws of wss) {
    const ctx = ownerCtx(ws.id, ws.ownerUserId);
    try {
      const result = await processDueFollowUps(ctx);
      checked += result.checked;
      sent += result.sent;
      skipped += result.skipped;
      failed += result.failed;
    } catch (err) {
      console.error(
        `[follow_up.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { checked, sent, skipped, failed };
};

const handleCrawlEngineTick: JobHandler = async () => {
  const wss = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
  const now = new Date();
  let processed = 0;
  let inQuiet = 0;
  let totalStarted = 0;
  let totalFailed = 0;
  for (const ws of wss) {
    const ctx = ownerCtx(ws.id, ws.ownerUserId);
    try {
      const result = await processDueCrawlPlans(ctx, now);
      processed += result.processed;
      inQuiet += result.inQuietHours;
      totalStarted += result.totalStartedRuns;
      totalFailed += result.totalFailedRecipes;
    } catch (err) {
      console.error(
        `[crawl.engine.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return {
    workspaces: wss.length,
    processed,
    inQuietHours: inQuiet,
    totalStartedRuns: totalStarted,
    totalFailedRecipes: totalFailed,
  };
};

const handleMailTrashPurgeTick: JobHandler = async () => {
  const wss = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
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
    }
  }
  return { workspaces: wss.length, deleted: totalDeleted, failed };
};

const handleKnowledgeCompactTick: JobHandler = async () => {
  const wss = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
  let processed = 0;
  let merged = 0;
  let retired = 0;
  let synthesized = 0;
  let failed = 0;
  for (const ws of wss) {
    try {
      const summary = await compactWorkspaceKnowledgeUnattended(ws.id);
      processed += 1;
      merged += summary.mergedClusters;
      retired += summary.retiredMergedCount + summary.retiredStaleCount;
    } catch (err) {
      failed++;
      console.error(
        `[knowledge.compact.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
    // Self-learning synthesis rides the same weekly cadence, AFTER
    // compaction so it mines a deduplicated rule base. Its own failure
    // must not count against compaction (and vice versa).
    try {
      const s = await synthesizeWorkspaceLearningUnattended(ws.id);
      synthesized += s.lessonsCreated;
    } catch (err) {
      console.error(
        `[knowledge.compact.tick] synthesis workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { workspaces: wss.length, processed, merged, retired, synthesized, failed };
};

const handleHealthCheckTick: JobHandler = async () => {
  return processDueHealthChecks();
};

/** KL-03: per-workspace errors are caught inside runLearningSweep. */
const handleLearningSweepTick: JobHandler = () => runLearningSweep();

let registered = false;

/**
 * Register the tick handlers + their cron schedules. Idempotent — call once
 * at boot. Tests pass `skipSchedule: true` to register the handlers without
 * starting timers.
 */
export async function registerRepeatableJobs(
  options: { skipSchedule?: boolean } = {},
): Promise<void> {
  if (registered) return;
  const q = getJobQueue();
  q.on('autopilot.tick', handleAutopilotTick);
  q.on('outreach.drain.tick', handleDrainTick);
  q.on('mail.imap.tick', handleImapTick);
  q.on('outreach.follow_up.tick', handleFollowUpTick);
  q.on('knowledge.compact.tick', handleKnowledgeCompactTick);
  q.on('mail.trash.purge.tick', handleMailTrashPurgeTick);
  q.on('crawl.engine.tick', handleCrawlEngineTick);
  q.on('health.check.tick', handleHealthCheckTick);
  q.on(LEARNING_SWEEP_JOB, handleLearningSweepTick);
  if (!options.skipSchedule) {
    await q.enqueueRepeatable('autopilot.tick', {}, {
      everyMs: AUTOPILOT_TICK_MS,
      jobId: 'autopilot-tick',
    });
    await q.enqueueRepeatable('outreach.drain.tick', {}, {
      everyMs: DRAIN_TICK_MS,
      jobId: 'outreach-drain-tick',
    });
    await q.enqueueRepeatable('mail.imap.tick', {}, {
      everyMs: IMAP_TICK_MS,
      jobId: 'mail-imap-tick',
    });
    await q.enqueueRepeatable('outreach.follow_up.tick', {}, {
      everyMs: FOLLOW_UP_TICK_MS,
      jobId: 'outreach-follow-up-tick',
    });
    await q.enqueueRepeatable('knowledge.compact.tick', {}, {
      everyMs: KNOWLEDGE_COMPACT_TICK_MS,
      jobId: 'knowledge-compact-tick',
    });
    await q.enqueueRepeatable('mail.trash.purge.tick', {}, {
      everyMs: MAIL_TRASH_PURGE_TICK_MS,
      jobId: 'mail-trash-purge-tick',
    });
    await q.enqueueRepeatable('crawl.engine.tick', {}, {
      everyMs: CRAWL_ENGINE_TICK_MS,
      jobId: 'crawl-engine-tick',
    });
    await q.enqueueRepeatable('health.check.tick', {}, {
      everyMs: HEALTH_CHECK_TICK_MS,
      jobId: 'health-check-tick',
    });
    await q.enqueueRepeatable(LEARNING_SWEEP_JOB, {}, {
      everyMs: LEARNING_SWEEP_TICK_MS,
      jobId: 'learning-sweep',
    });
  }
  registered = true;
}

/** For tests — clear the flag so registration can re-run after queue reset. */
export function _resetRepeatablesForTests(): void {
  registered = false;
}
