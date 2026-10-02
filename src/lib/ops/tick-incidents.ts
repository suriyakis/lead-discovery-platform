// PC-07 (I021/I022): per-workspace failures inside a background tick become
// ops_events instead of a console.error line nobody reads.
//
// A tick handler gets a TickIncidents from the instrumented() wrapper and
// reports each subject it processed: failed(subject, err) opens (or
// counts) the subject's incident, succeeded(subject) resolves it. The
// subject is a workspace plus an optional part ('synthesis',
// 'mailbox:12', …) so independent steps of one workspace are separate
// incidents. Both calls are best-effort and never throw: recording an
// incident must not break the tick that is recording it.

import {
  listOpenOpsEventFingerprints,
  opsEventFingerprint,
  raiseOpsEvent,
  resolveOpsEvent,
} from '@/lib/services/ops-events';

export const TICK_WORKSPACE_FAILED = 'tick.workspace_failed';

export interface TickSubject {
  workspaceId: bigint;
  /** Independent step inside the workspace, e.g. 'synthesis', 'mailbox:12'. */
  part?: string;
  /** Human name of the step when it differs from the tick's label. */
  label?: string;
}

export interface TickIncidents {
  /** The subject failed this run: open or count its incident. Never throws. */
  failed(subject: TickSubject, err: unknown): Promise<void>;
  /** The subject succeeded this run: resolve its open incident. Never throws. */
  succeeded(subject: TickSubject): Promise<void>;
  /** Subjects reported failed in this run. */
  readonly failedCount: number;
}

/** For direct calls outside the instrumented wrapper (tests, scripts). */
export const NOOP_TICK_INCIDENTS: TickIncidents = Object.freeze({
  async failed() {},
  async succeeded() {},
  failedCount: 0,
});

export interface TickIncidentReporter {
  raise: typeof raiseOpsEvent;
  resolve: typeof resolveOpsEvent;
}

export const DEFAULT_TICK_INCIDENT_REPORTER: TickIncidentReporter = {
  raise: raiseOpsEvent,
  resolve: resolveOpsEvent,
};

export function tickSubjectDedupeKey(source: string, subject: TickSubject): string {
  return `${source}:ws=${subject.workspaceId}${subject.part ? `:${subject.part}` : ''}`;
}

export function tickSubjectFingerprint(source: string, subject: TickSubject): string {
  return opsEventFingerprint({
    scope: 'workspace',
    workspaceId: subject.workspaceId,
    kind: TICK_WORKSPACE_FAILED,
    dedupeKey: tickSubjectDedupeKey(source, subject),
  });
}

/** Open incident fingerprints of a source, or null when they could not be
 *  read (then every success issues a resolve — correct, just chattier). */
export async function loadOpenTickFingerprints(
  source: string,
  list: typeof listOpenOpsEventFingerprints = listOpenOpsEventFingerprints,
): Promise<Set<string> | null> {
  try {
    return await list(source);
  } catch (err) {
    console.error(
      `[ops] ${source}: open incidents could not be read:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export function createTickIncidents(input: {
  /** The tick (job) name; the events' `source`. */
  source: string;
  /** Human name of the tick, e.g. 'Autopilot'. */
  label: string;
  /** Fingerprints open at the start of the run (null = unknown). */
  open: Set<string> | null;
  reporter?: TickIncidentReporter;
}): TickIncidents {
  const reporter = input.reporter ?? DEFAULT_TICK_INCIDENT_REPORTER;
  const open = input.open;
  let failedCount = 0;

  return {
    get failedCount() {
      return failedCount;
    },
    async failed(subject, err) {
      failedCount++;
      const what = subject.label ?? input.label;
      try {
        const raised = await reporter.raise({
          scope: 'workspace',
          workspaceId: subject.workspaceId,
          kind: TICK_WORKSPACE_FAILED,
          severity: 'error',
          source: input.source,
          dedupeKey: tickSubjectDedupeKey(input.source, subject),
          title: `${what} failed for this workspace`,
          error: err,
          payload: { tick: input.source, part: subject.part ?? null },
        });
        open?.add(raised.fingerprint);
      } catch (recordErr) {
        console.error(
          `[ops] ${input.source}: incident for workspace=${subject.workspaceId} not recorded:`,
          recordErr instanceof Error ? recordErr.message : recordErr,
        );
      }
    },
    async succeeded(subject) {
      const fingerprint = tickSubjectFingerprint(input.source, subject);
      if (open && !open.has(fingerprint)) return;
      try {
        await reporter.resolve(fingerprint, { resolution: 'auto' });
        open?.delete(fingerprint);
      } catch (recordErr) {
        console.error(
          `[ops] ${input.source}: incident for workspace=${subject.workspaceId} not resolved:`,
          recordErr instanceof Error ? recordErr.message : recordErr,
        );
      }
    },
  };
}
