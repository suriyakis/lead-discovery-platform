// PC-10: ops_events producers for interrupted sends and failed / stuck
// discovery runs (the incident stream of PC-07; PC-08 alerts on it).
//
//   send.interrupted  workspace · error   the reaper found a send cut off
//                     one incident per queue row; resolved when an operator
//                     retries or requeues that row
//   run.failed        workspace · warning a discovery run ended 'failed'
//                     (incl. every query failing, I074)
//   run.stuck         workspace · error   the reaper failed a run that
//                     stopped making progress or never started
//                     both run kinds: one incident per recipe (occurrences
//                     counted), resolved by the recipe's next run that
//                     succeeds or partly succeeds
//
// Every function here is best-effort and never throws: recording an
// incident must not break the send, the run or the reaper that reports it.
// Payloads carry ids only — no addresses, no queries.

import { opsEventFingerprint, raiseOpsEvent, resolveOpsEvent } from '@/lib/services/ops-events';

export const SEND_INTERRUPTED = 'send.interrupted';
export const RUN_FAILED = 'run.failed';
export const RUN_STUCK = 'run.stuck';

/** `source` of the incidents the stuck-work reaper raises (its tick). */
export const REAPER_SOURCE = 'ops.reaper.tick';
/** `source` of the incidents the connector runner raises (its job). */
export const RUNNER_SOURCE = 'connector.run';

export function sendInterruptedDedupeKey(entryId: bigint): string {
  return `outreach_queue:${entryId}`;
}

export function sendInterruptedFingerprint(workspaceId: bigint, entryId: bigint): string {
  return opsEventFingerprint({
    scope: 'workspace',
    workspaceId,
    kind: SEND_INTERRUPTED,
    dedupeKey: sendInterruptedDedupeKey(entryId),
  });
}

export function runIncidentDedupeKey(run: {
  connectorId: bigint;
  recipeId: bigint | null;
}): string {
  return `connector:${run.connectorId}:recipe:${run.recipeId ?? 'none'}`;
}

export function runIncidentFingerprint(
  kind: typeof RUN_FAILED | typeof RUN_STUCK,
  workspaceId: bigint,
  run: { connectorId: bigint; recipeId: bigint | null },
): string {
  return opsEventFingerprint({
    scope: 'workspace',
    workspaceId,
    kind,
    dedupeKey: runIncidentDedupeKey(run),
  });
}

function logNotRecorded(what: string, err: unknown): void {
  console.error(`[ops] ${what} not recorded:`, err instanceof Error ? err.message : err);
}

export async function reportSendInterrupted(input: {
  workspaceId: bigint;
  entryId: bigint;
  mailboxId: bigint;
  draftId: bigint | null;
  claimedAt: Date;
}): Promise<void> {
  try {
    await raiseOpsEvent({
      scope: 'workspace',
      workspaceId: input.workspaceId,
      kind: SEND_INTERRUPTED,
      severity: 'error',
      source: REAPER_SOURCE,
      dedupeKey: sendInterruptedDedupeKey(input.entryId),
      title: 'A queued email was interrupted mid-send; delivery unknown',
      message:
        'The send was picked up and never finished (a restart or crash), and no sent copy was found. ' +
        'The queue entry is now failed; check the Sent folder before retrying it.',
      payload: {
        queueEntryId: input.entryId.toString(),
        mailboxId: input.mailboxId.toString(),
        draftId: input.draftId?.toString() ?? null,
        claimedAt: input.claimedAt.toISOString(),
      },
    });
  } catch (err) {
    logNotRecorded(`send.interrupted incident for queue entry ${input.entryId}`, err);
  }
}

/** An operator retried / requeued the interrupted row: close its incident. */
export async function resolveSendInterrupted(
  workspaceId: bigint,
  entryId: bigint,
  resolvedBy: string | null,
): Promise<void> {
  try {
    await resolveOpsEvent(sendInterruptedFingerprint(workspaceId, entryId), {
      resolution: 'manual',
      resolvedBy,
    });
  } catch (err) {
    logNotRecorded(`send.interrupted resolution for queue entry ${entryId}`, err);
  }
}

interface RunRef {
  workspaceId: bigint;
  runId: bigint;
  connectorId: bigint;
  recipeId: bigint | null;
}

function runPayload(run: RunRef): Record<string, unknown> {
  return {
    runId: run.runId.toString(),
    connectorId: run.connectorId.toString(),
    recipeId: run.recipeId?.toString() ?? null,
  };
}

export async function reportRunFailed(run: RunRef, message: string): Promise<void> {
  try {
    await raiseOpsEvent({
      scope: 'workspace',
      workspaceId: run.workspaceId,
      kind: RUN_FAILED,
      severity: 'warning',
      source: RUNNER_SOURCE,
      dedupeKey: runIncidentDedupeKey(run),
      title: 'A discovery run failed',
      message,
      payload: runPayload(run),
    });
  } catch (err) {
    logNotRecorded(`run.failed incident for run ${run.runId}`, err);
  }
}

export async function reportRunStuck(
  run: RunRef,
  reason: 'no_progress' | 'never_started' | 'cancel_unanswered',
  message: string,
): Promise<void> {
  try {
    await raiseOpsEvent({
      scope: 'workspace',
      workspaceId: run.workspaceId,
      kind: RUN_STUCK,
      severity: 'error',
      source: REAPER_SOURCE,
      dedupeKey: runIncidentDedupeKey(run),
      title:
        reason === 'never_started'
          ? 'A discovery run never started'
          : 'A discovery run stopped making progress',
      message,
      payload: { ...runPayload(run), reason },
    });
  } catch (err) {
    logNotRecorded(`run.stuck incident for run ${run.runId}`, err);
  }
}

/** The recipe ran (fully or partly) again: close its failed / stuck incidents. */
export async function resolveRunIncidents(
  workspaceId: bigint,
  run: { connectorId: bigint; recipeId: bigint | null },
): Promise<void> {
  for (const kind of [RUN_FAILED, RUN_STUCK] as const) {
    try {
      await resolveOpsEvent(runIncidentFingerprint(kind, workspaceId, run), { resolution: 'auto' });
    } catch (err) {
      logNotRecorded(`${kind} resolution for connector ${run.connectorId}`, err);
    }
  }
}
