// PC-07 (I021/I022): the ops incident stream.
//
// raiseOpsEvent() records that something operational went wrong — a
// tenant's step inside a background tick, a whole tick, the BullMQ worker.
// Events are FINGERPRINTED (scope + workspace + kind + dedupe key) and
// DEDUPLICATED: while an event with the same fingerprint is open, a repeat
// only bumps `occurrences` and `last_seen_at`. resolveOpsEvent() closes it;
// the ticks call it automatically on the subject's next success. Messages
// and payloads are MASKED before they are stored (src/lib/ops/mask.ts).
//
// These writers are system-level (no WorkspaceContext / PlatformContext):
// they run inside background jobs where no user acts, like
// recordPlatformAuditEvent(null, …). The console views that list,
// acknowledge and manually resolve incidents take a PlatformContext and
// land with their pages (PC-31 platform, PC-22 tenant 360, PC-32 tenant).

import { createHash } from 'node:crypto';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { opsEvents } from '@/lib/db/schema/ops';
import { describeError, maskPayload, maskSensitive } from '@/lib/ops/mask';

/** Resolved ops_events are kept this long; the retention tick (PC-35)
 *  deletes resolved rows older than this. Open rows are never deleted. */
export const OPS_EVENTS_RETENTION_DAYS = 90;

export const OPS_EVENT_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export type OpsEventSeverity = (typeof OPS_EVENT_SEVERITIES)[number];

export const OPS_EVENT_SCOPES = ['platform', 'workspace'] as const;
export type OpsEventScope = (typeof OPS_EVENT_SCOPES)[number];

export class OpsEventError extends Error {
  public readonly code: 'invalid_input';
  constructor(message: string) {
    super(message);
    this.name = 'OpsEventError';
    this.code = 'invalid_input';
  }
}

const RaiseInputSchema = z
  .object({
    scope: z.enum(OPS_EVENT_SCOPES),
    workspaceId: z.bigint().positive().nullable().optional(),
    kind: z.string().trim().min(1).max(100),
    severity: z.enum(OPS_EVENT_SEVERITIES),
    source: z.string().trim().min(1).max(100),
    dedupeKey: z.string().trim().min(1).max(300),
    title: z.string().trim().min(1).max(300),
    /** Free-text detail; masked. Defaults to the error's masked message. */
    message: z.string().optional(),
    /** Whatever was thrown; its name and masked message are recorded. */
    error: z.unknown().optional(),
    /** Extra structured context; every string in it is masked. */
    payload: z.record(z.unknown()).optional(),
    /** How many occurrences this call stands for (throttled reporters
     *  fold suppressed repeats in). */
    occurrences: z.number().int().min(1).max(1_000_000).optional(),
  })
  .superRefine((v, issue) => {
    if (v.scope === 'workspace' && v.workspaceId == null) {
      issue.addIssue({ code: 'custom', message: 'workspace-scope events need a workspaceId' });
    }
    if (v.scope === 'platform' && v.workspaceId != null) {
      issue.addIssue({ code: 'custom', message: 'platform-scope events carry no workspaceId' });
    }
  });

export type RaiseOpsEventInput = z.input<typeof RaiseInputSchema>;

export interface RaisedOpsEvent {
  id: bigint;
  fingerprint: string;
  occurrences: number;
  /** True when this call opened a new incident (not a repeat). */
  opened: boolean;
}

/** The identity of an incident. Stable across occurrences; independent of
 *  the error text, so the next success can resolve it. */
export function opsEventFingerprint(input: {
  scope: OpsEventScope;
  workspaceId?: bigint | null;
  kind: string;
  dedupeKey: string;
}): string {
  return createHash('sha256')
    .update(
      [input.scope, input.workspaceId?.toString() ?? '-', input.kind, input.dedupeKey].join(
        '\u001f',
      ),
    )
    .digest('hex')
    .slice(0, 40);
}

/**
 * Open an incident, or count one more occurrence of the open incident with
 * the same fingerprint. Atomic under concurrency (INSERT … ON CONFLICT on
 * the partial unique index over open fingerprints).
 */
export async function raiseOpsEvent(
  input: RaiseOpsEventInput,
  now: Date = new Date(),
): Promise<RaisedOpsEvent> {
  const parsed = RaiseInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new OpsEventError(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const v = parsed.data;
  const workspaceId = v.scope === 'workspace' ? (v.workspaceId ?? null) : null;
  const fingerprint = opsEventFingerprint({
    scope: v.scope,
    workspaceId,
    kind: v.kind,
    dedupeKey: v.dedupeKey,
  });
  const err = v.error !== undefined ? describeError(v.error) : null;
  const message = v.message !== undefined ? maskSensitive(v.message) : (err?.message ?? null);
  const payload = maskPayload({
    ...(v.payload ?? {}),
    ...(err ? { errorName: err.name } : {}),
  }) as Record<string, unknown>;
  const title = maskSensitive(v.title, 300);
  const occurrences = v.occurrences ?? 1;

  const [row] = await db
    .insert(opsEvents)
    .values({
      scope: v.scope,
      workspaceId,
      kind: v.kind,
      severity: v.severity,
      source: v.source,
      dedupeKey: v.dedupeKey,
      fingerprint,
      title,
      message,
      payload,
      occurrences,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: opsEvents.fingerprint,
      targetWhere: sql`resolved_at IS NULL`,
      set: {
        occurrences: sql`${opsEvents.occurrences} + ${occurrences}`,
        lastSeenAt: now,
        severity: v.severity,
        title,
        message,
        payload,
      },
    })
    .returning({
      id: opsEvents.id,
      occurrences: opsEvents.occurrences,
      // xmax is 0 only on a freshly inserted row version.
      inserted: sql<boolean>`(xmax = 0)`,
    });
  if (!row) throw new Error('ops_events upsert returned no row');
  return { id: row.id, fingerprint, occurrences: row.occurrences, opened: Boolean(row.inserted) };
}

/**
 * Close the open incident with this fingerprint. Returns false when none
 * was open. `resolution: 'auto'` (the default) is the success path inside
 * the ticks; the console's manual resolve passes 'manual' + the user.
 */
export async function resolveOpsEvent(
  fingerprint: string,
  options: { resolution?: 'auto' | 'manual'; resolvedBy?: string | null; now?: Date } = {},
): Promise<boolean> {
  const rows = await db
    .update(opsEvents)
    .set({
      resolvedAt: options.now ?? new Date(),
      resolution: options.resolution ?? 'auto',
      resolvedBy: options.resolvedBy ?? null,
    })
    .where(and(eq(opsEvents.fingerprint, fingerprint), isNull(opsEvents.resolvedAt)))
    .returning({ id: opsEvents.id });
  return rows.length > 0;
}

/** Fingerprints of the incidents a source (job name) currently has open —
 *  read once per tick so a success only issues a resolve when needed. */
export async function listOpenOpsEventFingerprints(source: string): Promise<Set<string>> {
  const rows = await db
    .select({ fingerprint: opsEvents.fingerprint })
    .from(opsEvents)
    .where(and(eq(opsEvents.source, source), isNull(opsEvents.resolvedAt)));
  return new Set(rows.map((r) => r.fingerprint));
}

/** Fingerprints of the open incidents of one kind (PC-08: the watchdog
 *  resolves the `tick.stale` incidents of ticks that run again). */
export async function listOpenOpsEventFingerprintsByKind(kind: string): Promise<Set<string>> {
  const rows = await db
    .select({ fingerprint: opsEvents.fingerprint })
    .from(opsEvents)
    .where(and(eq(opsEvents.kind, kind), isNull(opsEvents.resolvedAt)));
  return new Set(rows.map((r) => r.fingerprint));
}

/** Open incidents per severity, platform-wide (readiness detail). */
export async function countOpenOpsEventsBySeverity(): Promise<Record<OpsEventSeverity, number>> {
  const rows = await db
    .select({ severity: opsEvents.severity, n: count() })
    .from(opsEvents)
    .where(isNull(opsEvents.resolvedAt))
    .groupBy(opsEvents.severity);
  const out: Record<OpsEventSeverity, number> = { info: 0, warning: 0, error: 0, critical: 0 };
  for (const r of rows) {
    if ((OPS_EVENT_SEVERITIES as readonly string[]).includes(r.severity)) {
      out[r.severity as OpsEventSeverity] = Number(r.n);
    }
  }
  return out;
}
