// Outreach draft service. Generates / persists drafts, manages lifecycle
// transitions, joins to source record + product + review_item.
//
// Generation flow:
//   1. resolve & verify the (review_item, product_profile) pair lives in
//      this workspace
//   2. retrieve outreach-relevant lessons (workspace-wide + product-scoped)
//   3. compose via the engine (rules or AI)
//   4. mark prior non-superseded drafts for the pair as superseded
//   5. insert the new draft row, audit-log
//
// Phase 8 stops at status=approved. Sending is later.

import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { sourceRecords, type SourceRecord } from '@/lib/db/schema/connectors';
import { productProfiles, type ProductProfile } from '@/lib/db/schema/products';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems, type ReviewItem } from '@/lib/db/schema/review';
import {
  outreachDrafts,
  type NewOutreachDraft,
  type OutreachDraft,
  type OutreachDraftMethod,
  type OutreachDraftStatus,
} from '@/lib/db/schema/outreach';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, canWrite, type WorkspaceContext } from './context';
import { getRelevantLessons } from './learning';
import {
  composeAiDraft,
  composeDiscoveryDraft,
  composeRulesDraft,
  type DraftVerdict,
} from './outreach-engine';
import type { OutreachStage } from '@/lib/db/schema/outreach';
import { getAIProviderForCtx } from '@/lib/ai';
import { resolveProfileLanguage } from '@/lib/i18n/language';

export class OutreachServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OutreachServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new OutreachServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = (kind: string) =>
  new OutreachServiceError(`${kind} not found`, 'not_found');
const invariant = (msg: string) =>
  new OutreachServiceError(msg, 'invariant_violation');
const invalid = (msg: string) =>
  new OutreachServiceError(msg, 'invalid_input');
const conflict = (msg: string) =>
  new OutreachServiceError(msg, 'conflict');

const TERMINAL_STATUSES = new Set<OutreachDraftStatus>([
  'approved',
  'rejected',
  'superseded',
]);

// ---- generate -------------------------------------------------------

export interface GenerateOutreachDraftInput {
  reviewItemId: bigint;
  productProfileId: bigint;
  /** Defaults: 'email'. */
  channel?: string;
  /** Defaults to product.language. */
  language?: string;
  /** Defaults to 'rules' to preserve determinism. */
  method?: OutreachDraftMethod;
}

export async function generateOutreachDraft(
  ctx: WorkspaceContext,
  input: GenerateOutreachDraftInput,
): Promise<OutreachDraft> {
  if (!canWrite(ctx)) throw permissionDenied('outreach.generate');

  const { reviewItem, sourceRecord, product, qualificationId } =
    await resolvePair(ctx, input.reviewItemId, input.productProfileId);

  if (!product.active) throw invalid('product profile is archived');

  const lessons = await getRelevantLessons(ctx, {
    productProfileId: product.id,
    taskType: 'outreach',
  });
  const wsLessons = await getRelevantLessons(ctx, {
    productProfileId: null,
    taskType: 'outreach',
  });
  const allLessons = [...lessons, ...wsLessons];

  const channel = input.channel?.trim() || 'email';
  // Detector cascade: input override → product description / instructions →
  // explicit product.language → 'en'. See src/lib/i18n/language.ts.
  const language = input.language?.trim() || resolveProfileLanguage(product);
  // Default to 'hybrid': use AI when a real provider is configured,
  // fall back to deterministic rules when only the mock provider is
  // available. The earlier 'rules' default was an artifact of Phase 8
  // (pre-BYOK) and produced drafts that pasted outreachInstructions
  // (meta-guidance for an AI) directly into the email body.
  const method: OutreachDraftMethod = input.method ?? 'hybrid';

  // Phase 46: optional research enrichment. When the product has the
  // flag on AND we're generating an AI/hybrid draft AND there's a
  // qualified lead for this (review_item, product), run the research
  // provider once via the lead-research cache. Best-effort — failures
  // log + continue without enrichment so generation never breaks.
  let researchContext: string | null = null;
  let researchEntryId: bigint | null = null;
  if (
    product.enrichDraftsWithResearch &&
    (method === 'ai' || method === 'hybrid')
  ) {
    try {
      const lead = await findQualifiedLeadForPair(ctx, reviewItem.id, product.id);
      if (lead) {
        const question = renderResearchTemplate(
          product.researchQuestionTemplate,
          lead,
          sourceRecord,
        );
        const { researchLead } = await import('./lead-research');
        const r = await researchLead(ctx, {
          qualifiedLeadId: lead.id,
          question,
        });
        researchContext = formatResearchAsContext(
          r.entry.answer,
          r.entry.citations as unknown as Array<{ url: string; title: string; domain: string }>,
        );
        researchEntryId = r.entry.id;
      }
    } catch (err) {
      console.error('[outreach] research enrichment failed (best-effort, continuing):', err);
    }
  }

  // Phase A: pick the stage from the active qualified-lead row, or
  // default to 'discovery' when this is the very first contact for the
  // (review_item, product) pair. The discovery composer produces a
  // short ask-for-the-right-person email; engagement / pitch / closing
  // route through the existing AI/rules path until Phase C.
  const lead = await findQualifiedLeadForPair(ctx, reviewItem.id, product.id);
  const stage: OutreachStage =
    (lead?.currentStage as OutreachStage | undefined) ?? 'discovery';

  const verdict = await composeVerdict(
    method,
    stage,
    sourceRecord,
    product,
    allLessons,
    { channel, language },
    ctx,
    researchContext,
  );

  // Insert with supersede in one transaction. The partial unique index
  // forbids two non-superseded drafts for the same pair.
  const inserted = await db.transaction(async (tx) => {
    await tx
      .update(outreachDrafts)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(
        and(
          eq(outreachDrafts.workspaceId, ctx.workspaceId),
          eq(outreachDrafts.reviewItemId, reviewItem.id),
          eq(outreachDrafts.productProfileId, product.id),
        ),
      );

    const row: NewOutreachDraft = {
      workspaceId: ctx.workspaceId,
      reviewItemId: reviewItem.id,
      sourceRecordId: sourceRecord.id,
      productProfileId: product.id,
      qualificationId: qualificationId ?? null,
      status: 'draft',
      stage,
      channel,
      language,
      subject: verdict.subject,
      body: verdict.body,
      confidence: verdict.confidence,
      method: verdict.method,
      model: verdict.model,
      evidence: {
        ...serializeEvidence(verdict),
        researchEntryId: researchEntryId?.toString() ?? null,
      },
      forbiddenStripped: verdict.forbiddenStripped,
      matchedLessonIds: verdict.matchedLessonIds,
      createdBy: ctx.userId,
    };

    const [created] = await tx
      .insert(outreachDrafts)
      .values(row)
      .returning();
    if (!created) throw invariant('outreach_draft insert returned no row');
    return created;
  });

  await recordAuditEvent(ctx, {
    kind: 'outreach.generate',
    entityType: 'outreach_draft',
    entityId: inserted.id,
    payload: {
      reviewItemId: reviewItem.id.toString(),
      productProfileId: product.id.toString(),
      method: verdict.method,
      forbiddenStripped: verdict.forbiddenStripped,
      lessons: verdict.matchedLessonIds.map((id) => id.toString()),
    },
  });

  return inserted;
}

// ---- read -----------------------------------------------------------

export interface ListOutreachDraftsFilter {
  status?: OutreachDraftStatus | readonly OutreachDraftStatus[];
  productProfileId?: bigint;
  reviewItemId?: bigint;
  /** Default true — exclude superseded drafts unless caller asks. */
  excludeSuperseded?: boolean;
  limit?: number;
}

export interface OutreachDraftRow {
  draft: OutreachDraft;
  product: ProductProfile;
  sourceRecord: SourceRecord;
  reviewItem: ReviewItem;
}

export async function listOutreachDrafts(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListOutreachDraftsFilter = {},
): Promise<OutreachDraftRow[]> {
  const conditions: SQL[] = [eq(outreachDrafts.workspaceId, ctx.workspaceId)];

  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status)
      ? (filter.status as OutreachDraftStatus[])
      : [filter.status as OutreachDraftStatus];
    conditions.push(inArray(outreachDrafts.status, statuses));
  } else if (filter.excludeSuperseded !== false) {
    conditions.push(
      inArray(outreachDrafts.status, [
        'draft',
        'needs_edit',
        'approved',
        'rejected',
      ]),
    );
  }

  if (filter.productProfileId !== undefined) {
    conditions.push(eq(outreachDrafts.productProfileId, filter.productProfileId));
  }
  if (filter.reviewItemId !== undefined) {
    conditions.push(eq(outreachDrafts.reviewItemId, filter.reviewItemId));
  }

  const limit = Math.min(filter.limit ?? 200, 1000);

  const rows = await db
    .select({
      draft: outreachDrafts,
      product: productProfiles,
      sourceRecord: sourceRecords,
      reviewItem: reviewItems,
    })
    .from(outreachDrafts)
    .innerJoin(productProfiles, eq(productProfiles.id, outreachDrafts.productProfileId))
    .innerJoin(sourceRecords, eq(sourceRecords.id, outreachDrafts.sourceRecordId))
    .innerJoin(reviewItems, eq(reviewItems.id, outreachDrafts.reviewItemId))
    .where(and(...conditions))
    .orderBy(desc(outreachDrafts.createdAt))
    .limit(limit);

  return rows;
}

export async function getOutreachDraft(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<OutreachDraftRow> {
  const rows = await db
    .select({
      draft: outreachDrafts,
      product: productProfiles,
      sourceRecord: sourceRecords,
      reviewItem: reviewItems,
    })
    .from(outreachDrafts)
    .innerJoin(productProfiles, eq(productProfiles.id, outreachDrafts.productProfileId))
    .innerJoin(sourceRecords, eq(sourceRecords.id, outreachDrafts.sourceRecordId))
    .innerJoin(reviewItems, eq(reviewItems.id, outreachDrafts.reviewItemId))
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.id, id),
      ),
    );
  if (!rows[0]) throw notFound('outreach_draft');
  return rows[0];
}

/** Most-recent active draft for a (review_item, product) pair, or null. */
export async function activeDraftFor(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  reviewItemId: bigint,
  productProfileId: bigint,
): Promise<OutreachDraft | null> {
  const rows = await db
    .select()
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.reviewItemId, reviewItemId),
        eq(outreachDrafts.productProfileId, productProfileId),
        inArray(outreachDrafts.status, [
          'draft',
          'needs_edit',
          'approved',
          'rejected',
        ]),
      ),
    )
    .orderBy(desc(outreachDrafts.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

// ---- mutate ---------------------------------------------------------

export interface EditOutreachDraftInput {
  subject?: string | null;
  body?: string;
  channel?: string;
  language?: string;
}

export async function editOutreachDraft(
  ctx: WorkspaceContext,
  id: bigint,
  input: EditOutreachDraftInput,
): Promise<OutreachDraft> {
  if (!canWrite(ctx)) throw permissionDenied('outreach.edit');
  const existing = await loadDraft(ctx, id);
  if (TERMINAL_STATUSES.has(existing.status)) {
    throw conflict(`cannot edit draft in terminal status ${existing.status}`);
  }
  // Forbidden phrase enforcement on user-supplied edits — strip silently
  // but record what was removed.
  const product = await loadProduct(ctx, existing.productProfileId);
  let stripped: string[] = [];
  let nextBody = existing.body;
  if (input.body !== undefined) {
    const out = stripForbidden(input.body, product.forbiddenPhrases);
    nextBody = out.text;
    stripped = out.removed;
  }

  const updates: Partial<OutreachDraft> & { updatedAt: Date } = {
    updatedAt: new Date(),
    editedByUserId: ctx.userId,
    editedAt: new Date(),
    status: 'needs_edit',
  };
  if (input.subject !== undefined) updates.subject = input.subject;
  if (input.body !== undefined) updates.body = nextBody;
  if (input.channel !== undefined) updates.channel = input.channel;
  if (input.language !== undefined) updates.language = input.language;
  if (stripped.length > 0) {
    updates.forbiddenStripped = [
      ...existing.forbiddenStripped,
      ...stripped,
    ];
  }

  const [updated] = await db
    .update(outreachDrafts)
    .set(updates)
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('outreach_draft update returned no row');

  await recordAuditEvent(ctx, {
    kind: 'outreach.edit',
    entityType: 'outreach_draft',
    entityId: id,
    payload: {
      changedSubject: input.subject !== undefined,
      changedBody: input.body !== undefined,
      forbiddenStripped: stripped,
    },
  });

  return updated;
}

export async function approveOutreachDraft(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<OutreachDraft> {
  if (!canWrite(ctx)) throw permissionDenied('outreach.approve');
  const existing = await loadDraft(ctx, id);
  if (TERMINAL_STATUSES.has(existing.status)) {
    throw conflict(`cannot approve draft in terminal status ${existing.status}`);
  }
  const [updated] = await db
    .update(outreachDrafts)
    .set({
      status: 'approved',
      approvedByUserId: ctx.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('outreach_draft approve returned no row');
  await recordAuditEvent(ctx, {
    kind: 'outreach.approve',
    entityType: 'outreach_draft',
    entityId: id,
  });
  return updated;
}

export async function rejectOutreachDraft(
  ctx: WorkspaceContext,
  id: bigint,
  reason: string | null,
): Promise<OutreachDraft> {
  if (!canWrite(ctx)) throw permissionDenied('outreach.reject');
  const existing = await loadDraft(ctx, id);
  if (TERMINAL_STATUSES.has(existing.status)) {
    throw conflict(`cannot reject draft in terminal status ${existing.status}`);
  }
  const trimmed = reason?.trim() || null;
  const [updated] = await db
    .update(outreachDrafts)
    .set({
      status: 'rejected',
      rejectionReason: trimmed,
      rejectedByUserId: ctx.userId,
      rejectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('outreach_draft reject returned no row');
  await recordAuditEvent(ctx, {
    kind: 'outreach.reject',
    entityType: 'outreach_draft',
    entityId: id,
    payload: { reason: trimmed },
  });
  return updated;
}

export async function archiveOutreachDraft(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<OutreachDraft> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('outreach.archive');
  const existing = await loadDraft(ctx, id);
  // Mark as superseded — the closest "removed but kept" state we have.
  const [updated] = await db
    .update(outreachDrafts)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.id, id),
      ),
    )
    .returning();
  if (!updated) throw invariant('outreach_draft archive returned no row');
  await recordAuditEvent(ctx, {
    kind: 'outreach.archive',
    entityType: 'outreach_draft',
    entityId: id,
    payload: { previousStatus: existing.status },
  });
  return updated;
}

// ---- internals ------------------------------------------------------

interface ResolvedPair {
  reviewItem: ReviewItem;
  sourceRecord: SourceRecord;
  product: ProductProfile;
  qualificationId: bigint | null;
}

async function resolvePair(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  reviewItemId: bigint,
  productProfileId: bigint,
): Promise<ResolvedPair> {
  const rows = await db
    .select({
      reviewItem: reviewItems,
      sourceRecord: sourceRecords,
      product: productProfiles,
    })
    .from(reviewItems)
    .innerJoin(sourceRecords, eq(sourceRecords.id, reviewItems.sourceRecordId))
    .innerJoin(productProfiles, eq(productProfiles.id, productProfileId))
    .where(
      and(
        eq(reviewItems.workspaceId, ctx.workspaceId),
        eq(reviewItems.id, reviewItemId),
        eq(productProfiles.workspaceId, ctx.workspaceId),
      ),
    );
  if (!rows[0]) throw notFound('review_item or product_profile');

  const qualRows = await db
    .select()
    .from(qualifications)
    .where(
      and(
        eq(qualifications.workspaceId, ctx.workspaceId),
        eq(qualifications.sourceRecordId, rows[0].sourceRecord.id),
        eq(qualifications.productProfileId, productProfileId),
      ),
    )
    .limit(1);

  return {
    reviewItem: rows[0].reviewItem,
    sourceRecord: rows[0].sourceRecord,
    product: rows[0].product,
    qualificationId: qualRows[0]?.id ?? null,
  };
}

async function loadDraft(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<OutreachDraft> {
  const rows = await db
    .select()
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound('outreach_draft');
  return rows[0];
}

async function loadProduct(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<ProductProfile> {
  const rows = await db
    .select()
    .from(productProfiles)
    .where(
      and(
        eq(productProfiles.workspaceId, ctx.workspaceId),
        eq(productProfiles.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound('product_profile');
  return rows[0];
}

function extractDraftable(record: SourceRecord) {
  const normalized = record.normalizedData as Record<string, unknown>;
  return {
    title: typeof normalized.title === 'string' ? normalized.title : null,
    snippet: typeof normalized.snippet === 'string' ? normalized.snippet : null,
    url: typeof normalized.url === 'string' ? normalized.url : record.sourceUrl ?? null,
    domain: typeof normalized.domain === 'string' ? normalized.domain : null,
    body: typeof normalized.body === 'string' ? normalized.body : null,
  };
}

async function composeVerdict(
  method: OutreachDraftMethod,
  stage: OutreachStage,
  sourceRecord: SourceRecord,
  product: ProductProfile,
  lessons: ReadonlyArray<import('@/lib/db/schema/learning').LearningLesson>,
  cfg: { channel: string; language: string },
  workspaceCtx: WorkspaceContext,
  researchContext: string | null = null,
): Promise<DraftVerdict> {
  const draftable = extractDraftable(sourceRecord);

  // Phase A: discovery-stage drafts always go through the dedicated
  // composer (short ask-for-the-right-person email, never a pitch).
  // Mock provider users get rules-mode for their dev loop, same as
  // the engagement path below — discovery via the mock would just
  // produce hashed nonsense.
  if (stage === 'discovery') {
    const ai = await getAIProviderForCtx(workspaceCtx);
    if (ai.id === 'mock') {
      return composeRulesDraft(draftable, product, lessons, cfg);
    }
    return composeDiscoveryDraft(draftable, product, cfg, ai);
  }

  // engagement / pitch / closing route through the existing AI/rules
  // path until Phase C ships the in-thread composers. Backwards-
  // compatible: every existing in-flight draft is at engagement stage.
  if (method === 'rules') {
    return composeRulesDraft(draftable, product, lessons, cfg);
  }
  if (method === 'ai') {
    const ai = await getAIProviderForCtx(workspaceCtx);
    return composeAiDraft(draftable, product, lessons, cfg, ai, researchContext);
  }
  if (method === 'hybrid') {
    // Phase 33: hybrid = rules-scaffold subject + AI-rewritten body when
    // a real provider is configured; falls back to pure rules when only
    // the mock provider is available.
    const ai = await getAIProviderForCtx(workspaceCtx);
    if (ai.id === 'mock') {
      return composeRulesDraft(draftable, product, lessons, cfg);
    }
    return composeAiDraft(draftable, product, lessons, cfg, ai, researchContext);
  }
  throw invalid(`unknown method: ${method}`);
}

/** Look up the qualified lead for a (review_item, product) pair, if one
 *  exists. Returns null when the review item hasn't been promoted yet —
 *  in that case research enrichment is skipped (no lead to attach the
 *  cached research to). */
async function findQualifiedLeadForPair(
  ctx: WorkspaceContext,
  reviewItemId: bigint,
  productProfileId: bigint,
): Promise<{
  id: bigint;
  contactEmail: string | null;
  currentStage: string;
} | null> {
  const { qualifiedLeads } = await import('@/lib/db/schema/pipeline');
  const rows = await db
    .select({
      id: qualifiedLeads.id,
      contactEmail: qualifiedLeads.contactEmail,
      currentStage: qualifiedLeads.currentStage,
    })
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.reviewItemId, reviewItemId),
        eq(qualifiedLeads.productProfileId, productProfileId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function renderResearchTemplate(
  template: string,
  lead: { contactEmail: string | null },
  sourceRecord: SourceRecord,
): string {
  const norm = sourceRecord.normalizedData as Record<string, unknown>;
  const recordDomain =
    typeof norm.domain === 'string' ? norm.domain : null;
  const recordTitle =
    typeof norm.title === 'string' ? norm.title : null;
  const emailDomain =
    lead.contactEmail?.split('@')[1]?.trim().toLowerCase() ?? null;
  const domain =
    emailDomain || recordDomain || '(domain unknown)';
  // Best-effort 'company' label: title from the source record (often a
  // company name on directory hits), else the domain itself.
  const company = recordTitle?.trim() || domain;
  return template
    .replaceAll('{company}', company)
    .replaceAll('{domain}', domain);
}

function formatResearchAsContext(
  answer: string,
  citations: ReadonlyArray<{ url: string; title?: string; domain?: string }>,
): string {
  const top = citations.slice(0, 3);
  const sources = top
    .map((c, i) => `  [${i + 1}] ${c.title || c.domain || c.url} — ${c.url}`)
    .join('\n');
  if (sources) return `${answer.trim()}\n\nSources:\n${sources}`;
  return answer.trim();
}

function serializeEvidence(verdict: DraftVerdict): Record<string, unknown> {
  return {
    method: verdict.method,
    model: verdict.model,
    fields: verdict.evidence.fields,
    matchedLessonIds: verdict.evidence.matchedLessonIds.map((id) => id.toString()),
    promptSystem: verdict.evidence.promptSystem,
    promptUser: verdict.evidence.promptUser,
  };
}

function stripForbidden(text: string, phrases: ReadonlyArray<string>): { text: string; removed: string[] } {
  if (phrases.length === 0 || !text) return { text, removed: [] };
  let out = text;
  const removed: string[] = [];
  for (const raw of phrases) {
    const phrase = raw.trim();
    if (!phrase) continue;
    const re = new RegExp(escapeRegex(phrase), 'gi');
    if (re.test(out)) {
      removed.push(phrase);
      out = out.replace(re, '[redacted]');
    }
  }
  out = out.replace(/[ \t]{2,}/g, ' ');
  return { text: out, removed };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// re-export
export { composeAiDraft, composeRulesDraft } from './outreach-engine';
export type { DraftableRecord, DraftVerdict } from './outreach-engine';
