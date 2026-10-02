// Autopilot orchestrator. One runOnce(ctx) cycles through the autopilot
// steps, each gated by the per-workspace autopilot_settings row. Every
// step records 1+ rows on autopilot_log keyed by a shared runId so the UI
// + future operator dashboards can replay what happened.
//
// All steps lean on existing services so the autopilot stays a thin
// orchestrator: it never reaches into the DB to do work that already has
// a service entry point.

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db/client';
import { productProfiles } from '@/lib/db/schema/products';
import {
  autopilotLog,
  autopilotProductSettings,
  autopilotSettings,
  type AutopilotLogEntry,
  type AutopilotProductSettings,
  type AutopilotSettings,
  type NewAutopilotProductSettings,
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
import { autopilotApproveReviewItem } from './review';
import { approveOutreachDraft, generateOutreachDraft } from './outreach';
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
  // Autopilot is a subscription feature. Only ENABLING is gated —
  // turning things off (incl. emergencyPause) must always work, so a
  // lapsed subscription can still stop automation.
  const enabling =
    input.autopilotEnabled === true ||
    input.enableAutoApproveProjects === true ||
    input.enableAutoEnqueueOutreach === true ||
    input.enableAutoDrainQueue === true ||
    input.enableAutoSyncInbound === true ||
    input.enableAutoCrmContactSync === true ||
    input.enableAutoCrmDealOnQualified === true;
  if (enabling) {
    const { assertAutopilotAllowed } = await import('./plan-limits');
    await assertAutopilotAllowed(ctx);
  }
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

// ---- per-product overlay (Phase 27) -------------------------------

/**
 * Effective settings for a given product. Workspace defaults, then any
 * non-null column from the product overlay wins. Workspace-only fields
 * (max*PerRun, defaultCrmConnectionId, default mailbox fallback when
 * overlay omits) are always taken from the workspace row.
 */
export type EffectiveAutopilotSettings = AutopilotSettings;

export async function getEffectiveAutopilotSettings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  productProfileId: bigint,
): Promise<EffectiveAutopilotSettings> {
  const base = await getAutopilotSettings(ctx);
  const overlayRows = await db
    .select()
    .from(autopilotProductSettings)
    .where(
      and(
        eq(autopilotProductSettings.workspaceId, ctx.workspaceId),
        eq(autopilotProductSettings.productProfileId, productProfileId),
      ),
    )
    .limit(1);
  const overlay = overlayRows[0];
  if (!overlay) return base;
  return {
    ...base,
    autopilotEnabled: overlay.autopilotEnabled ?? base.autopilotEnabled,
    emergencyPause: overlay.emergencyPause ?? base.emergencyPause,
    enableAutoApproveProjects:
      overlay.enableAutoApproveProjects ?? base.enableAutoApproveProjects,
    autoApproveThreshold:
      overlay.autoApproveThreshold ?? base.autoApproveThreshold,
    enableAutoEnqueueOutreach:
      overlay.enableAutoEnqueueOutreach ?? base.enableAutoEnqueueOutreach,
    enableAutoCrmContactSync:
      overlay.enableAutoCrmContactSync ?? base.enableAutoCrmContactSync,
    enableAutoCrmDealOnQualified:
      overlay.enableAutoCrmDealOnQualified ?? base.enableAutoCrmDealOnQualified,
    defaultMailboxId: overlay.defaultMailboxId ?? base.defaultMailboxId,
  };
}

export async function listProductAutopilotSettings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<AutopilotProductSettings[]> {
  return db
    .select()
    .from(autopilotProductSettings)
    .where(eq(autopilotProductSettings.workspaceId, ctx.workspaceId));
}

export async function getProductAutopilotSettings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  productProfileId: bigint,
): Promise<AutopilotProductSettings | null> {
  const rows = await db
    .select()
    .from(autopilotProductSettings)
    .where(
      and(
        eq(autopilotProductSettings.workspaceId, ctx.workspaceId),
        eq(autopilotProductSettings.productProfileId, productProfileId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface UpsertProductAutopilotSettingsInput {
  productProfileId: bigint;
  /** Pass null to clear an override; pass a value to set it. Omit to leave alone. */
  autopilotEnabled?: boolean | null;
  emergencyPause?: boolean | null;
  enableAutoApproveProjects?: boolean | null;
  autoApproveThreshold?: number | null;
  enableAutoEnqueueOutreach?: boolean | null;
  enableAutoCrmContactSync?: boolean | null;
  enableAutoCrmDealOnQualified?: boolean | null;
  defaultMailboxId?: bigint | null;
}

export async function upsertProductAutopilotSettings(
  ctx: WorkspaceContext,
  input: UpsertProductAutopilotSettingsInput,
): Promise<AutopilotProductSettings> {
  if (!canAdminWorkspace(ctx)) throw denied('autopilot.product_settings.update');
  const existing = await getProductAutopilotSettings(ctx, input.productProfileId);
  const merged: NewAutopilotProductSettings = {
    workspaceId: ctx.workspaceId,
    productProfileId: input.productProfileId,
    autopilotEnabled:
      input.autopilotEnabled !== undefined
        ? input.autopilotEnabled
        : existing?.autopilotEnabled ?? null,
    emergencyPause:
      input.emergencyPause !== undefined
        ? input.emergencyPause
        : existing?.emergencyPause ?? null,
    enableAutoApproveProjects:
      input.enableAutoApproveProjects !== undefined
        ? input.enableAutoApproveProjects
        : existing?.enableAutoApproveProjects ?? null,
    autoApproveThreshold:
      input.autoApproveThreshold !== undefined
        ? input.autoApproveThreshold === null
          ? null
          : clampInt(input.autoApproveThreshold, 0, 100)
        : existing?.autoApproveThreshold ?? null,
    enableAutoEnqueueOutreach:
      input.enableAutoEnqueueOutreach !== undefined
        ? input.enableAutoEnqueueOutreach
        : existing?.enableAutoEnqueueOutreach ?? null,
    enableAutoCrmContactSync:
      input.enableAutoCrmContactSync !== undefined
        ? input.enableAutoCrmContactSync
        : existing?.enableAutoCrmContactSync ?? null,
    enableAutoCrmDealOnQualified:
      input.enableAutoCrmDealOnQualified !== undefined
        ? input.enableAutoCrmDealOnQualified
        : existing?.enableAutoCrmDealOnQualified ?? null,
    defaultMailboxId:
      input.defaultMailboxId !== undefined
        ? input.defaultMailboxId
        : existing?.defaultMailboxId ?? null,
    updatedBy: ctx.userId,
    updatedAt: new Date(),
  };
  // jsonb can't serialize bigint — render to string for the audit payload.
  const auditPayload: Record<string, unknown> = {
    productProfileId: input.productProfileId.toString(),
    autopilotEnabled: input.autopilotEnabled ?? null,
    emergencyPause: input.emergencyPause ?? null,
    enableAutoApproveProjects: input.enableAutoApproveProjects ?? null,
    autoApproveThreshold: input.autoApproveThreshold ?? null,
    enableAutoEnqueueOutreach: input.enableAutoEnqueueOutreach ?? null,
    enableAutoCrmContactSync: input.enableAutoCrmContactSync ?? null,
    enableAutoCrmDealOnQualified: input.enableAutoCrmDealOnQualified ?? null,
    defaultMailboxId:
      input.defaultMailboxId === undefined
        ? undefined
        : input.defaultMailboxId === null
          ? null
          : input.defaultMailboxId.toString(),
  };
  if (existing) {
    const [updated] = await db
      .update(autopilotProductSettings)
      .set(merged)
      .where(eq(autopilotProductSettings.id, existing.id))
      .returning();
    if (!updated) {
      throw new AutopilotError(
        'product settings update returned no row',
        'invariant_violation',
      );
    }
    await recordAuditEvent(ctx, {
      kind: 'autopilot.product_settings.update',
      entityType: 'product_profile',
      entityId: input.productProfileId,
      payload: auditPayload,
    });
    return updated;
  }
  const [created] = await db
    .insert(autopilotProductSettings)
    .values(merged)
    .returning();
  if (!created) {
    throw new AutopilotError(
      'product settings insert returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'autopilot.product_settings.create',
    entityType: 'product_profile',
    entityId: input.productProfileId,
    payload: auditPayload,
  });
  return created;
}

export async function clearProductAutopilotSettings(
  ctx: WorkspaceContext,
  productProfileId: bigint,
): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw denied('autopilot.product_settings.clear');
  await db
    .delete(autopilotProductSettings)
    .where(
      and(
        eq(autopilotProductSettings.workspaceId, ctx.workspaceId),
        eq(autopilotProductSettings.productProfileId, productProfileId),
      ),
    );
  await recordAuditEvent(ctx, {
    kind: 'autopilot.product_settings.clear',
    entityType: 'product_profile',
    entityId: productProfileId,
  });
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

  // Plan guard: autopilot is a subscription feature. The toggle gate in
  // updateAutopilotSettings stops NEW enables, but a workspace that
  // enabled autopilot while subscribed and then lapsed would keep
  // running forever without this runtime check.
  {
    const { getEffectivePlan } = await import('./plan-limits');
    const plan = await getEffectivePlan(ctx);
    if (!plan.limits.autopilot) {
      await recordStep(ctx, runId, 'guard', 'skipped', 'plan_no_autopilot');
      steps.push({ step: 'guard', outcome: 'skipped', detail: 'plan_no_autopilot' });
      return { runId, ranAt, steps };
    }
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

/**
 * The qualifications that make a 'new' review item eligible for an
 * autopilot approval, as SQL (I018) — so LIMIT only ever counts eligible
 * rows: relevant; the product's auto-approve not switched off by its
 * overlay; the score at or above the effective threshold (overlay, else
 * the workspace's); and no operator verdict on ANY product of the record
 * (a person already decided — autopilot never second-guesses them). The
 * per-product master / emergency-pause overlays are not applied here, as
 * before (I020, handbook H-13).
 */
function autoApproveEligibility(ctx: WorkspaceContext, settings: AutopilotSettings) {
  const decided = alias(qualifications, 'q_decided');
  return and(
    eq(reviewItems.workspaceId, ctx.workspaceId),
    eq(reviewItems.state, 'new'),
    eq(qualifications.isRelevant, true),
    or(
      isNull(autopilotProductSettings.enableAutoApproveProjects),
      eq(autopilotProductSettings.enableAutoApproveProjects, true),
    ),
    gte(
      qualifications.relevanceScore,
      sql<number>`coalesce(${autopilotProductSettings.autoApproveThreshold}, ${settings.autoApproveThreshold})`,
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(decided)
        .where(
          and(
            eq(decided.workspaceId, reviewItems.workspaceId),
            eq(decided.sourceRecordId, reviewItems.sourceRecordId),
            isNotNull(decided.operatorVerdict),
          ),
        ),
    ),
  );
}

function eligibleQualifications() {
  return db
    .select({
      reviewItemId: reviewItems.id,
      productProfileId: qualifications.productProfileId,
      score: qualifications.relevanceScore,
    })
    .from(reviewItems)
    .innerJoin(
      qualifications,
      and(
        eq(qualifications.workspaceId, reviewItems.workspaceId),
        eq(qualifications.sourceRecordId, reviewItems.sourceRecordId),
      ),
    )
    .leftJoin(
      autopilotProductSettings,
      and(
        eq(autopilotProductSettings.workspaceId, qualifications.workspaceId),
        eq(autopilotProductSettings.productProfileId, qualifications.productProfileId),
      ),
    )
    .$dynamic();
}

async function stepAutoApproveProjects(
  ctx: WorkspaceContext,
  runId: string,
  settings: AutopilotSettings,
): Promise<AutopilotRunResult['steps'][number]> {
  const cap = settings.maxApprovalsPerRun;
  if (cap <= 0) {
    return { step: 'auto_approve_projects', outcome: 'success', detail: 'approved=0/0' };
  }
  // An item relevant to N products yields N rows; over-fetch cap × the
  // workspace's product count so the cap counts ITEMS, then de-duplicate
  // (best score first) and keep `cap` items.
  const [{ products } = { products: 1 }] = await db
    .select({ products: sql<number>`count(*)::int` })
    .from(productProfiles)
    .where(eq(productProfiles.workspaceId, ctx.workspaceId));
  const rows = await eligibleQualifications()
    .where(autoApproveEligibility(ctx, settings))
    .orderBy(desc(qualifications.relevanceScore), asc(reviewItems.id))
    .limit(Math.min(cap * Math.max(1, products), 50_000));
  const best = new Map<string, { id: bigint; score: number }>();
  for (const r of rows) {
    const key = r.reviewItemId.toString();
    if (!best.has(key)) best.set(key, { id: r.reviewItemId, score: r.score });
  }
  const selected = [...best.values()].slice(0, cap);
  if (selected.length === 0) {
    return { step: 'auto_approve_projects', outcome: 'success', detail: 'approved=0/0' };
  }
  // Every eligible product of each selected item: the approval is FOR
  // those products (one autopilot event each).
  const productRows = await eligibleQualifications().where(
    and(
      autoApproveEligibility(ctx, settings),
      inArray(
        reviewItems.id,
        selected.map((s) => s.id),
      ),
    ),
  );
  const productsByItem = new Map<string, bigint[]>();
  for (const r of productRows) {
    const key = r.reviewItemId.toString();
    productsByItem.set(key, [...(productsByItem.get(key) ?? []), r.productProfileId]);
  }

  let approved = 0;
  for (const item of selected) {
    const productIds = productsByItem.get(item.id.toString()) ?? [];
    try {
      const r = await autopilotApproveReviewItem(ctx, item.id, { runId, productProfileIds: productIds });
      if (r.approved) approved++;
      await recordStep(
        ctx,
        runId,
        'auto_approve_projects',
        r.approved ? 'success' : 'skipped',
        r.approved
          ? `score=${item.score} products=${productIds.join(',')}`
          : 'no longer new — left for the operator',
        'review_item',
        item.id.toString(),
      );
    } catch (err) {
      await recordStep(
        ctx,
        runId,
        'auto_approve_projects',
        'error',
        err instanceof Error ? err.message : String(err),
        'review_item',
        item.id.toString(),
      );
    }
  }
  return {
    step: 'auto_approve_projects',
    outcome: 'success',
    detail: `approved=${approved}/${selected.length}`,
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
        // KL-02: a pair the operator marked Not a fit is never drafted
        // (an approved item can carry mixed verdicts).
        or(isNull(qualifications.operatorVerdict), eq(qualifications.operatorVerdict, 'fit')),
      ),
    )
    .limit(settings.maxEnqueuesPerRun);

  let enqueued = 0;
  for (const row of candidates) {
    // Per-product overlay: skip if this product opts out of auto-enqueue.
    const eff = await getEffectiveAutopilotSettings(ctx, row.q.productProfileId);
    if (!eff.enableAutoEnqueueOutreach) continue;
    const productMailboxId = eff.defaultMailboxId ?? mailboxId;

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
      // The queue only accepts approved drafts. Auto-enqueue is an explicit
      // per-product opt-in, so approval here is attributed to the workspace
      // owner who enabled it — recorded on the draft AND in the run log.
      await approveOutreachDraft(ctx, draft.id);
      await enqueueDraft(ctx, {
        draftId: draft.id,
        mailboxId: productMailboxId,
        delayMode: 'random',
      });
      enqueued++;
      await recordStep(
        ctx,
        runId,
        'auto_enqueue_outreach',
        'success',
        `product=${row.q.productProfileId}`,
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
    // Per-product overlay: skip if the lead's product opts out.
    const eff = await getEffectiveAutopilotSettings(ctx, lead.productProfileId);
    if (!eff.enableAutoCrmContactSync) continue;
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
    // Per-product overlay.
    const eff = await getEffectiveAutopilotSettings(ctx, lead.productProfileId);
    if (!eff.enableAutoCrmDealOnQualified) continue;
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
