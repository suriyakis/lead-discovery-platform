// PC-07: the catalogue of repeatable ticks — names, cadences and labels
// only, no handlers. repeatables.ts registers a handler for each entry;
// readiness (/api/ready) and the ops views read this list to know which
// heartbeats must stay fresh, without importing every service the
// handlers call.
//
// A tick removed from this list stops counting for readiness even if its
// old job_heartbeats row is still there.

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

export type TickName =
  | 'autopilot.tick'
  | 'outreach.drain.tick'
  | 'mail.imap.tick'
  | 'outreach.follow_up.tick'
  | 'knowledge.compact.tick'
  | 'mail.trash.purge.tick'
  | 'crawl.engine.tick'
  | 'health.check.tick';

export interface TickDefinition {
  readonly name: TickName;
  readonly everyMs: number;
  /** Stable schedule id handed to IJobQueue.enqueueRepeatable. */
  readonly jobId: string;
  /** Human name used in incident titles ("Autopilot failed for …"). */
  readonly label: string;
}

export const TICK_CATALOG: readonly TickDefinition[] = [
  {
    name: 'autopilot.tick',
    everyMs: AUTOPILOT_TICK_MS,
    jobId: 'autopilot-tick',
    label: 'Autopilot',
  },
  {
    name: 'outreach.drain.tick',
    everyMs: DRAIN_TICK_MS,
    jobId: 'outreach-drain-tick',
    label: 'Send queue',
  },
  { name: 'mail.imap.tick', everyMs: IMAP_TICK_MS, jobId: 'mail-imap-tick', label: 'Inbox sync' },
  {
    name: 'outreach.follow_up.tick',
    everyMs: FOLLOW_UP_TICK_MS,
    jobId: 'outreach-follow-up-tick',
    label: 'Follow-ups',
  },
  {
    name: 'knowledge.compact.tick',
    everyMs: KNOWLEDGE_COMPACT_TICK_MS,
    jobId: 'knowledge-compact-tick',
    label: 'Knowledge compaction',
  },
  {
    name: 'mail.trash.purge.tick',
    everyMs: MAIL_TRASH_PURGE_TICK_MS,
    jobId: 'mail-trash-purge-tick',
    label: 'Mail trash purge',
  },
  {
    name: 'crawl.engine.tick',
    everyMs: CRAWL_ENGINE_TICK_MS,
    jobId: 'crawl-engine-tick',
    label: 'Scheduled discovery',
  },
  {
    name: 'health.check.tick',
    everyMs: HEALTH_CHECK_TICK_MS,
    jobId: 'health-check-tick',
    label: 'Workspace health check',
  },
];

export function getTickDefinition(name: string): TickDefinition | undefined {
  return TICK_CATALOG.find((t) => t.name === name);
}
