// Autopilot orchestrator. One runOnce(ctx) cycles through the autopilot
// steps, each gated by the per-workspace autopilot_settings row. Every
// step records 1+ rows on autopilot_log keyed by a shared runId so the UI
// + future operator dashboards can replay what happened.
//
// All steps lean on existing services so the autopilot stays a thin
// orchestrator: it never reaches into the DB to do work that already has
// a service entry point.

import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db/client';
import {
  autopilotLog,
  autopilotSettings,
  type AutopilotLogEntry,
  type AutopilotSettings,
  type NewAutopilotSettings,
} from '@/lib/db/schema/autopilot';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems } from '@/lib/db/schema/review';
import { mailboxes } from '@/lib/db/schema/mailing';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';
import { approveReviewItem } from './review';
import { generateOutreachDraft } from './outreach';
import {
  drainQueue,
  enqueueDraft,
  getSendSettings,
} from './outreach-queue';
import { syncInbound } from './mail';
import { defaultMailbox, listMailboxes } from './mailbox';
import {
  listCrmConnections,
  pushDeal,
  pushLeadToCrm,
} from './crm';
import type { IMailProvider } from '@/lib/mail';

export class AutopilotError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AutopilotError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new AutopilotError(`Permission denied: ${op}`, 'permission_denied');

// ---- settings -----------------------------------------------------

export async function getAutopilotSettings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<AutopilotSettings> {
  const rows = await db
    .select()
    .from(autopilotSettings)
    .where(eq(autopilotSettings.workspaceId, ctx.workspaceId))
    .limit(1);
  if (rows[0]) return rows[0];
  const seed: NewAutopilotSettings = { workspaceId: ctx.workspaceId };
  await db.insert(autopilotSettings).values(seed).onConflictDoNothing();
  const reload = await db
    .select()
    .from(autopilotSettings)
    .where(eq(autopilotSettings.workspaceId, ctx.workspaceId))
    .limit(1);
  if (!reload[0]) throw new AutopilotError('settings init failed', 'invariant_violation');
  return reload[0];
}

export interface UpdateAutopilotSettingsInput {
  autopilotEnabled?: boolean;
  emergencyPause?: boolean;
  enableAutoApproveProjects?: boolean;
  autoApproveThreshold?: number;
  enableAutoEnqueueOutreach?: boolean;
  enableAutoDrainQueue?: boolean;
  enableAutoSyncInbound?: boolean;
  enableAutoCrmContactSync?: boolean;
  enableAutoCrmDealOnQualified?: boolean;
  maxApprovalsPerRun?: number;
  maxEnqueuesPerRun?: number;
  defaultMailboxId?: bigint | null;
  defaultCrmConnectionId?: bigint | null;
}

export async function updateAutopilotSettings(
  ctx: WorkspaceContext,
  input: UpdateAutopilotSettingsInput,
): Promise<AutopilotSettings> {
  if (!canAdminWorkspace(ctx)) throw denied('autopilot.settings.update');
  await getAutopilotSettings(ctx);
  const updates: Partial<AutopilotSettings> & { updatedAt: Date } = {
    updatedAt: new Date(),
    updatedBy: ctx.userId,
  };
  for (const k of [
    'autopilotEnabled',
    'emergencyPause',
    'enableAutoApproveProjects',
    'enableAutoEnqueueOutreach',
    'enableAutoDrainQueue',
    'enableAutoSyncInbound',
    'enableAutoCrmContactSync',
    'enableAutoCrmDealOnQualified',
  ] as const) {
    if (input[k] !== undefined) (updates as Record<string, unknown>)[k] = input[k];
  }
  if (input.autoApproveThreshold !== undefined) {
    updates.autoApproveThreshold = clampInt(input.autoApproveThreshold, 0, 100);
  }
  if (input.maxApprovalsPerRun !== undefined) {
    updates.maxApprovalsPerRun = clampInt(input.maxApprovalsPerRun, 0, 1000);
  }
  if (input.maxEnqueuesPerRun !== undefined) {
    updates.maxEnqueuesPerRun = clampInt(input.maxEnqueuesPerRun, 0, 1000);
  }
  if (input.defaultMailboxId !== undefined) {
    updates.defaultMailboxId = input.defaultMailboxId;
  }
  if (input.defaultCrmConnectionId !== undefined) {
    updates.defaultCrmConnectionId = input.defaultCrmConnectionId;
  }
  const [updated] = await db
    .update(autopilotSettings)
    .set(updates)
    .where(eq(autopilotSettings.workspaceId, ctx.workspaceId))
    .returning();
  if (!updated) {
    throw new AutopilotError('settings update returned no row', 'invariant_violation');
  }
  await recordAuditEvent(ctx, {
    kind: 'autopilot.settings.update',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: { ...input } as Record<string, unknown>,
  });
  return updated;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// ---- run ---------------------------------------------------------

export interface AutopilotRunResult {
  runId: string;
  ranAt: Date;
  steps: Array<{
    step: string;
    outcome: 'success' | 'skipped' | 'error';
    detail: string | null;
  }>;
}

export interface RunOptions {
  /** Test seam — passes a deterministic mail provider through to send/sync. */
  mailProviderOverride?: IMailProvider;
}

export async function runOnce(
  ctx: WorkspaceContext,
  options: RunOptions = {},
): Promise<AutopilotRunResult> {
  if (!canWrite(ctx)) throw denied('autopilot.run');
  const settings = await getAutopilotSettings(ctx);
  const runId = randomUUID();
  const ranAt = new Date();
  const steps: AutopilotRunResult['steps'] = [];

  if (!settings.autopilotEnabled || settings.emergencyPause) {
    await recordStep(ctx, runId, 'guard', 'skipped', settings.emergencyPause ? 'emergency_pause' : 'autopilot_disabled');
    steps.push({
      step: 'guard',
      outcome: 'skipped',
      detail: settings.emergencyPause ? 'emergency_pause' : 'autopilot_disabled',
    });
    return { runId, ranAt, steps };
  }

  if (settings.enableAutoSyncInbound) {
    const r = await stepAutoSyncInbound(ctx, runId, options.mailProviderOverride);
    steps.push(r);
  }

  if (settings.enableAutoApproveProjects) {
    const r = await stepAutoApproveProjects(ctx, runId, settings);
    steps.push(r);
  }

  if (settings.enableAutoEnqueueOutreach) {
    const r = await stepAutoEnqueueOutreach(ctx, runId, settings);
    steps.push(r);
  }

  if (settings.enableAutoDrainQueue) {
    const r = await stepAutoDrainQueue(ctx, runId, options.mailProviderOverride);
    steps.push(r);
  }

  if (settings.enableAutoCrmContactSync) {
    const r = await stepAutoCrmContactSync(ctx, runId, settings);
    steps.push(r);
  }

  if (settings.enableAutoCrmDealOnQualified) {
    const r = await stepAutoCrmDealOnQualified(ctx, runId, settings);
    steps.push(r);
  }

  return { runId, ranAt, steps };
}

// ---- steps -------------------------------------------------------

async function stepAutoSyncInbound(
  ctx: WorkspaceContext,
  runId: string,
  providerOverride: IMailProvider | undefined,
): Promise<AutopilotRunResult['steps'][number]> {
  const mbs = await listMailboxes(ctx);
  const eligible = mbs.filter((m) => m.status === 'active' && m.imapHost);
  if (eligible.length === 0) {
    await recordStep(ctx, runId, 'auto_sync_inbound', 'skipped', 'no IMAP-enabled mailbox');
    return { step: 'auto_sync_inbound', outcome: 'skipped', detail: 'no IMAP-enabled mailbox' };
  }
  let totalNew = 0;
  let totalDup = 0;
  for (const mb of eligible) {
    try {
      const r = await syncInbound(ctx, mb.id, providerOverride);
      totalNew += r.inserted;
      totalDup += r.duplicates;
      await recordStep(
        ctx,
        runId,
        'auto_sync_inbound',
        'success',
        `mailbox=${mb.id} fetched=${r.fetched} new=${r.inserted} dup=${r.duplicates}`,
        'mailbox',
        mb.id.toString(),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await recordStep(ctx, runId, 'auto_sync_inbound', 'error', detail, 'mailbox', mb.id.toString());
    }
  }
  return {
    step: 'auto_sync_inbound',
    outcome: 'success',
    detail: `total new=${totalNew} dup=${totalDup}`,
  };
}

async function stepAutoApproveProjects(
  ctx: WorkspaceContext,
  runId: string,
  settings: AutopilotSettings,
): Promise<AutopilotRunResult['steps'][number]> {
  // Find review items in 'new' state whose top qualification crosses the
  // threshold + workspace's autoApproveThreshold.
  const candidates = await db
    .select({ ri: reviewItems, q: qualifications })
    .from(reviewItems)
    .innerJoin(
      qualifications,
      and(
        eq(qualifications.workspaceId, reviewItems.workspaceId),
        eq(qualifications.sourceRecordId, reviewItems.sourceRecordId),
      ),
    )
    .where(
      and(
        eq(reviewItems.workspaceId, ctx.workspaceId),
        eq(reviewItems.state, 'new'),
        eq(qualifications.isRelevant, true),
      ),
    )
    .orderBy(desc(qualifications.relevanceScore))
    .limit(settings.maxApprovalsPerRun);

  let approved = 0;
  for (const row of candidates) {
    if (row.q.relevanceScore < settings.autoApproveThreshold) continue;
    try {
      await approveReviewItem(ctx, row.ri.id);
      approved++;
      await recordStep(
        ctx,
        runId,
        'auto_approve_projects',
        'success',
        `score=${row.q.relevanceScore}`,
        'review_item',
        row.ri.id.toString(),
      );
    } catch (err) {
      await recordStep(
        ctx,
        runId,
        'auto_approve_projects',
        'error',
        err instanceof Error ? err.message : String(err),
        'review_item',
        row.ri.id.toString(),
      );
    }
  }
  return {
    step: 'auto_approve_projects',
    outcome: 'success',
    detail: `approved=${approved}/${candidates.length}`,
  };
}

async function stepAutoEnqueueOutreach(
  ctx: WorkspaceContext,
  runId: string,
  settings: AutopilotSettings,
): Promise<AutopilotRunResult['steps'][number]> {
  // Find approved review_items that have an active product profile but no
  // existing draft yet. Generate a draft + enqueue.
  const mailboxId = settings.defaultMailboxId
    ? settings.defaultMailboxId
    : (await defaultMailbox(ctx))?.id ?? null;
  if (!mailboxId) {
    await recordStep(ctx, runId, 'auto_enqueue_outreach', 'skipped', 'no default mailbox');
    return {
      step: 'auto_enqueue_outreach',
      outcome: 'skipped',
      detail: 'no default mailbox',
    };
  }
  const candidates = await db
    .select({ ri: reviewItems, q: qualifications })
    .from(reviewItems)
    .innerJoin(
      qualifications,
      and(
        eq(qualifications.workspaceId, reviewItems.workspaceId),
        eq(qualifications.sourceRecordId, reviewItems.sourceRecordId),
      ),
    )
    .where(
      and(
        eq(reviewItems.workspaceId, ctx.workspaceId),
        eq(reviewItems.state, 'approved'),
        eq(qualifications.isRelevant, true),
      ),
    )
    .limit(settings.maxEnqueuesPerRun);

  let enqueued = 0;
  for (const row of candidates) {
    // Skip if this (review_item, product) already has a non-superseded draft.
    const existing = await db
      .select({ id: outreachDrafts.id })
      .from(outreachDrafts)
      .where(
        and(
          eq(outreachDrafts.workspaceId, ctx.workspaceId),
          eq(outreachDrafts.reviewItemId, row.ri.id),
          eq(outreachDrafts.productProfileId, row.q.productProfileId),
          sql`${outreachDrafts.status} <> 'superseded'`,
        ),
      )
      .limit(1);
    if (existing[0]) continue;

    try {
      const draft = await generateOutreachDraft(ctx, {
        reviewItemId: row.ri.id,
        productProfileId: row.q.productProfileId,
        method: 'rules',
      });
      await enqueueDraft(ctx, { draftId: draft.id, mailboxId, delayMode: 'random' });
      enqueued++;
      await recordStep(
        ctx,
        runId,
        'auto_enqueue_outreach',
        'success',
        null,
        'outreach_draft',
        draft.id.toString(),
      );
    } catch (err) {
      await recordStep(
        ctx,
        runId,
        'auto_enqueue_outreach',
        'error',
        err instanceof Error ? err.message : String(err),
        'review_item',
        row.ri.id.toString(),
      );
    }
  }
  return {
    step: 'auto_enqueue_outreach',
    outcome: 'success',
    detail: `enqueued=${enqueued}/${candidates.length}`,
  };
}

async function stepAutoDrainQueue(
  ctx: WorkspaceContext,
  runId: string,
  providerOverride: IMailProvider | undefined,
): Promise<AutopilotRunResult['steps'][number]> {
  // The queue's own daily-cap + suppression + cooldown checks apply;
  // autopilot just calls drainQueue.
  await getSendSettings(ctx); // ensure row exists
  try {
    const r = await drainQueue(ctx, { providerOverride });
    await recordStep(
      ctx,
      runId,
      'auto_drain_queue',
      'success',
      `picked=${r.picked} sent=${r.sent} skipped=${r.skipped} failed=${r.failed}`,
    );
    return {
      step: 'auto_drain_queue',
      outcome: 'success',
      detail: `picked=${r.picked} sent=${r.sent}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await recordStep(ctx, runId, 'auto_drain_queue', 'error', detail);
    return { step: 'auto_drain_queue', outcome: 'error', detail };
  }
}

async function stepAutoCrmContactSync(
  ctx: WorkspaceContext,
  runId: string,
  settings: AutopilotSettings,
): Promise<AutopilotRunResult['steps'][number]> {
  const conns = await listCrmConnections(ctx);
  const conn = settings.defaultCrmConnectionId
    ? conns.find((c) => c.id === settings.defaultCrmConnectionId)
    : conns.find((c) => c.status === 'active' && c.system === 'hubspot');
  if (!conn) {
    await recordStep(ctx, runId, 'auto_crm_contact_sync', 'skipped', 'no active CRM connection');
    return {
      step: 'auto_crm_contact_sync',
      outcome: 'skipped',
      detail: 'no active CRM connection',
    };
  }

  // Sync leads at qualified or beyond that haven't synced yet.
  const candidates = await db
    .select()
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        sql`${qualifiedLeads.state} IN ('qualified', 'handed_over')`,
      ),
    )
    .limit(50);

  let synced = 0;
  for (const lead of candidates) {
    try {
      const r = await pushLeadToCrm(ctx, {
        connectionId: conn.id,
        leadId: lead.id,
        advanceState: false,
      });
      if (r.entry.outcome === 'succeeded') synced++;
      await recordStep(
        ctx,
        runId,
        'auto_crm_contact_sync',
        r.entry.outcome === 'succeeded' ? 'success' : 'error',
        r.entry.error ?? null,
        'qualified_lead',
        lead.id.toString(),
      );
    } catch (err) {
      await recordStep(
        ctx,
        runId,
        'auto_crm_contact_sync',
        'error',
        err instanceof Error ? err.message : String(err),
        'qualified_lead',
        lead.id.toString(),
      );
    }
  }
  return {
    step: 'auto_crm_contact_sync',
    outcome: 'success',
    detail: `synced=${synced}/${candidates.length}`,
  };
}

async function stepAutoCrmDealOnQualified(
  ctx: WorkspaceContext,
  runId: string,
  settings: AutopilotSettings,
): Promise<AutopilotRunResult['steps'][number]> {
  const conns = await listCrmConnections(ctx);
  const conn = settings.defaultCrmConnectionId
    ? conns.find((c) => c.id === settings.defaultCrmConnectionId)
    : conns.find((c) => c.status === 'active' && c.system === 'hubspot');
  if (!conn) {
    await recordStep(ctx, runId, 'auto_crm_deal_on_qualified', 'skipped', 'no active CRM connection');
    return {
      step: 'auto_crm_deal_on_qualified',
      outcome: 'skipped',
      detail: 'no active CRM connection',
    };
  }

  const candidates = await db
    .select()
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.state, 'qualified'),
      ),
    )
    .limit(50);

  let created = 0;
  for (const lead of candidates) {
    try {
      const r = await pushDeal(ctx, {
        connectionId: conn.id,
        leadId: lead.id,
      });
      if (r.entry.outcome === 'succeeded') created++;
      await recordStep(
        ctx,
        runId,
        'auto_crm_deal_on_qualified',
        r.entry.outcome === 'succeeded' ? 'success' : 'error',
        r.entry.error ?? null,
        'qualified_lead',
        lead.id.toString(),
      );
    } catch (err) {
      await recordStep(
        ctx,
        runId,
        'auto_crm_deal_on_qualified',
        'error',
        err instanceof Error ? err.message : String(err),
        'qualified_lead',
        lead.id.toString(),
      );
    }
  }
  return {
    step: 'auto_crm_deal_on_qualified',
    outcome: 'success',
    detail: `created=${created}/${candidates.length}`,
  };
}

// ---- log + read --------------------------------------------------

async function recordStep(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  runId: string,
  step: string,
  outcome: 'success' | 'skipped' | 'error',
  detail: string | null,
  entityType?: string,
  entityId?: string,
): Promise<void> {
  await db.insert(autopilotLog).values({
    workspaceId: ctx.workspaceId,
    runId,
    step,
    outcome,
    detail,
    entityType: entityType ?? null,
    entityId: entityId ?? null,
  });
}

export async function listAutopilotLog(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  limit = 100,
): Promise<AutopilotLogEntry[]> {
  return db
    .select()
    .from(autopilotLog)
    .where(eq(autopilotLog.workspaceId, ctx.workspaceId))
    .orderBy(desc(autopilotLog.createdAt))
    .limit(Math.min(limit, 1000));
}

void mailboxes;
