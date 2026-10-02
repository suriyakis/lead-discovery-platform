// PC-05: the single workspace pause — one control that stops every kind
// of automatic work in a workspace (the queue drain, follow-ups, autopilot,
// scheduled crawls, reply auto-actions, background AI, auto top-up and the
// trash purge) while inbox sync keeps reading. The automation gate
// (automation-gate.ts) enforces it at every place such work starts and
// again before every item; this module turns it on and off.
//
//   pauseAutomation   any write role, never plan- or wallet-gated (I063):
//                     stopping must always work. Idempotent: pausing a
//                     paused workspace changes nothing and writes nothing.
//   undoPause         the person who paused, within PAUSE_UNDO_WINDOW_MS
//                     (10 s, measured on the database clock) — the Undo
//                     on the "Paused" confirmation. After that only an
//                     owner or admin resumes.
//   resumeAutomation  owners and admins (and super-admins in the tenant).
//   getAutomationPauseOverview
//                     what the pause / resume dialogs show: who paused,
//                     when and why, what stops (with counts) and what
//                     restarts (queued mail, the next send time, the reply
//                     auto-actions held while paused).
//
// The pause time comes from the database clock and is written under a
// row lock on the workspace; the queue drain claims each row under a
// share lock on the same row and refuses while paused (outreach-queue.ts),
// so no row is ever claimed after the pause time.
//
// Legacy: autopilot_settings.emergency_pause and
// outreach_send_settings.emergency_pause were two unrelated switches
// (I004, I046). Migration p1_automation_control_pause moved them into this
// pause; nothing reads them any more. Until they are dropped (one release
// later) they are written as a mirror of the pause, so a rollback to the
// old code still stops what it knew how to stop.
//
// Audit (workspace scope, actor = the person): automation.paused,
// automation.pause_undone, automation.resumed — each with the source (the
// page or control) and the device. A manual send under the pause is
// audited by sendMessage as outbound.override.

import { and, count, countDistinct, desc, eq, gte, isNotNull, lte, min, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { users } from '@/lib/db/schema/auth';
import { autopilotSettings } from '@/lib/db/schema/autopilot';
import { crawlPlans } from '@/lib/db/schema/connectors';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { outreachQueue, outreachSendSettings } from '@/lib/db/schema/outreach';
import { workspaces } from '@/lib/db/schema/workspaces';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, canWrite, type WorkspaceContext } from './context';
import type { WorkspacePause } from './automation-gate';

export class AutomationPauseError extends Error {
  public readonly code:
    | 'permission_denied'
    | 'invalid_input'
    | 'not_found'
    | 'not_paused'
    | 'too_late';
  constructor(message: string, code: AutomationPauseError['code']) {
    super(message);
    this.name = 'AutomationPauseError';
    this.code = code;
  }
}

/** How long the person who paused can take it back without an admin. */
export const PAUSE_UNDO_WINDOW_MS = 10_000;
/** Same window as SQL, for the conditional undo (database clock). */
const PAUSE_UNDO_WINDOW_SQL = sql.raw(`interval '${PAUSE_UNDO_WINDOW_MS / 1000} seconds'`);

/** Where a pause / resume was pressed. `legacy_flag_migration` is written
 *  only by the migration that carried the old switches over. */
export const PAUSE_SOURCES = [
  'autopilot_page',
  'send_queue_page',
  'shell_banner',
  'today',
  'api',
  'legacy_flag_migration',
] as const;
export type PauseSource = (typeof PAUSE_SOURCES)[number];

export const PAUSE_DEVICES = ['desktop', 'mobile', 'tablet', 'unknown'] as const;
export type PauseDevice = (typeof PAUSE_DEVICES)[number];

export const PAUSE_REASON_MAX = 500;

const ControlInputSchema = z.object({
  /** Optional: the person may say why. Blank = none. */
  reason: z
    .string()
    .trim()
    .max(PAUSE_REASON_MAX, `reason is too long (${PAUSE_REASON_MAX} characters max)`)
    .optional()
    .transform((v) => (v ? v : null)),
  source: z.enum(PAUSE_SOURCES).refine((s) => s !== 'legacy_flag_migration', {
    message: 'that source is reserved for the migration',
  }),
  device: z.enum(PAUSE_DEVICES).default('unknown'),
});

export type PauseControlInput = z.input<typeof ControlInputSchema>;

function parseControlInput(input: PauseControlInput) {
  const parsed = ControlInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AutomationPauseError(
      parsed.error.issues.map((i) => i.message).join('; '),
      'invalid_input',
    );
  }
  return parsed.data;
}

const denied = (op: string) =>
  new AutomationPauseError(`Permission denied: ${op}`, 'permission_denied');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Lock the workspace row (FOR UPDATE: waits for in-flight queue claims,
 *  which hold a share lock) and read its pause columns. */
async function lockWorkspace(tx: Tx, workspaceId: bigint) {
  const [row] = await tx
    .select({
      pausedAt: workspaces.automationPausedAt,
      pausedByUserId: workspaces.automationPausedByUserId,
      reason: workspaces.automationPauseReason,
      source: workspaces.automationPauseSource,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('update');
  if (!row) throw new AutomationPauseError('workspace not found', 'not_found');
  return row;
}

/** Keep the two legacy columns in step with the pause (write-only mirror
 *  until they are dropped; see the header). Upserts so a workspace that
 *  never opened those settings still carries the mirror. */
async function mirrorLegacyFlags(tx: Tx, workspaceId: bigint, paused: boolean): Promise<void> {
  await tx
    .insert(autopilotSettings)
    .values({ workspaceId, emergencyPause: paused })
    .onConflictDoUpdate({
      target: autopilotSettings.workspaceId,
      set: { emergencyPause: paused },
    });
  await tx
    .insert(outreachSendSettings)
    .values({ workspaceId, emergencyPause: paused })
    .onConflictDoUpdate({
      target: outreachSendSettings.workspaceId,
      set: { emergencyPause: paused },
    });
}

// ---- pause ----------------------------------------------------------------

export interface PauseResult {
  pausedAt: Date;
  pausedByUserId: string | null;
  /** The workspace was already paused; nothing changed. */
  alreadyPaused: boolean;
  /** Until when this person may undo (null when it was already paused). */
  undoUntil: Date | null;
}

/**
 * Pause every kind of automatic work. Any write role; never refused for
 * the plan or the wallet. Idempotent.
 */
export async function pauseAutomation(
  ctx: WorkspaceContext,
  input: PauseControlInput,
): Promise<PauseResult> {
  if (!canWrite(ctx)) throw denied('automation.pause');
  const v = parseControlInput(input);
  const result = await db.transaction(async (tx) => {
    const current = await lockWorkspace(tx, ctx.workspaceId);
    if (current.pausedAt) {
      return {
        pausedAt: current.pausedAt,
        pausedByUserId: current.pausedByUserId,
        alreadyPaused: true,
        undoUntil: null,
      } satisfies PauseResult;
    }
    const [row] = await tx
      .update(workspaces)
      .set({
        // Database clock, taken after the lock: later than every claim
        // that committed before it (see the header).
        automationPausedAt: sql`clock_timestamp()`,
        automationPausedByUserId: ctx.userId,
        automationPauseReason: v.reason,
        automationPauseSource: v.source,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, ctx.workspaceId))
      .returning({ pausedAt: workspaces.automationPausedAt });
    const pausedAt = row?.pausedAt;
    if (!pausedAt) throw new AutomationPauseError('pause was not stored', 'not_found');
    await mirrorLegacyFlags(tx, ctx.workspaceId, true);
    await recordAuditEvent(
      ctx,
      {
        kind: 'automation.paused',
        entityType: 'workspace',
        entityId: ctx.workspaceId,
        payload: {
          source: v.source,
          device: v.device,
          reason: v.reason,
          pausedAt: pausedAt.toISOString(),
          role: ctx.role,
        },
      },
      tx,
    );
    return {
      pausedAt,
      pausedByUserId: ctx.userId,
      alreadyPaused: false,
      undoUntil: new Date(pausedAt.getTime() + PAUSE_UNDO_WINDOW_MS),
    } satisfies PauseResult;
  });

  // Only owners and admins resume: tell them when someone else paused.
  if (!result.alreadyPaused && !canAdminWorkspace(ctx)) {
    const { notifyWorkspaceAdmins } = await import('./notifications');
    await notifyWorkspaceAdmins(ctx.workspaceId, {
      kind: 'automation.paused',
      title: 'Automation was paused in your workspace',
      body: `${v.reason ? `Reason: ${v.reason}. ` : ''}Nothing is sent, composed or run automatically until an owner or admin resumes it.`,
      href: '/autopilot#pause',
      dedupeKey: 'automation.paused',
    });
  }
  return result;
}

// ---- undo -----------------------------------------------------------------

/**
 * Take back one's own pause within PAUSE_UNDO_WINDOW_MS (database clock).
 * After the window, or for anyone else, it is too late: an owner or admin
 * resumes instead.
 */
export async function undoPause(
  ctx: WorkspaceContext,
  input: { device?: PauseDevice } = {},
): Promise<{ undone: true; pausedAt: Date }> {
  if (!canWrite(ctx)) throw denied('automation.pause_undo');
  const device = PAUSE_DEVICES.includes(input.device ?? 'unknown')
    ? (input.device ?? 'unknown')
    : 'unknown';
  return db.transaction(async (tx) => {
    const current = await lockWorkspace(tx, ctx.workspaceId);
    if (!current.pausedAt) {
      throw new AutomationPauseError('Automation is not paused.', 'not_paused');
    }
    if (current.pausedByUserId !== ctx.userId) {
      throw new AutomationPauseError(
        'Only the person who paused can undo it. An owner or admin can resume.',
        'permission_denied',
      );
    }
    const [row] = await tx
      .update(workspaces)
      .set({
        automationPausedAt: null,
        automationPausedByUserId: null,
        automationPauseReason: null,
        automationPauseSource: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, ctx.workspaceId),
          isNotNull(workspaces.automationPausedAt),
          // Raw SQL: the window is measured on the database clock that
          // stamped automation_paused_at (no JS Date in the template).
          sql`clock_timestamp() <= ${workspaces.automationPausedAt} + ${PAUSE_UNDO_WINDOW_SQL}`,
        ),
      )
      .returning({ id: workspaces.id });
    if (!row) {
      throw new AutomationPauseError(
        'Too late to undo (the undo lasts 10 seconds). An owner or admin can resume.',
        'too_late',
      );
    }
    await mirrorLegacyFlags(tx, ctx.workspaceId, false);
    await recordAuditEvent(
      ctx,
      {
        kind: 'automation.pause_undone',
        entityType: 'workspace',
        entityId: ctx.workspaceId,
        payload: { device, pausedAt: current.pausedAt.toISOString(), source: current.source },
      },
      tx,
    );
    return { undone: true as const, pausedAt: current.pausedAt };
  });
}

// ---- resume ---------------------------------------------------------------

export interface ResumeResult {
  /** False when the workspace was not paused (nothing changed). */
  wasPaused: boolean;
  pausedAt: Date | null;
  /** Reply auto-actions held while paused, for "Review held actions". */
  heldInboundActions: number;
}

/** Resume automatic work. Owners and admins only. Idempotent. */
export async function resumeAutomation(
  ctx: WorkspaceContext,
  input: PauseControlInput,
): Promise<ResumeResult> {
  if (!canAdminWorkspace(ctx)) {
    throw new AutomationPauseError(
      'Only owners and admins can resume automation.',
      'permission_denied',
    );
  }
  const v = parseControlInput(input);
  return db.transaction(async (tx) => {
    const current = await lockWorkspace(tx, ctx.workspaceId);
    if (!current.pausedAt) return { wasPaused: false, pausedAt: null, heldInboundActions: 0 };
    const held = await countHeldInboundActions(ctx.workspaceId, current.pausedAt, tx);
    await tx
      .update(workspaces)
      .set({
        automationPausedAt: null,
        automationPausedByUserId: null,
        automationPauseReason: null,
        automationPauseSource: null,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, ctx.workspaceId));
    await mirrorLegacyFlags(tx, ctx.workspaceId, false);
    await recordAuditEvent(
      ctx,
      {
        kind: 'automation.resumed',
        entityType: 'workspace',
        entityId: ctx.workspaceId,
        payload: {
          source: v.source,
          device: v.device,
          reason: v.reason,
          pausedAt: current.pausedAt.toISOString(),
          pausedByUserId: current.pausedByUserId,
          pauseReason: current.reason,
          pauseSource: current.source,
          heldInboundActions: held,
        },
      },
      tx,
    );
    return { wasPaused: true, pausedAt: current.pausedAt, heldInboundActions: held };
  });
}

// ---- held reply auto-actions -------------------------------------------

/** The audit kind both reply paths write when an auto-action was held
 *  (reply-classifier.ts, outreach-reply-handler.ts). */
export const HELD_INBOUND_ACTION_KIND = 'reply.auto_actions_held';

/** Raw SQL: a jsonb field test (no parameters beyond the literal). */
const heldByPause = sql`${auditLog.payload}->>'gate' = 'paused'`;

async function countHeldInboundActions(
  workspaceId: bigint,
  since: Date,
  executor: Pick<typeof db, 'select'> = db,
): Promise<number> {
  const [row] = await executor
    .select({ n: countDistinct(auditLog.entityId) })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, workspaceId),
        eq(auditLog.kind, HELD_INBOUND_ACTION_KIND),
        gte(auditLog.createdAt, since),
        heldByPause,
      ),
    );
  return Number(row?.n ?? 0);
}

export interface HeldInboundAction {
  /** mail_messages.id of the reply whose auto-action waited. */
  messageId: string;
  at: Date;
  /** The classification or decision that would have acted. */
  trigger: string | null;
}

/** Reply auto-actions (suppress, close, decline handling) the pause held
 *  since `since` (default: the current pause), newest first, one per
 *  message — the "Review held actions" list. */
export async function listHeldInboundActions(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  options: { since?: Date; limit?: number } = {},
): Promise<HeldInboundAction[]> {
  let since = options.since;
  if (!since) {
    const [ws] = await db
      .select({ pausedAt: workspaces.automationPausedAt })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    if (!ws?.pausedAt) return [];
    since = ws.pausedAt;
  }
  const rows = await db
    .select({ entityId: auditLog.entityId, createdAt: auditLog.createdAt, payload: auditLog.payload })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, ctx.workspaceId),
        eq(auditLog.kind, HELD_INBOUND_ACTION_KIND),
        gte(auditLog.createdAt, since),
        heldByPause,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(options.limit ?? 50, 200) * 2);
  const seen = new Set<string>();
  const out: HeldInboundAction[] = [];
  for (const r of rows) {
    if (!r.entityId || seen.has(r.entityId)) continue;
    seen.add(r.entityId);
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const trigger =
      typeof p.classification === 'string'
        ? p.classification
        : typeof p.trigger === 'string'
          ? p.trigger
          : null;
    out.push({ messageId: r.entityId, at: r.createdAt, trigger });
    if (out.length >= (options.limit ?? 50)) break;
  }
  return out;
}

// ---- overview for the controls ---------------------------------------------

export interface AutomationPauseImpact {
  /** Queued outbound email (all / already due) and the next send time. */
  queued: number;
  queuedDue: number;
  nextSendAt: Date | null;
  pendingFollowUps: number;
  awaitingApprovalFollowUps: number;
  enabledCrawlPlans: number;
  autopilotEnabled: boolean;
  /** Reply auto-actions held by the current pause. */
  heldInboundActions: number;
}

export interface AutomationPauseOverview {
  pause: (WorkspacePause & { byLabel: string | null }) | null;
  canPause: boolean;
  canResume: boolean;
  /** Present while the viewer may still undo their own pause. */
  undoUntil: Date | null;
  impact: AutomationPauseImpact;
}

/** Everything the pause and resume controls show, for any member. */
export async function getAutomationPauseOverview(
  ctx: WorkspaceContext,
  now: Date = new Date(),
): Promise<AutomationPauseOverview> {
  const [ws] = await db
    .select({
      pausedAt: workspaces.automationPausedAt,
      pausedByUserId: workspaces.automationPausedByUserId,
      reason: workspaces.automationPauseReason,
      source: workspaces.automationPauseSource,
      byName: users.name,
      byEmail: users.email,
    })
    .from(workspaces)
    .leftJoin(users, eq(users.id, workspaces.automationPausedByUserId))
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!ws) throw new AutomationPauseError('workspace not found', 'not_found');

  const [queuedAll] = await db
    .select({ n: count(), next: min(outreachQueue.scheduledSendAt) })
    .from(outreachQueue)
    .where(and(eq(outreachQueue.workspaceId, ctx.workspaceId), eq(outreachQueue.status, 'queued')));
  const [queuedDue] = await db
    .select({ n: count() })
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.workspaceId, ctx.workspaceId),
        eq(outreachQueue.status, 'queued'),
        lte(outreachQueue.scheduledSendAt, now),
      ),
    );
  const [pendingFu] = await db
    .select({ n: count() })
    .from(outreachFollowUps)
    .where(
      and(
        eq(outreachFollowUps.workspaceId, ctx.workspaceId),
        eq(outreachFollowUps.status, 'pending'),
      ),
    );
  const [awaitingFu] = await db
    .select({ n: count() })
    .from(outreachFollowUps)
    .where(
      and(
        eq(outreachFollowUps.workspaceId, ctx.workspaceId),
        eq(outreachFollowUps.status, 'awaiting_approval'),
      ),
    );
  const [plans] = await db
    .select({ n: count() })
    .from(crawlPlans)
    .where(and(eq(crawlPlans.workspaceId, ctx.workspaceId), eq(crawlPlans.enabled, true)));
  const [ap] = await db
    .select({ enabled: autopilotSettings.autopilotEnabled })
    .from(autopilotSettings)
    .where(eq(autopilotSettings.workspaceId, ctx.workspaceId))
    .limit(1);
  const held = ws.pausedAt ? await countHeldInboundActions(ctx.workspaceId, ws.pausedAt) : 0;

  const undoUntil =
    ws.pausedAt &&
    ws.pausedByUserId === ctx.userId &&
    now.getTime() < ws.pausedAt.getTime() + PAUSE_UNDO_WINDOW_MS
      ? new Date(ws.pausedAt.getTime() + PAUSE_UNDO_WINDOW_MS)
      : null;

  return {
    pause: ws.pausedAt
      ? {
          since: ws.pausedAt,
          byUserId: ws.pausedByUserId,
          reason: ws.reason,
          source: ws.source,
          byLabel: ws.byName?.trim() || ws.byEmail || null,
        }
      : null,
    canPause: canWrite(ctx),
    canResume: canAdminWorkspace(ctx),
    undoUntil,
    impact: {
      queued: Number(queuedAll?.n ?? 0),
      queuedDue: Number(queuedDue?.n ?? 0),
      nextSendAt: queuedAll?.next ?? null,
      pendingFollowUps: Number(pendingFu?.n ?? 0),
      awaitingApprovalFollowUps: Number(awaitingFu?.n ?? 0),
      enabledCrawlPlans: Number(plans?.n ?? 0),
      autopilotEnabled: ap?.enabled ?? false,
      heldInboundActions: held,
    },
  };
}
