// PC-10 (I013, I074): the stuck-work reaper.
//
// A restart or crash in the middle of work used to leave it in limbo for
// good: an outreach_queue row 'sending' forever (counted as queued, no
// action on the queue page, the draft blocked from re-enqueue by the
// unique index) and a connector run 'running' or 'pending' forever. The
// reaper — the ops.reaper.tick, every 5 minutes, per active workspace —
// settles both:
//
//   sends  'sending' for more than 10 minutes since the claim →
//          'sent'   when a sent / delivered mail_messages row of the same
//                   draft exists from the claim on (the email went out,
//                   only the queue row was not updated);
//          'failed' otherwise, last_failure_kind 'interrupted', last error
//                   "Interrupted: delivery unknown", plus a
//                   send.interrupted incident. Never re-sent automatically:
//                   it may have gone out.
//   runs   'running' with no progress (last_progress_at) for 15 minutes →
//          'failed' + run.stuck incident + the run.failed notification;
//          'running' with a cancel request unanswered for 2 minutes →
//          'cancelled' (the operator wanted it stopped anyway);
//          'pending' for 60 minutes → 'failed' (never started: the job was
//          lost). Pending gets longer because under BullMQ a run can wait
//          its turn behind others (worker concurrency 4); the runner only
//          starts a run that is still 'pending', so a reaped run never
//          starts late.
//
// Every write is conditional on the state the reaper read, so a runner or
// drain that wakes up meanwhile is never overwritten (and a runner that
// finds its run reaped stops). The reaper's own changes are audited as
// system events (user_id NULL).
//
// Not here yet: work leases (PC-12). Once the drain holds a lease, "stuck"
// also means "no live lease"; until then the 10-minute margin (an SMTP
// submission times out in about 2) stands in for it.

import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  connectorRecipes,
  connectorRunLogs,
  connectorRuns,
  connectors,
  type ConnectorRun,
} from '@/lib/db/schema/connectors';
import { mailMessages } from '@/lib/db/schema/mailing';
import { opsEvents } from '@/lib/db/schema/ops';
import { outreachQueue, type OutreachQueueEntry } from '@/lib/db/schema/outreach';
import { formatUtc } from '@/lib/format-utc';
import {
  RUN_FAILED,
  RUN_STUCK,
  parseRunIncidentDedupeKey,
  reportRunStuck,
  reportSendInterrupted,
} from '@/lib/ops/work-incidents';
import { recordSystemAuditEvent } from './audit';
import type { WorkspaceContext } from './context';
import { resolveOpsEvent } from './ops-events';

export const SEND_STUCK_AFTER_MS = 10 * 60 * 1000;
export const RUN_STUCK_AFTER_MS = 15 * 60 * 1000;
export const RUN_PENDING_STUCK_AFTER_MS = 60 * 60 * 1000;
export const RUN_CANCEL_GRACE_MS = 2 * 60 * 1000;

/** The last_error prefix of a reaped send (spec wording). */
export const INTERRUPTED_SEND_REASON = 'Interrupted: delivery unknown';

export interface ReapSendsResult {
  /** Rows settled as 'sent' (a sent copy was found). */
  settledSent: bigint[];
  /** Rows failed as interrupted. */
  failed: bigint[];
}

export interface ReapRunsResult {
  failed: bigint[];
  cancelled: bigint[];
}

export interface ReapResult {
  sendsSettledSent: number;
  sendsFailed: number;
  runsFailed: number;
  runsCancelled: number;
}

/** Settle one workspace's stuck sends and runs. */
export async function reapStuckWork(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  now: Date = new Date(),
): Promise<ReapResult> {
  const sends = await reapStuckSends(ctx, now);
  const runs = await reapStuckRuns(ctx, now);
  return {
    sendsSettledSent: sends.settledSent.length,
    sendsFailed: sends.failed.length,
    runsFailed: runs.failed.length,
    runsCancelled: runs.cancelled.length,
  };
}

// ---- sends -----------------------------------------------------------

/** 'sending' since before `cutoff`. A row claimed by a build without
 *  claimed_at (before PC-10) falls back to updated_at, which the claim
 *  set too. */
function sendingSince(cutoff: Date): SQL {
  return and(
    eq(outreachQueue.status, 'sending'),
    or(
      lt(outreachQueue.claimedAt, cutoff),
      and(isNull(outreachQueue.claimedAt), lt(outreachQueue.updatedAt, cutoff)),
    ),
  ) as SQL;
}

export async function reapStuckSends(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  now: Date = new Date(),
): Promise<ReapSendsResult> {
  const cutoff = new Date(now.getTime() - SEND_STUCK_AFTER_MS);
  const stuck = await db
    .select()
    .from(outreachQueue)
    .where(and(eq(outreachQueue.workspaceId, ctx.workspaceId), sendingSince(cutoff)))
    .orderBy(asc(outreachQueue.id));

  const result: ReapSendsResult = { settledSent: [], failed: [] };
  for (const row of stuck) {
    const claimedAt = row.claimedAt ?? row.updatedAt;
    const copy = row.draftId ? await findSentCopy(ctx, row.draftId, claimedAt) : null;
    if (copy) {
      if (await settleSent(ctx, row, copy.id, cutoff)) result.settledSent.push(row.id);
    } else if (await settleInterrupted(ctx, row, claimedAt, cutoff)) {
      result.failed.push(row.id);
    }
  }
  return result;
}

/** A sent / delivered outbound copy of `draftId` created from the claim on. */
async function findSentCopy(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  draftId: bigint,
  claimedAt: Date,
): Promise<{ id: bigint } | null> {
  const [copy] = await db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.direction, 'outbound'),
        eq(mailMessages.sourceDraftId, draftId),
        inArray(mailMessages.status, ['sent', 'delivered']),
        gte(mailMessages.createdAt, claimedAt),
      ),
    )
    .orderBy(asc(mailMessages.createdAt))
    .limit(1);
  return copy ?? null;
}

async function settleSent(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  row: OutreachQueueEntry,
  messageId: bigint,
  cutoff: Date,
): Promise<boolean> {
  const [done] = await db
    .update(outreachQueue)
    .set({
      status: 'sent',
      sentMessageId: messageId,
      lastFailureKind: null,
      nextAttemptAt: null,
      lastError: `Recovered by the stuck-send check: the sent copy (message ${messageId}) was found.`,
      updatedAt: new Date(),
    })
    .where(and(eq(outreachQueue.id, row.id), sendingSince(cutoff)))
    .returning({ id: outreachQueue.id });
  if (!done) return false;
  await auditBestEffort(ctx.workspaceId, {
    kind: 'outreach.queue.reaped',
    entityType: 'outreach_queue',
    entityId: row.id,
    payload: { outcome: 'sent', messageId: messageId.toString() },
  });
  return true;
}

async function settleInterrupted(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  row: OutreachQueueEntry,
  claimedAt: Date,
  cutoff: Date,
): Promise<boolean> {
  const [done] = await db
    .update(outreachQueue)
    .set({
      status: 'failed',
      lastFailureKind: 'interrupted',
      nextAttemptAt: null,
      lastError:
        `${INTERRUPTED_SEND_REASON}. Picked up for sending at ${formatUtc(claimedAt)} and never ` +
        'finished, and no sent copy was found. Check the Sent folder before you retry it.',
      updatedAt: new Date(),
    })
    .where(and(eq(outreachQueue.id, row.id), sendingSince(cutoff)))
    .returning({ id: outreachQueue.id });
  if (!done) return false;
  await auditBestEffort(ctx.workspaceId, {
    kind: 'outreach.queue.reaped',
    entityType: 'outreach_queue',
    entityId: row.id,
    payload: { outcome: 'failed', reason: 'interrupted', claimedAt: claimedAt.toISOString() },
  });
  await reportSendInterrupted({
    workspaceId: ctx.workspaceId,
    entryId: row.id,
    mailboxId: row.mailboxId,
    draftId: row.draftId,
    claimedAt,
  });
  return true;
}

// ---- runs ------------------------------------------------------------

/** No runner heartbeat since `cutoff`. Runs started before PC-10 have no
 *  last_progress_at; their progress events bumped updated_at. */
function noProgressSince(cutoff: Date): SQL {
  return or(
    lt(connectorRuns.lastProgressAt, cutoff),
    and(isNull(connectorRuns.lastProgressAt), lt(connectorRuns.updatedAt, cutoff)),
  ) as SQL;
}

type RunVerdict =
  | { kind: 'no_progress'; status: 'failed'; message: string; guard: SQL }
  | { kind: 'cancel_unanswered'; status: 'cancelled'; message: string; guard: SQL }
  | { kind: 'never_started'; status: 'failed'; message: string; guard: SQL };

export async function reapStuckRuns(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  now: Date = new Date(),
): Promise<ReapRunsResult> {
  const runningCutoff = new Date(now.getTime() - RUN_STUCK_AFTER_MS);
  const cancelCutoff = new Date(now.getTime() - RUN_CANCEL_GRACE_MS);
  const pendingCutoff = new Date(now.getTime() - RUN_PENDING_STUCK_AFTER_MS);

  const noProgress = and(
    eq(connectorRuns.status, 'running'),
    noProgressSince(runningCutoff),
  ) as SQL;
  const cancelUnanswered = and(
    eq(connectorRuns.status, 'running'),
    isNotNull(connectorRuns.cancelRequestedAt),
    lt(connectorRuns.cancelRequestedAt, cancelCutoff),
    noProgressSince(cancelCutoff),
  ) as SQL;
  const neverStarted = and(
    eq(connectorRuns.status, 'pending'),
    lt(connectorRuns.createdAt, pendingCutoff),
  ) as SQL;

  const candidates = await db
    .select()
    .from(connectorRuns)
    .where(
      and(
        eq(connectorRuns.workspaceId, ctx.workspaceId),
        or(noProgress, cancelUnanswered, neverStarted),
      ),
    )
    .orderBy(asc(connectorRuns.id));

  const result: ReapRunsResult = { failed: [], cancelled: [] };
  for (const run of candidates) {
    const verdict = judgeRun(run, {
      runningCutoff,
      cancelCutoff,
      noProgress,
      cancelUnanswered,
      neverStarted,
    });
    if (!verdict) continue;
    const [done] = await db
      .update(connectorRuns)
      .set({
        status: verdict.status,
        completedAt: now,
        errorPayload: {
          message: verdict.message,
          reason: verdict.kind,
          reapedAt: now.toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(and(eq(connectorRuns.id, run.id), verdict.guard))
      .returning({ id: connectorRuns.id });
    if (!done) continue;

    await bestEffort(`run ${run.id} log line`, () =>
      db.insert(connectorRunLogs).values({
        runId: run.id,
        level: verdict.status === 'cancelled' ? 'warn' : 'error',
        message: verdict.message,
        payload: { reaper: true, reason: verdict.kind },
      }),
    );
    await auditBestEffort(ctx.workspaceId, {
      kind: 'connector_run.reaped',
      entityType: 'connector_run',
      entityId: run.id,
      payload: { outcome: verdict.status, reason: verdict.kind },
    });

    if (verdict.status === 'cancelled') {
      result.cancelled.push(run.id);
      continue;
    }
    result.failed.push(run.id);
    const ref = {
      workspaceId: ctx.workspaceId,
      runId: run.id,
      connectorId: run.connectorId,
      recipeId: run.recipeId,
    };
    await reportRunStuck(ref, verdict.kind, verdict.message);
    await bestEffort(`run ${run.id} failure notification`, async () => {
      const { notify } = await import('./notifications');
      await notify(ctx.workspaceId, {
        kind: 'run.failed',
        title: 'Discovery run failed',
        body: verdict.message.slice(0, 300),
        href: `/connectors/${run.connectorId}/runs/${run.id}`,
        // Same key as the runner's own failure notice.
        dedupeKey: `run.failed:${run.connectorId}`,
      });
    });
  }
  return result;
}

function judgeRun(
  run: ConnectorRun,
  c: {
    runningCutoff: Date;
    cancelCutoff: Date;
    noProgress: SQL;
    cancelUnanswered: SQL;
    neverStarted: SQL;
  },
): RunVerdict | null {
  const lastBeat = run.lastProgressAt ?? run.updatedAt;
  if (run.status === 'pending') {
    return {
      kind: 'never_started',
      status: 'failed',
      message:
        'Never started: the run waited more than 60 minutes for a worker (the job was probably lost in a restart). Start it again.',
      guard: c.neverStarted,
    };
  }
  if (run.status !== 'running') return null;
  if (
    run.cancelRequestedAt &&
    run.cancelRequestedAt < c.cancelCutoff &&
    lastBeat < c.cancelCutoff
  ) {
    return {
      kind: 'cancel_unanswered',
      status: 'cancelled',
      message:
        'Cancelled: the run stopped responding after the cancel request. Records found before that are kept.',
      guard: c.cancelUnanswered,
    };
  }
  if (lastBeat < c.runningCutoff) {
    return {
      kind: 'no_progress',
      status: 'failed',
      message:
        'Stopped: no progress for 15 minutes (the worker was probably restarted, or a search hung). Records found before that are kept. Start it again.',
      guard: c.noProgress,
    };
  }
  return null;
}

// ---- run incidents nothing can resolve any more ------------------------

/**
 * Open run.failed / run.stuck incidents are resolved by the recipe's next
 * run. When the recipe was deleted or switched off, or its connector was
 * deleted or deactivated, there is no next run: they would stay open for
 * good, re-alerting the owner every 6 hours and sitting in every daily
 * digest. Those are resolved here ('auto'). Platform-wide, one pass per
 * reaper tick. Returns how many were resolved.
 */
export async function resolveOrphanedRunIncidents(): Promise<number> {
  const open = await db
    .select({ fingerprint: opsEvents.fingerprint, dedupeKey: opsEvents.dedupeKey })
    .from(opsEvents)
    .where(
      and(
        eq(opsEvents.scope, 'workspace'),
        inArray(opsEvents.kind, [RUN_FAILED, RUN_STUCK]),
        isNull(opsEvents.resolvedAt),
      ),
    );
  const refs = open.flatMap((e) => {
    const ref = parseRunIncidentDedupeKey(e.dedupeKey);
    return ref ? [{ fingerprint: e.fingerprint, ...ref }] : [];
  });
  if (refs.length === 0) return 0;

  const connectorIds = uniqueIds(refs.map((r) => r.connectorId));
  const recipeIds = uniqueIds(refs.flatMap((r) => (r.recipeId === null ? [] : [r.recipeId])));
  const liveConnectors = new Set(
    (
      await db
        .select({ id: connectors.id })
        .from(connectors)
        .where(and(inArray(connectors.id, connectorIds), eq(connectors.active, true)))
    ).map((r) => r.id.toString()),
  );
  const liveRecipes = new Set(
    recipeIds.length === 0
      ? []
      : (
          await db
            .select({ id: connectorRecipes.id })
            .from(connectorRecipes)
            .where(and(inArray(connectorRecipes.id, recipeIds), eq(connectorRecipes.active, true)))
        ).map((r) => r.id.toString()),
  );

  let resolved = 0;
  for (const ref of refs) {
    const runnable =
      liveConnectors.has(ref.connectorId.toString()) &&
      (ref.recipeId === null || liveRecipes.has(ref.recipeId.toString()));
    if (runnable) continue;
    if (await resolveOpsEvent(ref.fingerprint, { resolution: 'auto' })) resolved++;
  }
  return resolved;
}

function uniqueIds(ids: readonly bigint[]): bigint[] {
  return [...new Set(ids.map(String))].map((id) => BigInt(id));
}

// ---- helpers ---------------------------------------------------------

async function auditBestEffort(
  workspaceId: bigint,
  event: Parameters<typeof recordSystemAuditEvent>[1],
): Promise<void> {
  await bestEffort(`audit ${event.kind}`, () => recordSystemAuditEvent(workspaceId, event));
}

async function bestEffort(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[stuck-work] ${what} failed:`, err instanceof Error ? err.message : err);
  }
}
