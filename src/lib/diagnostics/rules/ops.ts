// AP-06 rules over the ops stream (PC-07): the workspace's open incidents
// and late background ticks.

import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { opsEvents, type OpsEvent } from '@/lib/db/schema/ops';
import { getBootInfo } from '@/lib/jobs/boot';
import { OWNER_INCIDENT_KIND } from '@/lib/services/automation-gate';
import { AUTOPILOT_STEP_FAILED } from '@/lib/services/autopilot-incidents';
import { getTickStatuses } from '@/lib/services/job-heartbeats';
import { RUN_FAILED, RUN_STUCK, SEND_INTERRUPTED } from '@/lib/ops/work-incidents';
import { TICK_WORKSPACE_FAILED } from '@/lib/ops/tick-incidents';
import { plural } from '../env';
import { fixHref } from '../hrefs';
import { defineRule } from '../rule';
import { SEVERITY_RANK, type FindingDraft, type FindingSeverity } from '../types';

/**
 * Incident kinds another rule already reports from live state, so the
 * same failure is not listed (and scored) twice:
 *   automation.owner_unaccountable  automation.owner (the gate's state)
 *   run.failed                      runs.failed (failed runs in 7 days)
 */
export const OPS_KINDS_COVERED_BY_RULES: readonly string[] = [OWNER_INCIDENT_KIND, RUN_FAILED];

/** Severity of an incident kind's finding: the ops scale has four steps,
 *  findings three. An 'error' is a warning here (the work it is about
 *  waits or was settled by the reaper); 'critical' stays critical. */
export function findingSeverityOfOps(severity: string): FindingSeverity {
  if (severity === 'critical') return 'critical';
  if (severity === 'error' || severity === 'warning') return 'warning';
  return 'info';
}

const KIND_TITLES: Readonly<Record<string, (n: number) => string>> = {
  [SEND_INTERRUPTED]: (n) => `${plural(n, 'email was', 'emails were')} interrupted mid-send`,
  [RUN_STUCK]: (n) => `${plural(n, 'search', 'searches')} stopped making progress`,
  [TICK_WORKSPACE_FAILED]: (n) => `Background work failed for this workspace (${plural(n, 'job')})`,
  [AUTOPILOT_STEP_FAILED]: (n) => `Autopilot ${n === 1 ? 'step' : 'steps'} failed`,
};

/** Where the operator fixes what a tick failed at (tick.workspace_failed
 *  carries the tick as `source`). */
const TICK_HREFS: Readonly<Record<string, () => string>> = {
  'outreach.drain.tick': fixHref.sendQueue,
  'mail.imap.tick': fixHref.mailboxes,
  'outreach.follow_up.tick': fixHref.followUps,
  'autopilot.tick': fixHref.autopilot,
  'crawl.engine.tick': fixHref.schedules,
  'health.check.tick': fixHref.health,
  'knowledge.compact.tick': fixHref.lessons,
  'mail.trash.purge.tick': fixHref.mailboxes,
};

function hrefOf(kind: string, first: OpsEvent): string {
  switch (kind) {
    case SEND_INTERRUPTED:
      return fixHref.sendQueue();
    case RUN_STUCK:
      return fixHref.searches();
    case AUTOPILOT_STEP_FAILED:
      return fixHref.autopilot();
    case TICK_WORKSPACE_FAILED:
      return (TICK_HREFS[first.source] ?? fixHref.health)();
    default:
      return fixHref.health();
  }
}

/** Open incidents read per evaluation (newest first). */
const MAX_OPEN_INCIDENTS = 200;

/**
 * The workspace's OPEN incidents (PC-07 ops_events, scope 'workspace'),
 * one finding per kind: `ops.<kind>`, its count, the newest incidents'
 * titles and messages (already masked at write), and since the oldest.
 * They resolve themselves on the subject's next success, so a finding
 * here is a failure that is still true.
 */
export const opsIncidentsRule = defineRule({
  id: 'ops.incidents',
  owner: 'ops',
  summary: 'Open workspace incidents from the ops stream, one finding per kind.',
  async evaluate(env) {
    const rows = await db
      .select()
      .from(opsEvents)
      .where(
        and(
          eq(opsEvents.scope, 'workspace'),
          eq(opsEvents.workspaceId, env.ctx.workspaceId),
          isNull(opsEvents.resolvedAt),
          notInArray(opsEvents.kind, [...OPS_KINDS_COVERED_BY_RULES]),
        ),
      )
      .orderBy(desc(opsEvents.lastSeenAt))
      .limit(MAX_OPEN_INCIDENTS);
    const byKind = new Map<string, OpsEvent[]>();
    for (const r of rows) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);

    const out: FindingDraft[] = [];
    for (const [kind, events] of byKind) {
      const newest = events[0]!;
      const n = events.length;
      const severity = events
        .map((e) => findingSeverityOfOps(e.severity))
        .reduce<FindingSeverity>((a, s) => (SEVERITY_RANK[s] < SEVERITY_RANK[a] ? s : a), 'info');
      const oldest = events.reduce((a, e) => (e.firstSeenAt < a ? e.firstSeenAt : a), newest.firstSeenAt);
      const occurrences = events.reduce((a, e) => a + e.occurrences, 0);
      const lines = events
        .slice(0, 3)
        .map((e) => `${e.title}${e.message ? `: ${e.message.slice(0, 240)}` : ''}`);
      out.push({
        code: `ops.${kind}`,
        severity,
        title: KIND_TITLES[kind]?.(n) ?? (n === 1 ? newest.title : `${newest.title} (+${n - 1} more)`),
        detail:
          `${lines.join(' · ')}${n > 3 ? ` · and ${n - 3} more` : ''}. ` +
          'It closes by itself once the work succeeds again.',
        facts: { openIncidents: n, occurrences },
        href: hrefOf(kind, newest),
        since: oldest,
        source: 'ops_event',
      });
    }
    return out;
  },
});

/**
 * MOB-02 / I022: a background tick that missed its slot (outside the boot
 * grace) — automatic work may not be happening at all. Omitted, not
 * zeroed, while no heartbeat exists (a tick with no row is 'unscheduled').
 * The platform owner is alerted separately (PC-08 watchdog), so this never
 * notifies the workspace.
 */
export const jobsStaleRule = defineRule({
  id: 'jobs.stale',
  owner: 'ops',
  summary: 'Background ticks that missed their expected slot (platform-wide).',
  async evaluate(env) {
    const statuses = await getTickStatuses(env.now, {
      processBootedAt: getBootInfo().startedAt,
    });
    const stale = statuses.filter((t) => t.failsReadiness);
    if (stale.length === 0) return [];
    return [
      {
        code: 'jobs.stale',
        severity: 'warning',
        title: `Background work is late (${plural(stale.length, 'job')})`,
        detail:
          `${stale.map((t) => t.label).join(', ')} did not run when expected, so automatic work ` +
          '(sending, inbox sync, follow-ups, autopilot or scheduled searches) may not be happening. ' +
          'The platform team is alerted; nothing in this workspace needs changing.',
        facts: { staleJobs: stale.map((t) => t.name).join(',') },
        href: fixHref.support(),
        actionKinds: ['contact_support'],
      },
    ];
  },
});
