// PC-11: an autopilot step that errors becomes an ops incident instead of a
// row in autopilot_log nobody reads.
//
// runOnce tallies the errors of each step (failed items, failed CRM pushes,
// a step that threw) and reports each step that had any, ONCE per run, as
// one incident input. The input is keyed per workspace, step and UTC day
// (`dedupeKey`), so with the ops incident stream's fingerprint dedupe
// (PC-07 raiseOpsEvent: scope + workspace + kind + dedupe key; a repeat
// while open only counts occurrences) a step that keeps failing opens ONE
// incident per day, whose `occurrences` count its errors.
//
// The input has exactly the shape of PC-07's RaiseOpsEventInput: the
// default sink (OPS_EVENT_INCIDENT_SINK) is raiseOpsEvent, so the incident
// lands in ops_events (and, at error severity, the owner's alerts, PC-08).
// LOG_ONCE_INCIDENT_SINK (one console line per key and day) remains for
// callers and tests that want no database write. Recording an incident
// never breaks the run that reports it.

import type { AutopilotStepKey } from './automation-policy';
import { raiseOpsEvent } from './ops-events';

/** ops_events.kind of an autopilot step incident. */
export const AUTOPILOT_STEP_FAILED = 'autopilot.step_failed';

/** ops_events.source: the tick that runs autopilot. */
export const AUTOPILOT_INCIDENT_SOURCE = 'autopilot.tick';

/** Operator-facing step names for the incident title. */
const STEP_TITLES: Readonly<Record<AutopilotStepKey, string>> = {
  auto_approve_projects: 'Auto-approve',
  auto_enqueue_outreach: 'Generate + queue',
  auto_crm_contact_sync: 'CRM contact sync',
  auto_crm_deal_on_qualified: 'CRM deals',
};

/** One step's errors in one run. */
export interface AutopilotStepErrors {
  /** Failed items (or 1 for a step that threw). */
  count: number;
  /** The first error message of the run (masked by the ops stream). */
  first: string;
}

/** What a sink receives — structurally PC-07's RaiseOpsEventInput. */
export interface AutopilotIncidentInput {
  scope: 'workspace';
  workspaceId: bigint;
  kind: typeof AUTOPILOT_STEP_FAILED;
  severity: 'error';
  source: typeof AUTOPILOT_INCIDENT_SOURCE;
  dedupeKey: string;
  title: string;
  message: string;
  payload: Record<string, unknown>;
  occurrences: number;
}

export type AutopilotIncidentSink = (input: AutopilotIncidentInput) => Promise<unknown>;

/** The incident day: the UTC calendar date of the run. */
export function autopilotIncidentDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** One key per step per UTC day. */
export function autopilotIncidentDedupeKey(step: AutopilotStepKey, day: string): string {
  return `autopilot:${step}:${day}`;
}

export function autopilotStepIncident(input: {
  workspaceId: bigint;
  step: AutopilotStepKey;
  runId: string;
  at: Date;
  errors: AutopilotStepErrors;
}): AutopilotIncidentInput {
  const day = autopilotIncidentDay(input.at);
  const n = input.errors.count;
  return {
    scope: 'workspace',
    workspaceId: input.workspaceId,
    kind: AUTOPILOT_STEP_FAILED,
    severity: 'error',
    source: AUTOPILOT_INCIDENT_SOURCE,
    dedupeKey: autopilotIncidentDedupeKey(input.step, day),
    title: `Autopilot step "${STEP_TITLES[input.step]}" failed for this workspace`,
    message:
      `${n} error${n === 1 ? '' : 's'} in run ${input.runId}. First: ${input.errors.first}`.slice(
        0,
        2000,
      ),
    payload: { step: input.step, runId: input.runId, day, errors: n },
    occurrences: Math.max(1, n),
  };
}

/** PC-07: the ops incident stream — the default sink. */
export const OPS_EVENT_INCIDENT_SINK: AutopilotIncidentSink = (input) => raiseOpsEvent(input);

/** One log line per incident key, workspace and process (keys of earlier
 *  days are dropped); no database write. */
const logged = { day: '', keys: new Set<string>() };

export const LOG_ONCE_INCIDENT_SINK: AutopilotIncidentSink = async (input) => {
  const day = String(input.payload.day ?? '');
  if (day !== logged.day) {
    logged.day = day;
    logged.keys.clear();
  }
  const key = `${input.workspaceId}:${input.dedupeKey}`;
  if (logged.keys.has(key)) return;
  logged.keys.add(key);
  console.error(`[autopilot] workspace=${input.workspaceId} ${input.title}: ${input.message}`);
};

/** Report a run's step errors: one sink call per step that had any. Never
 *  throws. */
export async function reportAutopilotStepErrors(
  sink: AutopilotIncidentSink,
  input: {
    workspaceId: bigint;
    runId: string;
    at: Date;
    errors: ReadonlyMap<AutopilotStepKey, AutopilotStepErrors>;
  },
): Promise<number> {
  let reported = 0;
  for (const [step, errors] of input.errors) {
    if (errors.count <= 0) continue;
    try {
      await sink(
        autopilotStepIncident({
          workspaceId: input.workspaceId,
          step,
          runId: input.runId,
          at: input.at,
          errors,
        }),
      );
      reported++;
    } catch (err) {
      console.error(
        `[autopilot] workspace=${input.workspaceId} step=${step}: incident not recorded:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return reported;
}
