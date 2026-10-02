// PC-35 (I066): retention for the platform's log tables.
//
// Nothing deleted from autopilot_log, the routine audit rows, notifications
// or ops_events, so they grew without bound. One daily tick
// (`ops.retention.tick`, src/lib/jobs/repeatables.ts) runs every policy
// below and has its own heartbeat like any other tick.
//
//   policy                       deletes                                   window   measured on
//   autopilot_log                every row                                 30 d     created_at
//   audit_log.mail_sync_inbound  audit rows of kind 'mail.sync_inbound'    30 d     created_at
//   notifications.read           notifications that have been read         90 d     created_at
//   ops_events.resolved          resolved incidents                        90 d     resolved_at
//   ops_alert_deliveries         owner-alert delivery log (PC-08)          90 d     created_at
//   ops_alert_state              owner-alert keys not alerted since        90 d     last_alerted_at
//   job_heartbeats.retired       heartbeat rows of jobs no longer in the   90 d     updated_at
//                                tick catalogue (retired / renamed ticks,
//                                on-demand jobs that stopped running)
//   work_leases.expired          PC-12: leases a dead holder left and no    7 d     expires_at
//                                acquire took over since (a deleted
//                                mailbox's or recipe's, mostly)
//
// Never deleted here: any other audit kind, unread notifications, open
// incidents, the heartbeat of a catalogued tick, usage_log (it backs token
// debits), mail and every tenant record.
//
// Platform housekeeping, not tenant automation: it sends, spends and starts
// nothing, so neither a workspace pause, a hold nor the platform outbound
// stop gates it. Like the other background writers (ops-events.ts,
// job-heartbeats.ts) it is system-level: no user acts, so it takes no
// WorkspaceContext / PlatformContext. A run that deleted anything records
// one platform audit row, `ops.retention.run`, with the counts and cutoffs.
//
// Deletion is batched: at most RETENTION_BATCH_SIZE rows per statement and
// RETENTION_MAX_BATCHES statements per policy per run, so the first run on
// a table that grew for months neither holds long locks nor runs for
// minutes. What is left goes the next day (the summary says `capped`).
// Each policy runs on its own: one failing does not stop the others, and
// the run reports it (runRetentionTick then throws, which fails the tick's
// heartbeat and raises its `tick.failed` incident).

import { and, eq, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import type { PlatformAuditKind } from '@/lib/audit-scope';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { autopilotLog } from '@/lib/db/schema/autopilot';
import { notifications } from '@/lib/db/schema/notifications';
import { jobHeartbeats, opsAlertDeliveries, opsAlertState, opsEvents } from '@/lib/db/schema/ops';
import { workLeases } from '@/lib/db/schema/work-leases';
import { TICK_CATALOG } from '@/lib/jobs/tick-catalog';
import { describeError } from '@/lib/ops/mask';
import { recordPlatformAuditEvent } from './audit';
import { OPS_EVENTS_RETENTION_DAYS } from './ops-events';

export const AUTOPILOT_LOG_RETENTION_DAYS = 30;
/** Audit rows of the routine inbox sync (`mail.sync_inbound`). */
export const SYNC_AUDIT_RETENTION_DAYS = 30;
export const SYNC_AUDIT_KIND = 'mail.sync_inbound';
/** Read notifications, by their age (created_at). Unread ones stay. */
export const READ_NOTIFICATION_RETENTION_DAYS = 90;
/** The owner-alert log and keys follow the incidents they are about. */
export const OPS_ALERT_RETENTION_DAYS = OPS_EVENTS_RETENTION_DAYS;
/** Heartbeat rows of jobs that are no longer catalogued ticks. */
export const RETIRED_HEARTBEAT_RETENTION_DAYS = 90;
/** PC-12: work leases expired this long ago (a holder that died and whose
 *  key nobody acquired since). A live key is overwritten long before. */
export const EXPIRED_LEASE_RETENTION_DAYS = 7;

export const RETENTION_BATCH_SIZE = 5_000;
export const RETENTION_MAX_BATCHES = 200;

/** The audit row a retention run that deleted anything records (a
 *  platform kind, registered in src/lib/audit-scope.ts). */
export const RETENTION_AUDIT_KIND = 'ops.retention.run' satisfies PlatformAuditKind;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  /** Stable name: the key in the run summary and the audit payload. */
  readonly name: string;
  readonly retentionDays: number;
  /** Delete at most `limit` rows past `cutoff`; returns how many it deleted. */
  deleteBatch(cutoff: Date, limit: number): Promise<number>;
}

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  {
    name: 'autopilot_log',
    retentionDays: AUTOPILOT_LOG_RETENTION_DAYS,
    async deleteBatch(cutoff, limit) {
      const due = db
        .select({ id: autopilotLog.id })
        .from(autopilotLog)
        .where(lt(autopilotLog.createdAt, cutoff))
        .limit(limit);
      const rows = await db
        .delete(autopilotLog)
        .where(inArray(autopilotLog.id, due))
        .returning({ id: autopilotLog.id });
      return rows.length;
    },
  },
  {
    name: 'audit_log.mail_sync_inbound',
    retentionDays: SYNC_AUDIT_RETENTION_DAYS,
    async deleteBatch(cutoff, limit) {
      const due = db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.kind, SYNC_AUDIT_KIND), lt(auditLog.createdAt, cutoff)))
        .limit(limit);
      const rows = await db
        .delete(auditLog)
        .where(and(inArray(auditLog.id, due), eq(auditLog.kind, SYNC_AUDIT_KIND)))
        .returning({ id: auditLog.id });
      return rows.length;
    },
  },
  {
    name: 'notifications.read',
    retentionDays: READ_NOTIFICATION_RETENTION_DAYS,
    async deleteBatch(cutoff, limit) {
      const due = db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(isNotNull(notifications.readAt), lt(notifications.createdAt, cutoff)))
        .limit(limit);
      // Re-checked on the delete itself: a row read and then marked
      // unread again between the two statements stays.
      const rows = await db
        .delete(notifications)
        .where(and(inArray(notifications.id, due), isNotNull(notifications.readAt)))
        .returning({ id: notifications.id });
      return rows.length;
    },
  },
  {
    name: 'ops_events.resolved',
    retentionDays: OPS_EVENTS_RETENTION_DAYS,
    async deleteBatch(cutoff, limit) {
      const due = db
        .select({ id: opsEvents.id })
        .from(opsEvents)
        .where(and(isNotNull(opsEvents.resolvedAt), lt(opsEvents.resolvedAt, cutoff)))
        .limit(limit);
      const rows = await db
        .delete(opsEvents)
        .where(and(inArray(opsEvents.id, due), isNotNull(opsEvents.resolvedAt)))
        .returning({ id: opsEvents.id });
      return rows.length;
    },
  },
  {
    name: 'ops_alert_deliveries',
    retentionDays: OPS_ALERT_RETENTION_DAYS,
    async deleteBatch(cutoff, limit) {
      const due = db
        .select({ id: opsAlertDeliveries.id })
        .from(opsAlertDeliveries)
        .where(lt(opsAlertDeliveries.createdAt, cutoff))
        .limit(limit);
      const rows = await db
        .delete(opsAlertDeliveries)
        .where(inArray(opsAlertDeliveries.id, due))
        .returning({ id: opsAlertDeliveries.id });
      return rows.length;
    },
  },
  {
    name: 'ops_alert_state',
    retentionDays: OPS_ALERT_RETENTION_DAYS,
    async deleteBatch(cutoff, limit) {
      const due = db
        .select({ key: opsAlertState.alertKey })
        .from(opsAlertState)
        .where(lt(opsAlertState.lastAlertedAt, cutoff))
        .limit(limit);
      // Re-checked on the delete: a key re-claimed in between stays.
      const rows = await db
        .delete(opsAlertState)
        .where(and(inArray(opsAlertState.alertKey, due), lt(opsAlertState.lastAlertedAt, cutoff)))
        .returning({ key: opsAlertState.alertKey });
      return rows.length;
    },
  },
  {
    name: 'job_heartbeats.retired',
    retentionDays: RETIRED_HEARTBEAT_RETENTION_DAYS,
    async deleteBatch(cutoff, limit) {
      const catalogued = TICK_CATALOG.map((t) => t.name);
      const due = db
        .select({ name: jobHeartbeats.name })
        .from(jobHeartbeats)
        .where(and(lt(jobHeartbeats.updatedAt, cutoff), notInArray(jobHeartbeats.name, catalogued)))
        .limit(limit);
      // Re-checked on the delete: a job that ran again in between stays.
      const rows = await db
        .delete(jobHeartbeats)
        .where(and(inArray(jobHeartbeats.name, due), lt(jobHeartbeats.updatedAt, cutoff)))
        .returning({ name: jobHeartbeats.name });
      return rows.length;
    },
  },
  {
    name: 'work_leases.expired',
    retentionDays: EXPIRED_LEASE_RETENTION_DAYS,
    async deleteBatch(cutoff, limit) {
      // Raw SQL: the key is three columns and drizzle has no tuple IN; the
      // ctid sub-select bounds the batch like the other policies. The
      // cutoff goes in as ISO text (no Date inside a raw template), and the
      // delete re-checks it: a lease re-acquired in between stays.
      const at = cutoff.toISOString();
      const rows = (await db.execute(sql`
        DELETE FROM ${workLeases}
        WHERE ctid IN (
          SELECT ctid FROM ${workLeases}
          WHERE ${workLeases.expiresAt} < ${at}::timestamptz
          LIMIT ${limit}
        )
        AND ${workLeases.expiresAt} < ${at}::timestamptz
        RETURNING ${workLeases.kind}
      `)) as unknown as Array<{ kind: string }>;
      return rows.length;
    },
  },
];

export interface RetentionPolicyResult {
  retentionDays: number;
  /** Rows strictly older than this were due (ISO). */
  cutoff: string;
  deleted: number;
  batches: number;
  /** Stopped at the batch cap with rows possibly left: they go next run. */
  capped: boolean;
  /** Masked error when the policy failed; rows it deleted before still count. */
  error: string | null;
}

export interface RetentionRunSummary {
  ranAt: string;
  /** Rows deleted across every policy. */
  deleted: number;
  policies: Record<string, RetentionPolicyResult>;
  /** Names of the policies that failed, plus 'audit' when the run's own
   *  audit row could not be written. */
  failed: string[];
}

export interface RetentionOptions {
  now?: Date;
  /** Test seam; defaults to RETENTION_POLICIES. */
  policies?: readonly RetentionPolicy[];
  batchSize?: number;
  maxBatches?: number;
}

export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

async function applyPolicy(
  policy: RetentionPolicy,
  now: Date,
  batchSize: number,
  maxBatches: number,
): Promise<RetentionPolicyResult> {
  const cutoff = retentionCutoff(now, policy.retentionDays);
  let deleted = 0;
  let batches = 0;
  let capped = false;
  let error: string | null = null;
  try {
    for (;;) {
      if (batches >= maxBatches) {
        capped = true;
        break;
      }
      const n = await policy.deleteBatch(cutoff, batchSize);
      batches++;
      deleted += n;
      if (n < batchSize) break;
    }
  } catch (err) {
    error = describeError(err).message;
  }
  return {
    retentionDays: policy.retentionDays,
    cutoff: cutoff.toISOString(),
    deleted,
    batches,
    capped,
    error,
  };
}

/**
 * Apply every retention policy once. Never throws for a policy's failure:
 * it is reported in `failed` (and the policy's `error`) while the other
 * policies still run.
 */
export async function runRetention(options: RetentionOptions = {}): Promise<RetentionRunSummary> {
  const now = options.now ?? new Date();
  const policies = options.policies ?? RETENTION_POLICIES;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? RETENTION_BATCH_SIZE));
  const maxBatches = Math.max(1, Math.floor(options.maxBatches ?? RETENTION_MAX_BATCHES));

  const results: Record<string, RetentionPolicyResult> = {};
  const failed: string[] = [];
  let deleted = 0;
  for (const policy of policies) {
    const result = await applyPolicy(policy, now, batchSize, maxBatches);
    results[policy.name] = result;
    deleted += result.deleted;
    if (result.error !== null) {
      failed.push(policy.name);
      console.error(`[ops.retention] ${policy.name} failed: ${result.error}`);
    }
  }

  if (deleted > 0) {
    try {
      // A literal kind: admin-console-static.test.ts checks that every
      // platform-scope kind is registered in PLATFORM_AUDIT_KINDS.
      await recordPlatformAuditEvent(null, {
        kind: 'ops.retention.run',
        payload: {
          deleted,
          policies: Object.fromEntries(
            Object.entries(results).map(([name, r]) => [
              name,
              { deleted: r.deleted, cutoff: r.cutoff, capped: r.capped, failed: r.error !== null },
            ]),
          ),
        },
      });
    } catch (err) {
      failed.push('audit');
      console.error(
        `[ops.retention] audit row not recorded: ${describeError(err).message}`,
      );
    }
  }

  return { ranAt: now.toISOString(), deleted, policies: results, failed };
}

export class RetentionRunError extends Error {
  public readonly summary: RetentionRunSummary;
  constructor(summary: RetentionRunSummary) {
    const details = summary.failed
      .map((name) => {
        const err = summary.policies[name]?.error;
        return err ? `${name} (${err})` : name;
      })
      .join('; ');
    super(`Retention failed for ${details}`);
    this.name = 'RetentionRunError';
    this.summary = summary;
  }
}

/**
 * The `ops.retention.tick` body: every policy, then a throw if any failed
 * (after the others ran), so the tick's heartbeat turns failed and its
 * `tick.failed` incident opens; the next clean run resolves it.
 */
export async function runRetentionTick(
  options: RetentionOptions = {},
): Promise<RetentionRunSummary> {
  const summary = await runRetention(options);
  if (summary.failed.length > 0) throw new RetentionRunError(summary);
  return summary;
}
