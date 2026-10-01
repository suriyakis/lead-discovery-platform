// Reply auto-actions (Phase 20 table, made operable in Phase 0 / ia:F-03).
//
// Per-workspace switches for what the reply classifier may do on its own
// when it labels an inbound message: suppress the sender (unsubscribe /
// bounce), close the linked lead (negative), create contacts from a
// redirect. Both auto paths — applyAutoActions in reply-classifier.ts and
// the close_and_suppress branch in outreach-reply-handler.ts — read these
// switches; nothing else does.
//
// X1 / I088: the classifier currently runs over every IMAP-synced message,
// not only replies to our outreach, so the suppression switches silently
// suppressed ordinary correspondents. Changing a switch is therefore
// admin-only and audited (`reply_auto_actions.changed`), the defaults are
// off (migration 0062), and getReplyAutoActionsImpact() reports what the
// auto paths did recently so the settings page can show it.

import { z } from 'zod';
import { and, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import {
  replyAutoActions,
  suppressionList,
  type ReplyAutoActions,
  type SuppressionSource,
} from '@/lib/db/schema/mailing';
import { pipelineEvents } from '@/lib/db/schema/pipeline';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, type WorkspaceContext } from './context';

export class ReplyAutoActionsError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ReplyAutoActionsError';
    this.code = code;
  }
}

/** The four switches, in the order the settings page shows them. */
export const REPLY_AUTO_ACTION_KEYS = [
  'autoSuppressUnsubscribe',
  'autoSuppressBounce',
  'autoCloseNegative',
  'autoExtractRedirects',
] as const;

export type ReplyAutoActionKey = (typeof REPLY_AUTO_ACTION_KEYS)[number];

export type ReplyAutoActionSwitches = Pick<ReplyAutoActions, ReplyAutoActionKey>;

/** Boundary schema: only known switches, only real booleans. */
export const updateReplyAutoActionsSchema = z
  .object({
    autoSuppressUnsubscribe: z.boolean().optional(),
    autoSuppressBounce: z.boolean().optional(),
    autoCloseNegative: z.boolean().optional(),
    autoExtractRedirects: z.boolean().optional(),
  })
  .strict();

export type UpdateReplyAutoActionsInput = z.infer<typeof updateReplyAutoActionsSchema>;

/**
 * Key stored on the pipeline_events payload when an auto path closes a
 * lead, so the impact count can tell automatic closes from manual ones.
 * Value: the classification that triggered it ('unsubscribe' | 'bounce' |
 * 'negative').
 */
export const REPLY_AUTO_ACTION_EVENT_KEY = 'replyAutoAction';

/** pipeline_events payload for a lead an auto path closed. */
export function autoClosePayload(
  trigger: 'unsubscribe' | 'bounce' | 'negative',
  messageId: bigint,
): Record<string, unknown> {
  return {
    [REPLY_AUTO_ACTION_EVENT_KEY]: trigger,
    sourceMessageId: messageId.toString(),
  };
}

/**
 * Suppression sources the reply classifier's auto paths write: `reply`
 * today, `legacy_auto` for rows written before provenance existed (F-03).
 */
const AUTO_SUPPRESSION_SOURCES: readonly SuppressionSource[] = ['reply', 'legacy_auto'];

/** 'suppression.add' outcomes that actually put an address under suppression. */
const SUPPRESSING_OUTCOMES = ['created', 'reactivated', 'renewed', 'upgraded'] as const;

export const REPLY_AUTO_ACTIONS_IMPACT_DAYS = 30;

// ---- settings --------------------------------------------------------

/**
 * Read the workspace's switches, creating the row with the column
 * defaults (all suppression / close switches off) on first access.
 */
export async function getReplyAutoActions(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<ReplyAutoActions> {
  const rows = await db
    .select()
    .from(replyAutoActions)
    .where(eq(replyAutoActions.workspaceId, ctx.workspaceId))
    .limit(1);
  if (rows[0]) return rows[0];
  await db
    .insert(replyAutoActions)
    .values({ workspaceId: ctx.workspaceId })
    .onConflictDoNothing();
  const reload = await db
    .select()
    .from(replyAutoActions)
    .where(eq(replyAutoActions.workspaceId, ctx.workspaceId))
    .limit(1);
  if (!reload[0]) {
    throw new ReplyAutoActionsError(
      'reply_auto_actions init returned no row',
      'invariant_violation',
    );
  }
  return reload[0];
}

/**
 * Change one or more switches. Workspace admins only. Writes one
 * `reply_auto_actions.changed` audit event listing each switch that
 * actually changed (from → to); a save that changes nothing writes
 * nothing and returns the current row.
 */
export async function updateReplyAutoActions(
  ctx: WorkspaceContext,
  input: UpdateReplyAutoActionsInput,
): Promise<ReplyAutoActions> {
  if (!canAdminWorkspace(ctx)) {
    throw new ReplyAutoActionsError(
      'Permission denied: reply_auto_actions.update',
      'permission_denied',
    );
  }
  const parsed = updateReplyAutoActionsSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReplyAutoActionsError(
      `invalid reply auto-actions input: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
      'invalid_input',
    );
  }
  const wanted = parsed.data;

  // Make sure the row exists, then lock it so the audit "from" values are
  // exactly what this update replaced even if two admins save at once.
  await getReplyAutoActions(ctx);
  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(replyAutoActions)
      .where(eq(replyAutoActions.workspaceId, ctx.workspaceId))
      .limit(1)
      .for('update');
    if (!current) {
      throw new ReplyAutoActionsError(
        'reply_auto_actions row vanished',
        'invariant_violation',
      );
    }
    const changes: Partial<Record<ReplyAutoActionKey, { from: boolean; to: boolean }>> = {};
    const patch: Partial<ReplyAutoActionSwitches> = {};
    for (const key of REPLY_AUTO_ACTION_KEYS) {
      const to = wanted[key];
      if (to === undefined || to === current[key]) continue;
      changes[key] = { from: current[key], to };
      patch[key] = to;
    }
    if (Object.keys(patch).length === 0) {
      return { row: current, changes: null };
    }
    const [updated] = await tx
      .update(replyAutoActions)
      .set({ ...patch, updatedBy: ctx.userId, updatedAt: new Date() })
      .where(eq(replyAutoActions.workspaceId, ctx.workspaceId))
      .returning();
    if (!updated) {
      throw new ReplyAutoActionsError(
        'reply_auto_actions update returned no row',
        'invariant_violation',
      );
    }
    return { row: updated, changes };
  });

  if (result.changes) {
    await recordAuditEvent(ctx, {
      kind: 'reply_auto_actions.changed',
      entityType: 'workspace',
      entityId: ctx.workspaceId,
      payload: {
        changes: result.changes,
        after: switchesOf(result.row),
      },
    });
  }
  return result.row;
}

export function switchesOf(row: ReplyAutoActions): ReplyAutoActionSwitches {
  return {
    autoSuppressUnsubscribe: row.autoSuppressUnsubscribe,
    autoSuppressBounce: row.autoSuppressBounce,
    autoCloseNegative: row.autoCloseNegative,
    autoExtractRedirects: row.autoExtractRedirects,
  };
}

// ---- impact ----------------------------------------------------------

export interface ReplyAutoActionsImpact {
  windowDays: number;
  since: Date;
  /** Distinct suppression entries the classifier's auto paths created,
      re-activated, renewed or upgraded in the window. */
  suppressedAddresses: number;
  /** …of which still suppress today (not revoked, not expired). */
  stillSuppressed: number;
  /** Distinct leads an auto path closed in the window. */
  closedLeads: number;
}

/**
 * What the reply auto-actions did in the last `days` days, for the
 * settings page. Counts only — no addresses — so any member may read it.
 *
 * Suppressions come from two places, unioned by entry id:
 * - suppression_list rows whose provenance in force is automatic (`reply`,
 *   or `legacy_auto` for pre-provenance rows — the "auto-suppressed from
 *   message N" notes) and that were created in the window;
 * - 'suppression.add' audit events with source `reply` in the window whose
 *   outcome actually suppressed (catches re-activated / upgraded rows whose
 *   created_at is older, and rows whose provenance was later taken over).
 * Lead closes come from pipeline_events tagged REPLY_AUTO_ACTION_EVENT_KEY.
 */
export async function getReplyAutoActionsImpact(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  options: { days?: number; now?: Date } = {},
): Promise<ReplyAutoActionsImpact> {
  const windowDays = options.days ?? REPLY_AUTO_ACTIONS_IMPACT_DAYS;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 86_400_000);

  const createdRows = await db
    .select({ id: suppressionList.id })
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.workspaceId, ctx.workspaceId),
        inArray(suppressionList.source, [...AUTO_SUPPRESSION_SOURCES]),
        gte(suppressionList.createdAt, since),
      ),
    );
  const auditRows = await db
    .select({ entityId: auditLog.entityId })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, ctx.workspaceId),
        eq(auditLog.kind, 'suppression.add'),
        gte(auditLog.createdAt, since),
        eq(sql<string>`${auditLog.payload}->>'source'`, 'reply'),
        inArray(sql<string>`${auditLog.payload}->>'outcome'`, [...SUPPRESSING_OUTCOMES]),
      ),
    );

  const ids = new Set<bigint>(createdRows.map((r) => r.id));
  for (const r of auditRows) {
    if (r.entityId && /^\d+$/.test(r.entityId)) ids.add(BigInt(r.entityId));
  }

  let stillSuppressed = 0;
  if (ids.size > 0) {
    const active = await db
      .select({ id: suppressionList.id })
      .from(suppressionList)
      .where(
        and(
          eq(suppressionList.workspaceId, ctx.workspaceId),
          inArray(suppressionList.id, [...ids]),
          isNull(suppressionList.revokedAt),
          or(isNull(suppressionList.expiresAt), gt(suppressionList.expiresAt, now)),
        ),
      );
    stillSuppressed = active.length;
  }

  const closes = await db
    .selectDistinct({ leadId: pipelineEvents.qualifiedLeadId })
    .from(pipelineEvents)
    .where(
      and(
        eq(pipelineEvents.workspaceId, ctx.workspaceId),
        eq(pipelineEvents.toState, 'closed'),
        gte(pipelineEvents.createdAt, since),
        sql`${pipelineEvents.payload} ? ${REPLY_AUTO_ACTION_EVENT_KEY}`,
      ),
    );

  return {
    windowDays,
    since,
    suppressedAddresses: ids.size,
    stillSuppressed,
    closedLeads: closes.length,
  };
}
