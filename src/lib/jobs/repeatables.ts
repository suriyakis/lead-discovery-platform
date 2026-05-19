// Phase 34: scheduled background work. Four tick handlers fan out across
// every active workspace / mailbox so the platform actually does its job
// without anyone clicking buttons.
//
//   autopilot.tick         every 5 min  → for each ws with autopilot
//                                          enabled, call autopilot.runOnce(ctx)
//   outreach.drain.tick    every 30 sec → for each active workspace, drain
//                                          the send queue
//   mail.imap.tick         every 2 min  → for each active mailbox with IMAP,
//                                          call mail.syncInbound(ctx, mb.id)
//   outreach.follow_up.tick every 1 h    → Phase 58: for each active
//                                          workspace with followUpEnabled,
//                                          process pending follow-ups whose
//                                          scheduled_for has passed.
//
// Each handler iterates serially and swallows per-tenant errors so one
// stuck workspace can't block the whole platform.

import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import { mailboxes } from '@/lib/db/schema/mailing';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { runOnce } from '@/lib/services/autopilot';
import { drainQueue } from '@/lib/services/outreach-queue';
import { syncInbound } from '@/lib/services/mail';
import { processDueFollowUps } from '@/lib/services/follow-up';
import { compactWorkspaceKnowledgeUnattended } from '@/lib/services/knowledge-compaction';
import {
  classifyImapError,
  computeBackoffMs,
  nextSyncAfterEmpty,
} from '@/lib/services/imap-backoff';
import { getJobQueue, type JobHandler } from './index';

export const AUTOPILOT_TICK_MS = 5 * 60 * 1000;
export const DRAIN_TICK_MS = 30 * 1000;
export const IMAP_TICK_MS = 2 * 60 * 1000;
export const FOLLOW_UP_TICK_MS = 60 * 60 * 1000;
/** P60-05: knowledge compaction is heavy (AI per cluster). Weekly is enough
 *  — lessons accumulate slowly and the platform can absorb a few days of
 *  duplicates before the dilution matters. */
export const KNOWLEDGE_COMPACT_TICK_MS = 7 * 24 * 60 * 60 * 1000;

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

const handleImapTick: JobHandler = async () => {
  // Active workspaces only. Inner loop selects each workspace's IMAP-
  // enabled, status=active mailboxes whose cooldown gate has elapsed.
  const wss = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  let markedFailing = 0;
  const now = new Date();
  for (const ws of wss) {
    const mbs = await db
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.workspaceId, ws.id),
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
    const ctx = ownerCtx(ws.id, ws.ownerUserId);
    for (const mb of eligible) {
      try {
        const result = await syncInbound(ctx, mb.id);
        // Success path — reset failure counter, adjust adaptive poll.
        const nextEmpty = result.fetched === 0 ? mb.imapEmptySyncs + 1 : 0;
        const adaptiveNext = nextSyncAfterEmpty(new Date(), nextEmpty);
        await db
          .update(mailboxes)
          .set({
            imapConsecutiveFailures: 0,
            imapNextSyncAfter: adaptiveNext,
            imapEmptySyncs: nextEmpty,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(mailboxes.id, mb.id));
        synced++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        const cls = classifyImapError(err);
        if (cls === 'auth') {
          // Permanent — stop ticking until the operator reactivates.
          await db
            .update(mailboxes)
            .set({
              status: 'failing',
              lastError: msg.slice(0, 2000),
              imapNextSyncAfter: null,
              updatedAt: new Date(),
            })
            .where(eq(mailboxes.id, mb.id));
          markedFailing++;
          console.error(
            `[imap.tick] workspace=${ws.id} mailbox=${mb.id} auth-failed: ${msg}`,
          );
        } else {
          // Transient — exponential backoff.
          const nextCount = mb.imapConsecutiveFailures + 1;
          const cooldown = computeBackoffMs(nextCount);
          await db
            .update(mailboxes)
            .set({
              imapConsecutiveFailures: nextCount,
              imapNextSyncAfter: new Date(Date.now() + cooldown),
              lastError: msg.slice(0, 2000),
              updatedAt: new Date(),
            })
            .where(eq(mailboxes.id, mb.id));
          console.error(
            `[imap.tick] workspace=${ws.id} mailbox=${mb.id} transient failure ${nextCount} (next in ${Math.round(cooldown / 60000)}m): ${msg}`,
          );
        }
      }
    }
  }
  return { mailboxesSynced: synced, failed, skipped, markedFailing };
};

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

const handleKnowledgeCompactTick: JobHandler = async () => {
  const wss = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
  let processed = 0;
  let merged = 0;
  let retired = 0;
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
  }
  return { workspaces: wss.length, processed, merged, retired, failed };
};

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
  }
  registered = true;
}

/** For tests — clear the flag so registration can re-run after queue reset. */
export function _resetRepeatablesForTests(): void {
  registered = false;
}
