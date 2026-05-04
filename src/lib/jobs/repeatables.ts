// Phase 34: scheduled background work. Three tick handlers fan out across
// every active workspace / mailbox so the platform actually does its job
// without anyone clicking buttons.
//
//   autopilot.tick      every 5 min  → for each ws with autopilot enabled,
//                                       call autopilot.runOnce(ctx)
//   outreach.drain.tick every 30 sec → for each active workspace, drain
//                                       the send queue
//   mail.imap.tick      every 2 min  → for each active mailbox with IMAP,
//                                       call mail.syncInbound(ctx, mb.id)
//
// Each handler iterates serially and swallows per-tenant errors so one
// stuck workspace can't block the whole platform.

import { eq } from 'drizzle-orm';
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
import { getJobQueue, type JobHandler } from './index';

export const AUTOPILOT_TICK_MS = 5 * 60 * 1000;
export const DRAIN_TICK_MS = 30 * 1000;
export const IMAP_TICK_MS = 2 * 60 * 1000;

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
  // enabled, status=active mailboxes.
  const wss = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.status, 'active'));
  let synced = 0;
  let failed = 0;
  for (const ws of wss) {
    const mbs = await db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, ws.id));
    const eligible = mbs.filter((m) => m.status === 'active' && m.imapHost);
    if (eligible.length === 0) continue;
    const ctx = ownerCtx(ws.id, ws.ownerUserId);
    for (const mb of eligible) {
      try {
        await syncInbound(ctx, mb.id);
        synced++;
      } catch (err) {
        failed++;
        console.error(
          `[imap.tick] workspace=${ws.id} mailbox=${mb.id} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  return { mailboxesSynced: synced, failed };
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
  }
  registered = true;
}

/** For tests — clear the flag so registration can re-run after queue reset. */
export function _resetRepeatablesForTests(): void {
  registered = false;
}
