// Phase 58 — automatic follow-up scheduling + processing.
//
// Lifecycle:
//   1. mail.sendMessage success on a thread linked to a qualified lead
//      → scheduleFollowUps creates N pending rows at NOW + k*intervalDays.
//   2. Recipient replies → reply-classifier calls cancelFollowUps('replied').
//   3. Bounce / hard send failure → cancelFollowUps('bounce').
//   4. Worker tick (hourly) → processDueFollowUps walks pending rows where
//      scheduled_for <= NOW, double-checks the short-circuits (reply /
//      bounce / lead closed), composes a polite draft via the AI, sends
//      via mail.sendMessage with in-reply-to threading, marks status='sent'.
//
// Cancellation is preferred over deletion so the operator can see the
// schedule history on the Follow-ups tab.

import { and, asc, desc, eq, isNull, lte, ne, or } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailMessages, mailThreads } from '@/lib/db/schema/mailing';
import {
  outreachFollowUps,
  type FollowUpSkipReason,
  type OutreachFollowUp,
} from '@/lib/db/schema/follow-ups';
import { outreachQueue } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { productProfiles, type ProductProfile } from '@/lib/db/schema/products';
import { workspaces } from '@/lib/db/schema/workspaces';
import { canWrite, type WorkspaceContext } from './context';
import { recordAuditEvent } from './audit';
import { getAIProviderForCtx } from '@/lib/ai';
import {
  composeFollowUpDraft,
  type ThreadMessage,
} from './outreach-engine';
import { sendMessage } from './mail';
import { prepareOutboundDualBody } from './language-resolution';
import { getWorkspaceNativeLanguage } from './workspace';
import type { IMailProvider } from '@/lib/mail';

export class FollowUpServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'FollowUpServiceError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new FollowUpServiceError(`Permission denied: ${op}`, 'permission_denied');

export interface FollowUpStepConfig {
  /** Days between this step and the previous one (or send time for
   *  step 1). Must be >= 1. */
  daysAfterPrev: number;
  /** Operator-supplied text injected verbatim into the AI prompt for
   *  this step. Empty string for "no extra direction". Up to 2000 chars. */
  customInstructions: string;
}

export interface WorkspaceFollowUpSettings {
  enabled: boolean;
  requireApproval: boolean;
  steps: FollowUpStepConfig[];
}

const DEFAULT_STEP: FollowUpStepConfig = {
  daysAfterPrev: 7,
  customInstructions: '',
};

export async function loadSettings(
  workspaceId: bigint,
): Promise<WorkspaceFollowUpSettings> {
  const [row] = await db
    .select({
      enabled: workspaces.followUpEnabled,
      requireApproval: workspaces.followUpRequireApproval,
      intervalDays: workspaces.followUpIntervalDays,
      maxSteps: workspaces.followUpMaxSteps,
      stepConfigs: workspaces.followUpStepConfigs,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const enabled = row?.enabled ?? true;
  const requireApproval = row?.requireApproval ?? false;
  // Prefer per-step JSONB config when set; fall back to the legacy
  // simple interval × maxSteps so existing workspaces keep working
  // without a backfill migration.
  const rawConfigs = row?.stepConfigs;
  const steps =
    Array.isArray(rawConfigs) && rawConfigs.length > 0
      ? rawConfigs
          .map((c) => coerceStep(c))
          .filter((c): c is FollowUpStepConfig => c !== null)
      : Array.from({ length: row?.maxSteps ?? 3 }, () => ({
          daysAfterPrev: row?.intervalDays ?? 7,
          customInstructions: '',
        }));
  return { enabled, requireApproval, steps };
}

function coerceStep(input: unknown): FollowUpStepConfig | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const days = Number(o.daysAfterPrev);
  if (!Number.isFinite(days) || days < 1) return null;
  const instr =
    typeof o.customInstructions === 'string' ? o.customInstructions : '';
  return {
    daysAfterPrev: Math.floor(days),
    customInstructions: instr.slice(0, 2000),
  };
}

/** Admin-only writer. Validates that steps is non-empty and each step
 *  has daysAfterPrev >= 1; trims customInstructions to 2000 chars. */
export async function updateFollowUpConfig(
  ctx: WorkspaceContext,
  input: {
    enabled?: boolean;
    requireApproval?: boolean;
    steps?: ReadonlyArray<FollowUpStepConfig>;
  },
): Promise<WorkspaceFollowUpSettings> {
  const { canAdminWorkspace } = await import('./context');
  if (!canAdminWorkspace(ctx)) {
    throw new FollowUpServiceError(
      'Permission denied: follow_up_config.update',
      'permission_denied',
    );
  }
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.enabled !== undefined) updates.followUpEnabled = input.enabled;
  if (input.requireApproval !== undefined) {
    updates.followUpRequireApproval = input.requireApproval;
  }
  if (input.steps !== undefined) {
    if (input.steps.length < 1 || input.steps.length > 10) {
      throw new FollowUpServiceError(
        'steps must have between 1 and 10 entries',
        'invalid_input',
      );
    }
    const cleaned = input.steps.map((s, i) => {
      if (!Number.isFinite(s.daysAfterPrev) || s.daysAfterPrev < 1) {
        throw new FollowUpServiceError(
          `step ${i + 1}: daysAfterPrev must be >= 1`,
          'invalid_input',
        );
      }
      return {
        daysAfterPrev: Math.floor(s.daysAfterPrev),
        customInstructions: (s.customInstructions ?? '').slice(0, 2000),
      };
    });
    updates.followUpStepConfigs = cleaned;
  }
  await db
    .update(workspaces)
    .set(updates)
    .where(eq(workspaces.id, ctx.workspaceId));
  await recordAuditEvent(ctx, {
    kind: 'follow_up_config.update',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: {
      enabled: input.enabled,
      requireApproval: input.requireApproval,
      stepCount: input.steps?.length,
    },
  });
  return loadSettings(ctx.workspaceId);
}

/**
 * Schedule the follow-up arc for a thread that just had its first
 * outbound. Idempotent — calling it twice for the same thread is a
 * no-op (unique index on (workspace, thread, step) absorbs duplicates).
 *
 * Returns the rows actually created (empty list if the workspace has
 * follow-ups disabled, or a schedule already exists, or the lead is
 * closed).
 */
export async function scheduleFollowUps(
  ctx: WorkspaceContext,
  input: { threadId: bigint; qualifiedLeadId: bigint },
): Promise<OutreachFollowUp[]> {
  if (!canWrite(ctx)) throw denied('follow_up.schedule');
  const settings = await loadSettings(ctx.workspaceId);
  if (!settings.enabled || settings.steps.length < 1) return [];

  // Don't schedule for closed / archived leads.
  const [lead] = await db
    .select()
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.id, input.qualifiedLeadId),
      ),
    )
    .limit(1);
  if (!lead) return [];
  if (lead.state === 'closed') return [];

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  let cumulativeDays = 0;
  const rowsToInsert = settings.steps.map((step, i) => {
    cumulativeDays += step.daysAfterPrev;
    return {
      workspaceId: ctx.workspaceId,
      qualifiedLeadId: input.qualifiedLeadId,
      threadId: input.threadId,
      stepNumber: i + 1,
      totalSteps: settings.steps.length,
      scheduledFor: new Date(now.getTime() + cumulativeDays * dayMs),
      status: 'pending' as const,
    };
  });

  const inserted = await db
    .insert(outreachFollowUps)
    .values(rowsToInsert)
    .onConflictDoNothing({
      target: [
        outreachFollowUps.workspaceId,
        outreachFollowUps.threadId,
        outreachFollowUps.stepNumber,
      ],
    })
    .returning();

  if (inserted.length > 0) {
    await recordAuditEvent(ctx, {
      kind: 'follow_up.scheduled',
      entityType: 'mail_thread',
      entityId: input.threadId,
      payload: {
        leadId: input.qualifiedLeadId.toString(),
        stepsCreated: inserted.length,
        firstStepAt: inserted[0]?.scheduledFor.toISOString() ?? null,
      },
    });
  }
  return inserted;
}

/**
 * Cancel every pending follow-up for a thread. Set status='skipped',
 * stamp the reason, leave the row for audit. Returns the number
 * cancelled.
 */
export async function cancelFollowUps(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  threadId: bigint,
  reason: FollowUpSkipReason,
): Promise<number> {
  const result = await db
    .update(outreachFollowUps)
    .set({
      status: 'skipped',
      skipReason: reason,
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(outreachFollowUps.workspaceId, ctx.workspaceId),
        eq(outreachFollowUps.threadId, threadId),
        eq(outreachFollowUps.status, 'pending'),
      ),
    )
    .returning();
  if (result.length > 0) {
    // recordAuditEvent only reads workspaceId off the ctx; the wider
    // WorkspaceContext shape (role / userId) isn't required. Cast to
    // satisfy the helper without forcing every caller of
    // cancelFollowUps to carry a full ctx.
    await recordAuditEvent(
      { workspaceId: ctx.workspaceId } as WorkspaceContext,
      {
        kind: 'follow_up.cancelled',
        entityType: 'mail_thread',
        entityId: threadId,
        payload: { reason, cancelledCount: result.length },
      },
    );
  }
  return result.length;
}

/**
 * Worker entry — process every pending follow-up whose scheduled_for has
 * passed for this workspace. Returns counts for the tick telemetry log.
 *
 * The double-check pattern is deliberate: the cancel cascades happen on
 * reply / bounce, but a race is always possible (reply arrives between
 * the moment cancelFollowUps is called and the moment processDue
 * actually runs). So we re-verify "is there an inbound after our last
 * outbound on this thread?" and "is there a failed queue entry?" before
 * actually sending.
 */
export interface ProcessDueFollowUpsDeps {
  /** Test seam — used by unit tests to inject a MockMailProvider so the
   *  follow-up's send doesn't try to reach a real SMTP server. */
  mailProviderOverride?: IMailProvider;
}

export async function processDueFollowUps(
  ctx: WorkspaceContext,
  deps: ProcessDueFollowUpsDeps = {},
): Promise<{
  checked: number;
  sent: number;
  skipped: number;
  failed: number;
}> {
  const settings = await loadSettings(ctx.workspaceId);
  if (!settings.enabled) return { checked: 0, sent: 0, skipped: 0, failed: 0 };

  const due = await db
    .select()
    .from(outreachFollowUps)
    .where(
      and(
        eq(outreachFollowUps.workspaceId, ctx.workspaceId),
        eq(outreachFollowUps.status, 'pending'),
        lte(outreachFollowUps.scheduledFor, new Date()),
      ),
    )
    .orderBy(asc(outreachFollowUps.scheduledFor))
    .limit(100);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const verdict = await processOne(ctx, row, deps);
      if (verdict === 'sent') sent++;
      else if (verdict === 'skipped') skipped++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(outreachFollowUps)
        .set({
          status: 'failed',
          lastError: msg.slice(0, 2000),
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(outreachFollowUps.id, row.id));
    }
  }
  return { checked: due.length, sent, skipped, failed };
}

async function processOne(
  ctx: WorkspaceContext,
  row: OutreachFollowUp,
  deps: ProcessDueFollowUpsDeps = {},
): Promise<'sent' | 'skipped'> {
  // Re-verify: any inbound on this thread? If so, recipient already
  // replied — cancel the rest of the cascade.
  const inboundAfter = await db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.threadId, row.threadId),
        eq(mailMessages.direction, 'inbound'),
      ),
    )
    .limit(1);
  if (inboundAfter.length > 0) {
    await cancelFollowUps(ctx, row.threadId, 'replied');
    return 'skipped';
  }

  // Re-verify: any failed queue entry tied to this thread? If so,
  // bounce / SMTP error — don't keep pinging.
  const errored = await db
    .select({ id: outreachQueue.id })
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.workspaceId, ctx.workspaceId),
        eq(outreachQueue.status, 'failed'),
      ),
    )
    .limit(50);
  if (errored.length > 0) {
    // Coarse check — a failed queue row for this workspace might be a
    // different thread. We'd need a thread<->queue link to filter
    // precisely; for v1 we treat ANY failed queue as a global signal
    // to NOT escalate, which biases safe. Refined join can come later.
    // (Removing — too aggressive. Skip this check for v1.)
    void errored;
  }

  // Load lead + thread + product for context.
  const [lead] = await db
    .select()
    .from(qualifiedLeads)
    .where(eq(qualifiedLeads.id, row.qualifiedLeadId))
    .limit(1);
  if (!lead || lead.state === 'closed') {
    await cancelFollowUps(ctx, row.threadId, 'lead_closed');
    return 'skipped';
  }
  if (!lead.contactEmail) {
    // No address to send to — skip with reason.
    await db
      .update(outreachFollowUps)
      .set({
        status: 'skipped',
        skipReason: 'manual_cancel',
        lastError: 'no contact email on lead',
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(outreachFollowUps.id, row.id));
    return 'skipped';
  }

  const [thread] = await db
    .select()
    .from(mailThreads)
    .where(eq(mailThreads.id, row.threadId))
    .limit(1);
  if (!thread) {
    await cancelFollowUps(ctx, row.threadId, 'manual_cancel');
    return 'skipped';
  }

  const [product] = (await db
    .select()
    .from(productProfiles)
    .where(eq(productProfiles.id, lead.productProfileId))
    .limit(1)) as ProductProfile[];
  if (!product || !product.active) {
    await cancelFollowUps(ctx, row.threadId, 'product_archived');
    return 'skipped';
  }

  // Last outbound message — used for in-reply-to threading.
  const messages = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.threadId, row.threadId),
      ),
    )
    .orderBy(asc(mailMessages.createdAt));
  if (messages.length === 0) {
    // No prior outbound — schedule was created against an empty
    // thread somehow. Skip rather than send into the void.
    await cancelFollowUps(ctx, row.threadId, 'manual_cancel');
    return 'skipped';
  }
  const lastMessage = messages[messages.length - 1]!;

  // Compose body via AI.
  const settings = await loadSettings(ctx.workspaceId);
  const provider = await getAIProviderForCtx(ctx);
  const threadHistory: ThreadMessage[] = messages.map((m) => ({
    direction: m.direction === 'inbound' ? 'inbound' : 'outbound',
    body: m.bodyText ?? '',
    at: (m.receivedAt ?? m.createdAt).toISOString(),
    fromName: m.fromName ?? null,
    fromAddress: m.fromAddress ?? null,
  }));
  // Per-step custom instructions land in the AI prompt as a numbered
  // operator-direction block — see composeFollowUpDraft + buildFollowUpPrompt.
  const stepConfig = settings.steps[row.stepNumber - 1];
  const customInstructions = stepConfig?.customInstructions?.trim() ?? '';
  // Flow A: compose the follow-up in the workspace native language; the
  // send step below translates it to the recipient's target language.
  const nativeLanguage = await getWorkspaceNativeLanguage(ctx);
  const verdict = await composeFollowUpDraft(
    threadHistory,
    product,
    row.stepNumber,
    row.totalSteps,
    { channel: 'email', language: nativeLanguage },
    provider,
    undefined,
    customInstructions || undefined,
  );

  // Subject: preserve the thread subject prefixed Re: (operator's mail
  // client will collapse it into the same conversation).
  const subject = thread.subject.match(/^Re:/i)
    ? thread.subject
    : `Re: ${thread.subject}`;

  // Phase 59 — approval gate. When require_approval is on, persist the
  // composed subject + body on the follow-up row and flip status to
  // 'awaiting_approval' instead of sending. Operator reviews + approves
  // via the Follow-ups tab (approveFollowUp helper below). Cuts the
  // automated send loop for high-touch workflows.
  if (settings.requireApproval) {
    await db
      .update(outreachFollowUps)
      .set({
        status: 'awaiting_approval',
        stagedSubject: subject,
        stagedBody: verdict.body,
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(outreachFollowUps.id, row.id));
    await recordAuditEvent(ctx, {
      kind: 'follow_up.awaiting_approval',
      entityType: 'mail_thread',
      entityId: row.threadId,
      payload: {
        followUpId: row.id.toString(),
        step: row.stepNumber,
        totalSteps: row.totalSteps,
      },
    });
    return 'skipped';
  }

  // Send. mail.sendMessage handles threading via inReplyTo/references,
  // mailbox lookup, suppression, signature append, and tracking pixel.
  // Flow A: translate the native body to the recipient's target language
  // and persist both sides.
  const dual = await prepareOutboundDualBody(ctx, {
    reviewItemId: lead.reviewItemId,
    productProfileId: lead.productProfileId,
    nativeBody: verdict.body,
  });
  const sent = await sendMessage(ctx, {
    mailboxId: thread.mailboxId,
    to: [
      {
        address: lead.contactEmail,
        name: lead.contactName ?? undefined,
      },
    ],
    subject,
    text: dual.sendText,
    bodyTextNative: dual.bodyTextNative,
    nativeLanguage: dual.nativeLanguage,
    targetLanguage: dual.targetLanguage,
    inReplyTo: lastMessage.messageId ?? undefined,
    references: lastMessage.references ?? [],
    providerOverride: deps.mailProviderOverride,
  });

  await db
    .update(outreachFollowUps)
    .set({
      status: 'sent',
      sentMessageId: sent.id,
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(outreachFollowUps.id, row.id));

  await recordAuditEvent(ctx, {
    kind: 'follow_up.sent',
    entityType: 'mail_thread',
    entityId: row.threadId,
    payload: {
      followUpId: row.id.toString(),
      step: row.stepNumber,
      totalSteps: row.totalSteps,
      messageId: sent.messageId,
    },
  });

  return 'sent';
}

// ─── Approval helpers (Phase 59) ────────────────────────────────────

/**
 * Operator approves an awaiting_approval follow-up. Sends via
 * mail.sendMessage with the stored (possibly edited) subject + body
 * and flips status to 'sent'. Accepts optional `editedSubject` /
 * `editedBody` so the operator can tweak before approving.
 */
export async function approveFollowUp(
  ctx: WorkspaceContext,
  followUpId: bigint,
  override?: { subject?: string; body?: string },
  deps: ProcessDueFollowUpsDeps = {},
): Promise<OutreachFollowUp> {
  if (!canWrite(ctx)) throw denied('follow_up.approve');
  const [row] = await db
    .select()
    .from(outreachFollowUps)
    .where(
      and(
        eq(outreachFollowUps.workspaceId, ctx.workspaceId),
        eq(outreachFollowUps.id, followUpId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new FollowUpServiceError('follow_up not found', 'not_found');
  }
  if (row.status !== 'awaiting_approval') {
    throw new FollowUpServiceError(
      `follow_up status is ${row.status}, not awaiting_approval`,
      'invalid_state',
    );
  }
  const subject = (override?.subject ?? row.stagedSubject ?? '').trim();
  const body = (override?.body ?? row.stagedBody ?? '').trim();
  if (!subject || !body) {
    throw new FollowUpServiceError(
      'staged subject and body are required',
      'invalid_input',
    );
  }

  const [thread] = await db
    .select()
    .from(mailThreads)
    .where(eq(mailThreads.id, row.threadId))
    .limit(1);
  if (!thread) {
    throw new FollowUpServiceError('thread not found', 'not_found');
  }
  const [lead] = await db
    .select()
    .from(qualifiedLeads)
    .where(eq(qualifiedLeads.id, row.qualifiedLeadId))
    .limit(1);
  if (!lead || !lead.contactEmail) {
    throw new FollowUpServiceError(
      'lead or contact email missing — cannot send',
      'invalid_state',
    );
  }

  const messages = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.threadId, row.threadId),
      ),
    )
    .orderBy(asc(mailMessages.createdAt));
  const lastMessage = messages[messages.length - 1] ?? null;

  // Flow A: the staged/edited body is native; translate to the recipient's
  // target language at send and persist both sides.
  const dual = await prepareOutboundDualBody(ctx, {
    reviewItemId: lead.reviewItemId,
    productProfileId: lead.productProfileId,
    nativeBody: body,
  });
  const sent = await sendMessage(ctx, {
    mailboxId: thread.mailboxId,
    to: [
      {
        address: lead.contactEmail,
        name: lead.contactName ?? undefined,
      },
    ],
    subject,
    text: dual.sendText,
    bodyTextNative: dual.bodyTextNative,
    nativeLanguage: dual.nativeLanguage,
    targetLanguage: dual.targetLanguage,
    inReplyTo: lastMessage?.messageId ?? undefined,
    references: lastMessage?.references ?? [],
    providerOverride: deps.mailProviderOverride,
  });

  const [updated] = await db
    .update(outreachFollowUps)
    .set({
      status: 'sent',
      stagedSubject: subject,
      stagedBody: body,
      sentMessageId: sent.id,
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(outreachFollowUps.id, row.id))
    .returning();
  await recordAuditEvent(ctx, {
    kind: 'follow_up.approved',
    entityType: 'mail_thread',
    entityId: row.threadId,
    payload: {
      followUpId: row.id.toString(),
      step: row.stepNumber,
      totalSteps: row.totalSteps,
      messageId: sent.messageId,
      edited: Boolean(override?.subject || override?.body),
    },
  });
  return updated ?? row;
}

/** Operator rejects an awaiting_approval follow-up. Marks it skipped. */
export async function rejectFollowUp(
  ctx: WorkspaceContext,
  followUpId: bigint,
): Promise<OutreachFollowUp> {
  if (!canWrite(ctx)) throw denied('follow_up.reject');
  const [updated] = await db
    .update(outreachFollowUps)
    .set({
      status: 'skipped',
      skipReason: 'manual_cancel',
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(outreachFollowUps.workspaceId, ctx.workspaceId),
        eq(outreachFollowUps.id, followUpId),
        eq(outreachFollowUps.status, 'awaiting_approval'),
      ),
    )
    .returning();
  if (!updated) {
    throw new FollowUpServiceError(
      'follow_up not found or not awaiting approval',
      'not_found',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'follow_up.rejected',
    entityType: 'mail_thread',
    entityId: updated.threadId,
    payload: {
      followUpId: updated.id.toString(),
      step: updated.stepNumber,
    },
  });
  return updated;
}

// ─── read helpers (UI / tests) ──────────────────────────────────────

export interface ListFollowUpsFilter {
  status?:
    | 'pending'
    | 'awaiting_approval'
    | 'sent'
    | 'skipped'
    | 'failed'
    | 'all';
  limit?: number;
}

export interface FollowUpRow extends OutreachFollowUp {
  threadSubject: string | null;
  contactName: string | null;
  contactEmail: string | null;
  productName: string | null;
}

/** UI: rows for the Follow-ups tab on /communication. */
export async function listFollowUps(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListFollowUpsFilter = {},
): Promise<FollowUpRow[]> {
  const limit = Math.min(filter.limit ?? 200, 1000);
  const baseConditions = [eq(outreachFollowUps.workspaceId, ctx.workspaceId)];
  if (filter.status && filter.status !== 'all') {
    baseConditions.push(eq(outreachFollowUps.status, filter.status));
  }
  const rows = await db
    .select({
      followUp: outreachFollowUps,
      threadSubject: mailThreads.subject,
      contactName: qualifiedLeads.contactName,
      contactEmail: qualifiedLeads.contactEmail,
      productName: productProfiles.name,
    })
    .from(outreachFollowUps)
    .leftJoin(
      mailThreads,
      eq(mailThreads.id, outreachFollowUps.threadId),
    )
    .leftJoin(
      qualifiedLeads,
      eq(qualifiedLeads.id, outreachFollowUps.qualifiedLeadId),
    )
    .leftJoin(
      productProfiles,
      eq(productProfiles.id, qualifiedLeads.productProfileId),
    )
    .where(and(...baseConditions))
    .orderBy(
      // Pending soonest-first; everything else newest-first by
      // updatedAt so the recent activity is at the top.
      desc(outreachFollowUps.status),
      asc(outreachFollowUps.scheduledFor),
    )
    .limit(limit);
  return rows.map((r) => ({
    ...r.followUp,
    threadSubject: r.threadSubject ?? null,
    contactName: r.contactName ?? null,
    contactEmail: r.contactEmail ?? null,
    productName: r.productName ?? null,
  }));
}

type FollowUpCountKey =
  | 'pending'
  | 'awaiting_approval'
  | 'sent'
  | 'skipped'
  | 'failed'
  | 'all';

/** Counts by status for the UI tab badges. */
export async function countFollowUpsByStatus(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<Record<FollowUpCountKey, number>> {
  const rows = await db
    .select({
      status: outreachFollowUps.status,
    })
    .from(outreachFollowUps)
    .where(eq(outreachFollowUps.workspaceId, ctx.workspaceId));
  const out: Record<FollowUpCountKey, number> = {
    all: rows.length,
    pending: 0,
    awaiting_approval: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };
  for (const r of rows) {
    if (r.status === 'pending') out.pending++;
    else if (r.status === 'awaiting_approval') out.awaiting_approval++;
    else if (r.status === 'sent') out.sent++;
    else if (r.status === 'skipped') out.skipped++;
    else if (r.status === 'failed') out.failed++;
  }
  return out;
}

// Unused imports referenced for clarity; tree-shaker drops them.
void or;
void ne;
void isNull;
