// PC-38 (I028, I184): "Re-classify all" as a background job.
//
// The button used to await reclassifyWorkspace inside its request: every
// source record of the workspace, sequentially, against every active
// product — records × products AI calls with the browser waiting, no
// progress, no permission check (a viewer could start it), no wallet gate
// (the debits could take the wallet arbitrarily negative), and nothing to
// stop a second click from starting it all again.
//
// Now:
//
//   requestReclassification(ctx)   the button. Workspace admins only;
//       refuses on an empty wallet (assertTokens) and under a Background
//       AI hold before anything is written or any AI is called. Then,
//       single-flight on the action's work lease ('action' /
//       'qualification.reclassify_all'): when a run is already queued or
//       running it says so (ActionGuardError 'already_running'), else —
//       within the action's rate limit — it writes a qualification_runs
//       row ('queued', the records that exist now, the active products)
//       and enqueues one qualification.reclassify job on the runs lane. It
//       returns at once.
//
//   runReclassificationJob(payload)   the job. Holds the same lease for
//       the whole run (renewed at every record; a dead worker frees it
//       after RECLASSIFY_LEASE_TTL_MS), so a click while it works gets
//       "already running" from the lease alone. It claims the run
//       ('queued' → 'running', conditional), then works through the
//       records in id order, RECLASSIFY_BATCH_SIZE at a time, up to the
//       newest record at request time:
//         - before each batch it asks the automation gate (a Background
//           AI hold placed mid-run stops it: 'stopped' / 'held');
//         - before each record it renews the lease (lost → 'stopped' /
//           'lease_lost') and checks the wallet (empty → 'stopped' /
//           'no_tokens': in-flight overshoot is one record's AI calls);
//         - a record that throws is counted (failed_records) and skipped;
//         - after each batch it saves its progress (processed, written
//           qualifications, the cursor, the heartbeat).
//       It ends 'succeeded' (or 'stopped' with the reason), audited as
//       qualification.reclassify_workspace like the old synchronous pass.
//
//   A run is never thrown away half done (review of PC-38: a deploy used to
//   cut it off, and the next click started again from record 0, paying
//   for the records already classified):
//     - a worker that is stopping (SIGTERM, jobs/shutdown.ts) ends the run
//       between two records: its progress is saved, it goes back to
//       'queued' and a new job is enqueued for it, which the next worker
//       resumes after last_record_id;
//     - a job that takes the action's lease and finds its run 'running'
//       takes it over (no other job can be working it), and resumes it;
//     - when someone asks again and the existing run is 'running' while
//       its lease is free (its worker died), or 'queued' for more than
//       RECLASSIFY_QUEUE_GRACE_MS since its last sign of life with no live
//       job in the queue (the job was lost), the click resumes THAT run
//       (back to 'queued', a new job) instead of starting a new one.
//
// Re-classification refreshes the AI's verdicts only (upsertQualification
// never touches the operator's columns, KL-02). Flagging approved leads
// whose verdict dropped is flow:F-15's.

import { and, asc, count, desc, eq, gt, inArray, lte, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { usageLog } from '@/lib/db/schema/audit';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { productProfiles } from '@/lib/db/schema/products';
import {
  ACTIVE_QUALIFICATION_RUN_STATUSES,
  qualificationRuns,
  type QualificationRun,
  type QualificationRunStopReason,
} from '@/lib/db/schema/qualification-runs';
import { getJobQueue, NonRetryableJobError } from '@/lib/jobs';
import { jobShutdownRequested } from '@/lib/jobs/shutdown';
import { formatUtc } from '@/lib/format-utc';
import { describeError } from '@/lib/ops/mask';
import {
  ActionGuardError,
  GUARDED_ACTIONS,
  alreadyRunning,
  singleFlight,
  withRateLimit,
} from './action-guards';
import { recordAuditEvent } from './audit';
import { assertGate, checkGate } from './automation-gate';
import {
  WORKSPACE_ROLES,
  canAdminWorkspace,
  makeWorkspaceContext,
  type WorkspaceContext,
} from './context';
import { QualificationServiceError, classifySourceRecord } from './qualification';
import { assertTokens, getTokenWallet, hasTokens } from './token-ledger';
import { usageDebitTokens } from './usage';
import { acquireWorkLease, liveWorkLease, type WorkLease } from './work-leases';

export const RECLASSIFY_JOB = 'qualification.reclassify';
export const RECLASSIFY_ACTION = 'qualification.reclassify_all' as const;
/** Records per batch: progress is saved and the gate asked between batches. */
export const RECLASSIFY_BATCH_SIZE = 50;
/** The job's lease lasts this long without a renewal (it renews at every
 *  record), so a worker that died frees the button within it. */
export const RECLASSIFY_LEASE_TTL_MS = 15 * 60_000;
/** A queued run that showed a sign of life (requested, resumed, requeued)
 *  more recently than this is never judged lost (its job may be being
 *  enqueued right now). */
export const RECLASSIFY_QUEUE_GRACE_MS = 2 * 60_000;
/** The job waits this long, in steps, for a click that holds the lease
 *  for a moment (it is checking whether a run is active). */
const LEASE_WAIT_STEPS = 20;
const LEASE_WAIT_STEP_MS = 250;
/** Usage rows the token estimate averages over. */
export const ESTIMATE_SAMPLE_SIZE = 100;

export class QualificationRunError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'QualificationRunError';
    this.code = code;
  }
}

export const ReclassifyJobPayloadSchema = z.object({
  runId: z.string().regex(/^\d{1,19}$/),
  workspaceId: z.string().regex(/^\d{1,19}$/),
  userId: z.string().min(1).max(200),
  role: z.enum(WORKSPACE_ROLES),
});
export type ReclassifyJobPayload = z.infer<typeof ReclassifyJobPayloadSchema>;

function leaseSpec() {
  return {
    kind: 'action' as const,
    resource: RECLASSIFY_ACTION,
    purpose: `action:${RECLASSIFY_ACTION}`,
  };
}

// ---- scope and estimate --------------------------------------------------

export interface ReclassifyScope {
  records: number;
  /** The newest source record now (null: there are none). */
  upToRecordId: bigint | null;
  products: number;
}

/** What a run requested now would cover. */
export async function reclassifyScope(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<ReclassifyScope> {
  const [rec] = await db
    .select({ n: count(), maxId: max(sourceRecords.id) })
    .from(sourceRecords)
    .where(eq(sourceRecords.workspaceId, ctx.workspaceId));
  const [prod] = await db
    .select({ n: count() })
    .from(productProfiles)
    .where(and(eq(productProfiles.workspaceId, ctx.workspaceId), eq(productProfiles.active, true)));
  return {
    records: Number(rec?.n ?? 0),
    upToRecordId: rec?.maxId ?? null,
    products: Number(prod?.n ?? 0),
  };
}

export interface ReclassifyEstimate extends ReclassifyScope {
  /** records × products: the most AI classifications the run makes. */
  classifications: number;
  /** The wallet is never debited (billing-exempt workspace). */
  billingExempt: boolean;
  /** Recent ai.qualification usage rows the average comes from. */
  sampleSize: number;
  /** Average wallet tokens per classification over the sample; null
   *  without history. */
  tokensPerClassification: number | null;
  /** classifications × that average, rounded; null without history.
   *  An estimate: rows on the workspace's own key or the mock provider
   *  count 0, like their debits. */
  estimatedTokens: number | null;
}

/** The confirmation's numbers: how many classifications and, from this
 *  workspace's recent qualification usage, about how many tokens. */
export async function estimateReclassification(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<ReclassifyEstimate> {
  const scope = await reclassifyScope(ctx);
  const classifications = scope.records * scope.products;
  const wallet = await getTokenWallet(ctx);
  const sample = await db
    .select({
      provider: usageLog.provider,
      payload: usageLog.payload,
      costEstimateCents: usageLog.costEstimateCents,
    })
    .from(usageLog)
    .where(and(eq(usageLog.workspaceId, ctx.workspaceId), eq(usageLog.kind, 'ai.qualification')))
    .orderBy(desc(usageLog.createdAt), desc(usageLog.id))
    .limit(ESTIMATE_SAMPLE_SIZE);
  const perCall =
    sample.length === 0
      ? null
      : sample.reduce((sum, row) => sum + usageDebitTokens(row), 0) / sample.length;
  return {
    ...scope,
    classifications,
    billingExempt: wallet.billingExempt,
    sampleSize: sample.length,
    tokensPerClassification: perCall,
    estimatedTokens: perCall === null ? null : Math.round(perCall * classifications),
  };
}

// ---- reads ---------------------------------------------------------------

/** The workspace's newest run, or null. */
export async function latestQualificationRun(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<QualificationRun | null> {
  const [row] = await db
    .select()
    .from(qualificationRuns)
    .where(eq(qualificationRuns.workspaceId, ctx.workspaceId))
    .orderBy(desc(qualificationRuns.id))
    .limit(1);
  return row ?? null;
}

async function activeRun(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<QualificationRun | null> {
  const [row] = await db
    .select()
    .from(qualificationRuns)
    .where(
      and(
        eq(qualificationRuns.workspaceId, ctx.workspaceId),
        inArray(qualificationRuns.status, [...ACTIVE_QUALIFICATION_RUN_STATUSES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** "450 of 1,200 records", for messages and the progress panel. */
export function describeRunProgress(
  run: Pick<QualificationRun, 'processedRecords' | 'totalRecords'>,
): string {
  return `${run.processedRecords.toLocaleString('en-US')} of ${run.totalRecords.toLocaleString('en-US')} records`;
}

/**
 * The run that is queued or running is abandoned when nothing will ever
 * finish it. Asked only while the caller holds the action's lease — so a
 * 'running' run's own job cannot be alive (it would hold the lease).
 */
async function isAbandoned(run: QualificationRun): Promise<boolean> {
  if (run.status === 'running') return true;
  // 'queued': lost only when its last sign of life (the request, or the
  // resume / requeue that put it back) is old enough and its job is not in
  // the queue.
  const since = (run.heartbeatAt ?? run.createdAt).getTime();
  if (Date.now() - since < RECLASSIFY_QUEUE_GRACE_MS) return false;
  const queue = getJobQueue();
  if (!queue.hasLiveJob) return false;
  try {
    return !(await queue.hasLiveJob(RECLASSIFY_JOB, { field: 'runId', value: run.id.toString() }));
  } catch (err) {
    // The queue cannot tell (Redis down): assume it is still waiting.
    console.error(
      '[reclassify] could not ask the queue about run',
      run.id.toString(),
      describeError(err).message,
    );
    return false;
  }
}

/**
 * Take an abandoned run over: back to 'queued' with its progress kept, so
 * the job enqueued for it continues after last_record_id. Under the
 * action's lease (no job can claim it meanwhile).
 */
async function resumeAbandoned(
  ctx: WorkspaceContext,
  run: QualificationRun,
): Promise<QualificationRun> {
  const [row] = await db
    .update(qualificationRuns)
    .set({ status: 'queued', heartbeatAt: sql`now()`, error: null })
    .where(and(eq(qualificationRuns.id, run.id), eq(qualificationRuns.status, run.status)))
    .returning();
  if (!row) throw alreadyRunning(RECLASSIFY_ACTION, null);
  await recordAuditEvent(ctx, {
    kind: 'qualification.reclassify_requested',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: {
      runId: row.id.toString(),
      resumed: true,
      abandonedAs: run.status,
      processedRecords: run.processedRecords,
      fromRecordId: run.lastRecordId?.toString() ?? null,
      records: run.totalRecords,
      products: run.productCount,
      upToRecordId: run.upToRecordId.toString(),
    },
  });
  return row;
}

function alreadyRunningMessage(run: QualificationRun): string {
  const state =
    run.status === 'queued'
      ? `queued since ${formatUtc(run.createdAt)}, waiting for a worker`
      : `running since ${formatUtc(run.startedAt ?? run.createdAt)}, ${describeRunProgress(run)} done`;
  return `${GUARDED_ACTIONS[RECLASSIFY_ACTION].label} is already running in this workspace (${state}). This click started nothing; progress shows on the Crawl Engine page.`;
}

// ---- request -------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  const code =
    (err as { code?: unknown; cause?: { code?: unknown } } | null)?.code ??
    (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === '23505';
}

/**
 * The "Re-classify all" button: start a background run (or resume the
 * workspace's abandoned one), or say why not. Returns the queued run — a
 * resumed one has processedRecords > 0. Throws QualificationRunError
 * (permission_denied, invalid_input, queue_unavailable), TokenError (empty
 * wallet), AutomationGateError (a hold) or ActionGuardError (already
 * running, rate limited) — all before any AI call.
 */
export async function requestReclassification(ctx: WorkspaceContext): Promise<QualificationRun> {
  if (!canAdminWorkspace(ctx)) {
    throw new QualificationRunError(
      'Only workspace admins can re-classify every record.',
      'permission_denied',
    );
  }
  // PC-38: the wallet first — an empty one refuses before any work.
  await assertTokens(ctx);
  // PC-06: a Background AI hold (or the platform) refuses it too.
  await assertGate(ctx, 'background_ai', { spendsTokens: true });

  const run = await singleFlight(ctx, RECLASSIFY_ACTION, async () => {
    // (The lease is free here: no job is working a run of this workspace.)
    const active = await activeRun(ctx);
    if (active && !(await isAbandoned(active))) {
      throw alreadyRunning(RECLASSIFY_ACTION, null, alreadyRunningMessage(active));
    }
    return withRateLimit(ctx, RECLASSIFY_ACTION, async () => {
      // Its worker died or its job was lost: carry on where it stopped.
      if (active) return resumeAbandoned(ctx, active);
      const scope = await reclassifyScope(ctx);
      if (scope.products === 0) {
        throw new QualificationRunError(
          'There is no active product profile to classify against. Activate one first.',
          'invalid_input',
        );
      }
      if (scope.records === 0 || scope.upToRecordId === null) {
        throw new QualificationRunError(
          'There are no discovered records to re-classify yet.',
          'invalid_input',
        );
      }
      let inserted: QualificationRun | undefined;
      try {
        [inserted] = await db
          .insert(qualificationRuns)
          .values({
            workspaceId: ctx.workspaceId,
            status: 'queued',
            requestedBy: ctx.userId,
            upToRecordId: scope.upToRecordId,
            totalRecords: scope.records,
            productCount: scope.products,
          })
          .returning();
      } catch (err) {
        // The one-active-run index: another run got in first.
        if (isUniqueViolation(err)) {
          const other = await activeRun(ctx);
          throw alreadyRunning(
            RECLASSIFY_ACTION,
            null,
            other ? alreadyRunningMessage(other) : undefined,
          );
        }
        throw err;
      }
      if (!inserted) throw new Error('qualification_runs insert returned no row');
      await recordAuditEvent(ctx, {
        kind: 'qualification.reclassify_requested',
        entityType: 'workspace',
        entityId: ctx.workspaceId,
        payload: {
          runId: inserted.id.toString(),
          records: scope.records,
          products: scope.products,
          upToRecordId: scope.upToRecordId.toString(),
        },
      });
      return inserted;
    });
  }).catch(async (err: unknown) => {
    // The lease is held — by the job working the active run (or another
    // click checking for one): say what that run is doing.
    if (err instanceof ActionGuardError && err.code === 'already_running' && err.held) {
      const active = await activeRun(ctx);
      if (active) throw alreadyRunning(RECLASSIFY_ACTION, err.held, alreadyRunningMessage(active));
    }
    throw err;
  });

  // Enqueued after the lease is released: the job takes the same lease, and
  // an in-process queue may start it at once.
  const payload: ReclassifyJobPayload = {
    runId: run.id.toString(),
    workspaceId: ctx.workspaceId.toString(),
    userId: ctx.userId,
    role: ctx.role,
  };
  try {
    const jobId = await getJobQueue().enqueue(RECLASSIFY_JOB, payload, {
      tag: `reclassify:${ctx.workspaceId}`,
    });
    const [withJob] = await db
      .update(qualificationRuns)
      .set({ jobId })
      .where(eq(qualificationRuns.id, run.id))
      .returning();
    return withJob ?? run;
  } catch (err) {
    console.error(
      '[reclassify] could not enqueue run',
      run.id.toString(),
      describeError(err).message,
    );
    // A resumed run keeps its progress: it stays queued, and the next
    // click (past the grace period) resumes it again.
    if (run.processedRecords === 0) {
      await db
        .update(qualificationRuns)
        .set({
          status: 'failed',
          error:
            'The background queue was unavailable, so nothing was classified. Try again in a few minutes.',
          finishedAt: sql`now()`,
        })
        .where(and(eq(qualificationRuns.id, run.id), eq(qualificationRuns.status, 'queued')));
    }
    throw new QualificationRunError(
      'The background queue is unavailable right now, so nothing was started. Try again in a few minutes.',
      'queue_unavailable',
    );
  }
}

// ---- the job -------------------------------------------------------------

export interface ReclassifyJobOutcome {
  /** requeued: the worker is stopping; the run went back to 'queued' with
   *  its progress and a new job resumes it. */
  status: 'skipped' | 'succeeded' | 'stopped' | 'requeued';
  /** skipped: why; stopped: the stop reason; requeued: 'shutdown'. */
  reason?: string;
  runId: string;
  processedRecords?: number;
  qualificationCount?: number;
  failedRecords?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function acquireRunLease(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<WorkLease | null> {
  for (let step = 0; step < LEASE_WAIT_STEPS; step++) {
    const got = await acquireWorkLease(ctx, {
      ...leaseSpec(),
      ttlMs: RECLASSIFY_LEASE_TTL_MS,
      autoRenew: false,
      maxHoldMs: Number.POSITIVE_INFINITY,
    });
    if (got.acquired) return got.lease;
    await sleep(LEASE_WAIT_STEP_MS);
  }
  return null;
}

/**
 * The qualification.reclassify job (registered in jobs/bootstrap.ts, runs
 * lane). The payload is untrusted queue data: validated, and the run must
 * belong to the payload's workspace.
 */
export async function runReclassificationJob(payload: unknown): Promise<ReclassifyJobOutcome> {
  const p = ReclassifyJobPayloadSchema.parse(payload);
  const ctx = makeWorkspaceContext({
    workspaceId: BigInt(p.workspaceId),
    userId: p.userId,
    role: p.role,
  });
  const runId = BigInt(p.runId);
  const [row] = await db
    .select({ workspaceId: qualificationRuns.workspaceId })
    .from(qualificationRuns)
    .where(eq(qualificationRuns.id, runId))
    .limit(1);
  if (!row) throw new NonRetryableJobError(`qualification_runs ${runId} missing at run time`);
  if (row.workspaceId !== ctx.workspaceId) {
    throw new NonRetryableJobError(`qualification_runs ${runId} workspaceId mismatch`);
  }

  // A worker that is stopping starts no run (BullMQ stops fetching jobs on
  // close; one fetched just before stays queued for the next click).
  if (jobShutdownRequested()) {
    return { status: 'skipped', reason: 'shutting_down', runId: p.runId };
  }
  const lease = await acquireRunLease(ctx);
  if (!lease) {
    // Someone holds the action's lease for longer than a click takes:
    // another job working this workspace, or a dead worker's lease that
    // has not expired yet. The run stays as it is; the next request finds
    // it abandoned and resumes it.
    return { status: 'skipped', reason: 'lease_held', runId: p.runId };
  }
  let outcome: ReclassifyJobOutcome;
  try {
    // Holding the action's lease, no other job works a run of this
    // workspace: a 'running' run is one whose worker died (a re-delivered
    // job after a crash) and is taken over where it stopped.
    const [claimed] = await db
      .update(qualificationRuns)
      .set({
        status: 'running',
        startedAt: sql`COALESCE(${qualificationRuns.startedAt}, now())`,
        heartbeatAt: sql`now()`,
      })
      .where(
        and(
          eq(qualificationRuns.id, runId),
          inArray(qualificationRuns.status, [...ACTIVE_QUALIFICATION_RUN_STATUSES]),
        ),
      )
      .returning();
    if (!claimed) return { status: 'skipped', reason: 'not_active', runId: p.runId };
    outcome = await workRun(ctx, claimed, lease);
  } finally {
    try {
      await lease.release();
    } catch (err) {
      console.error(
        '[reclassify] lease release failed (it expires on its own):',
        describeError(err).message,
      );
    }
  }
  // After the release: the next worker's job takes the same lease.
  if (outcome.status === 'requeued') await requeueRun(p);
  return outcome;
}

/** Enqueue a new job for a run the stopping worker handed back. If the
 *  queue cannot take it, the run stays queued with its progress and the
 *  next click resumes it. */
async function requeueRun(p: ReclassifyJobPayload): Promise<void> {
  try {
    const jobId = await getJobQueue().enqueue(RECLASSIFY_JOB, p, {
      tag: `reclassify:${p.workspaceId}`,
    });
    await db
      .update(qualificationRuns)
      .set({ jobId })
      .where(and(eq(qualificationRuns.id, BigInt(p.runId)), eq(qualificationRuns.status, 'queued')));
  } catch (err) {
    console.error(
      `[reclassify] run ${p.runId} could not be requeued; the next Re-classify all resumes it:`,
      describeError(err).message,
    );
  }
}

interface Progress {
  processedRecords: number;
  qualificationCount: number;
  failedRecords: number;
  lastRecordId: bigint | null;
}

/** Save progress while the run is still this job's ('running'). False:
 *  someone settled it meanwhile. */
async function saveProgress(runId: bigint, progress: Progress): Promise<boolean> {
  const rows = await db
    .update(qualificationRuns)
    .set({ ...progress, heartbeatAt: sql`now()` })
    .where(and(eq(qualificationRuns.id, runId), eq(qualificationRuns.status, 'running')))
    .returning({ id: qualificationRuns.id });
  return rows.length > 0;
}

async function workRun(
  ctx: WorkspaceContext,
  run: QualificationRun,
  lease: WorkLease,
): Promise<ReclassifyJobOutcome> {
  const progress: Progress = {
    processedRecords: run.processedRecords,
    qualificationCount: run.qualificationCount,
    failedRecords: run.failedRecords,
    lastRecordId: run.lastRecordId,
  };
  let stop: QualificationRunStopReason | null = null;
  /** The worker is stopping: hand the rest of the run to the next one. */
  let handBack = false;

  try {
    batches: for (;;) {
      // PC-06: a Background AI hold placed mid-run stops it here.
      const gate = await checkGate(ctx, 'background_ai', { manual: true });
      if (!gate.allowed) {
        stop = 'held';
        break;
      }
      const batch = await db
        .select({ id: sourceRecords.id })
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.workspaceId, ctx.workspaceId),
            gt(sourceRecords.id, progress.lastRecordId ?? 0n),
            lte(sourceRecords.id, run.upToRecordId),
          ),
        )
        .orderBy(asc(sourceRecords.id))
        .limit(RECLASSIFY_BATCH_SIZE);
      if (batch.length === 0) break;

      for (const record of batch) {
        if (jobShutdownRequested()) {
          handBack = true;
          break batches;
        }
        if (!(await lease.checkpoint())) {
          stop = 'lease_lost';
          break batches;
        }
        if (!(await hasTokens(ctx))) {
          stop = 'no_tokens';
          break batches;
        }
        try {
          const written = await classifySourceRecord(ctx, record.id);
          progress.qualificationCount += written.length;
        } catch (err) {
          // Deleted since the batch was read: nothing to classify.
          if (!(err instanceof QualificationServiceError && err.code === 'not_found')) {
            progress.failedRecords += 1;
            console.error(
              `[reclassify] run ${run.id} record ${record.id} failed:`,
              describeError(err).message,
            );
          }
        }
        progress.processedRecords += 1;
        progress.lastRecordId = record.id;
      }
      if (!(await saveProgress(run.id, progress))) {
        stop = 'lease_lost';
        break;
      }
    }
  } catch (err) {
    await db
      .update(qualificationRuns)
      .set({
        ...progress,
        status: 'failed',
        error: `Stopped on an unexpected error after ${describeRunProgress({ ...progress, totalRecords: run.totalRecords })}. Try again; if it happens again, contact support.`,
        heartbeatAt: sql`now()`,
        finishedAt: sql`now()`,
      })
      .where(and(eq(qualificationRuns.id, run.id), eq(qualificationRuns.status, 'running')));
    throw err;
  }

  if (handBack) {
    // Progress saved, back to 'queued' (still this workspace's one active
    // run); runReclassificationJob enqueues the job that resumes it after
    // last_record_id once the lease is released.
    await db
      .update(qualificationRuns)
      .set({ ...progress, status: 'queued', heartbeatAt: sql`now()` })
      .where(and(eq(qualificationRuns.id, run.id), eq(qualificationRuns.status, 'running')));
    console.log(
      `[reclassify] run ${run.id} handed back at ${describeRunProgress({ ...progress, totalRecords: run.totalRecords })}: the worker is stopping; the next one resumes it.`,
    );
    return {
      status: 'requeued',
      reason: 'shutdown',
      runId: run.id.toString(),
      processedRecords: progress.processedRecords,
      qualificationCount: progress.qualificationCount,
      failedRecords: progress.failedRecords,
    };
  }

  const status = stop ? 'stopped' : 'succeeded';
  // 'lease_lost': the run was taken over or settled; it is not ours to end.
  if (stop !== 'lease_lost') {
    await db
      .update(qualificationRuns)
      .set({
        ...progress,
        status,
        stopReason: stop,
        heartbeatAt: sql`now()`,
        finishedAt: sql`now()`,
      })
      .where(and(eq(qualificationRuns.id, run.id), eq(qualificationRuns.status, 'running')));
    await recordAuditEvent(ctx, {
      kind: 'qualification.reclassify_workspace',
      entityType: 'workspace',
      entityId: ctx.workspaceId,
      payload: {
        runId: run.id.toString(),
        status,
        stopReason: stop,
        recordCount: progress.processedRecords,
        totalRecords: run.totalRecords,
        qualificationCount: progress.qualificationCount,
        failedRecords: progress.failedRecords,
      },
    });
  }
  return {
    status,
    ...(stop ? { reason: stop } : {}),
    runId: run.id.toString(),
    processedRecords: progress.processedRecords,
    qualificationCount: progress.qualificationCount,
    failedRecords: progress.failedRecords,
  };
}

/** Is the run's job holding the action's lease right now? (The progress
 *  panel tells a live run from one whose worker died.) */
export async function isReclassificationLive(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<boolean> {
  return (await liveWorkLease(ctx, 'action', RECLASSIFY_ACTION)) !== null;
}
