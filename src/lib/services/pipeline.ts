// Pipeline service. State machine on top of qualified_leads + an
// append-only pipeline_events log. All mutations route here so transitions,
// validations, and audit happen in exactly one place.

import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { productProfiles, type ProductProfile } from '@/lib/db/schema/products';
import { reviewItems, type ReviewItem } from '@/lib/db/schema/review';
import {
  pipelineEvents,
  qualifiedLeads,
  type CloseReason,
  type NewPipelineEvent,
  type NewQualifiedLead,
  type PipelineEvent,
  type PipelineState,
  type QualifiedLead,
} from '@/lib/db/schema/pipeline';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';

export class PipelineServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'PipelineServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new PipelineServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = (kind: string) =>
  new PipelineServiceError(`${kind} not found`, 'not_found');
const invariant = (msg: string) =>
  new PipelineServiceError(msg, 'invariant_violation');
const invalid = (msg: string) =>
  new PipelineServiceError(msg, 'invalid_input');
const conflict = (msg: string) =>
  new PipelineServiceError(msg, 'conflict');

// ---- state machine -------------------------------------------------

const FORWARD: Record<PipelineState, ReadonlyArray<PipelineState>> = {
  raw_discovered: ['relevant', 'closed'],
  relevant: ['contacted', 'closed'],
  contacted: ['replied', 'closed'],
  replied: ['contact_identified', 'closed'],
  contact_identified: ['qualified', 'closed'],
  qualified: ['handed_over', 'closed'],
  handed_over: ['synced_to_crm', 'closed'],
  synced_to_crm: ['closed'],
  closed: [],
};

/**
 * Allowed transitions in the canonical forward direction. Backwards moves
 * (correction) are gated behind canAdminWorkspace and `force=true`.
 */
function isForwardTransition(from: PipelineState, to: PipelineState): boolean {
  if (from === to) return false;
  return FORWARD[from].includes(to);
}

const STATE_TIMESTAMP_COLUMN: Record<PipelineState, keyof QualifiedLead | null> = {
  raw_discovered: null,
  relevant: 'relevantAt',
  contacted: 'contactedAt',
  replied: 'repliedAt',
  contact_identified: 'contactIdentifiedAt',
  qualified: 'qualifiedAt',
  handed_over: 'handedOverAt',
  synced_to_crm: 'syncedAt',
  closed: 'closedAt',
};

// ---- create / ensure -----------------------------------------------

/**
 * Create or return the existing qualified-lead row for a (review_item,
 * product) pair. Idempotent — the second call returns the same row. Used
 * both by manual promotion and by future automation hooks.
 */
export async function ensureQualifiedLead(
  ctx: WorkspaceContext,
  reviewItemId: bigint,
  productProfileId: bigint,
  initialState: PipelineState = 'relevant',
): Promise<QualifiedLead> {
  if (!canWrite(ctx)) throw permissionDenied('pipeline.ensure');

  const existing = await db
    .select()
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.reviewItemId, reviewItemId),
        eq(qualifiedLeads.productProfileId, productProfileId),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  // Verify the pair is in the workspace.
  const pair = await db
    .select({ ri: reviewItems, pp: productProfiles })
    .from(reviewItems)
    .innerJoin(productProfiles, eq(productProfiles.id, productProfileId))
    .where(
      and(
        eq(reviewItems.workspaceId, ctx.workspaceId),
        eq(reviewItems.id, reviewItemId),
        eq(productProfiles.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (!pair[0]) throw notFound('review_item or product_profile');

  const now = new Date();
  const tsCol = STATE_TIMESTAMP_COLUMN[initialState];

  const row: NewQualifiedLead = {
    workspaceId: ctx.workspaceId,
    reviewItemId,
    productProfileId,
    state: initialState,
    createdBy: ctx.userId,
    ...(tsCol ? ({ [tsCol]: now } as Partial<NewQualifiedLead>) : {}),
  };

  const [created] = await db.insert(qualifiedLeads).values(row).returning();
  if (!created) throw invariant('qualified_lead insert returned no row');

  await logEvent(ctx, created.id, null, initialState, 'creation', {});
  await recordAuditEvent(ctx, {
    kind: 'pipeline.ensure',
    entityType: 'qualified_lead',
    entityId: created.id,
    payload: {
      reviewItemId: reviewItemId.toString(),
      productProfileId: productProfileId.toString(),
      initialState,
    },
  });
  return created;
}

// ---- transition ----------------------------------------------------

export interface TransitionInput {
  to: PipelineState;
  /** Free-form payload stored on the event row. */
  payload?: Record<string, unknown>;
  /** Allow a non-forward move (admin only). */
  force?: boolean;
  /** When transitioning to `closed`, capture a reason. */
  closeReason?: CloseReason;
  closeNote?: string | null;
}

export async function transition(
  ctx: WorkspaceContext,
  leadId: bigint,
  input: TransitionInput,
): Promise<QualifiedLead> {
  if (!canWrite(ctx)) throw permissionDenied('pipeline.transition');
  const current = await loadLead(ctx, leadId);

  if (current.state === input.to) return current;

  const forward = isForwardTransition(current.state, input.to);
  if (!forward) {
    if (!input.force) {
      throw conflict(
        `transition ${current.state} -> ${input.to} is not in the forward map; pass force:true to override (admin only)`,
      );
    }
    if (!canAdminWorkspace(ctx)) {
      throw permissionDenied('pipeline.transition.force');
    }
  }

  if (input.to === 'closed' && !input.closeReason) {
    throw invalid('closing a lead requires closeReason');
  }

  const now = new Date();
  const updates: Partial<QualifiedLead> & { state: PipelineState; updatedAt: Date } = {
    state: input.to,
    updatedAt: now,
  };
  const tsCol = STATE_TIMESTAMP_COLUMN[input.to];
  if (tsCol) (updates as Record<string, unknown>)[tsCol] = now;
  if (input.to === 'closed') {
    updates.closeReason = input.closeReason ?? null;
    updates.closeNote = input.closeNote?.trim() || null;
  }

  const [updated] = await db
    .update(qualifiedLeads)
    .set(updates)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.id, leadId),
      ),
    )
    .returning();
  if (!updated) throw invariant('qualified_lead update returned no row');

  await logEvent(ctx, leadId, current.state, input.to, 'transition', {
    ...(input.payload ?? {}),
    forced: !forward,
    closeReason: input.closeReason ?? null,
  });
  await recordAuditEvent(ctx, {
    kind: 'pipeline.transition',
    entityType: 'qualified_lead',
    entityId: leadId,
    payload: {
      from: current.state,
      to: input.to,
      forced: !forward,
      closeReason: input.closeReason ?? null,
    },
  });

  return updated;
}

// ---- contact / assign / notes --------------------------------------

export interface UpdateContactInput {
  contactName?: string | null;
  contactEmail?: string | null;
  contactRole?: string | null;
  contactPhone?: string | null;
  contactNotes?: string | null;
}

export async function updateContact(
  ctx: WorkspaceContext,
  leadId: bigint,
  input: UpdateContactInput,
): Promise<QualifiedLead> {
  if (!canWrite(ctx)) throw permissionDenied('pipeline.update_contact');
  const current = await loadLead(ctx, leadId);
  const updates: Partial<QualifiedLead> & { updatedAt: Date } = { updatedAt: new Date() };
  if (input.contactName !== undefined) updates.contactName = input.contactName?.trim() || null;
  if (input.contactEmail !== undefined) {
    const e = input.contactEmail?.trim().toLowerCase() || null;
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      throw invalid('invalid contactEmail');
    }
    updates.contactEmail = e;
  }
  if (input.contactRole !== undefined) updates.contactRole = input.contactRole?.trim() || null;
  if (input.contactPhone !== undefined) updates.contactPhone = input.contactPhone?.trim() || null;
  if (input.contactNotes !== undefined) updates.contactNotes = input.contactNotes?.trim() || null;

  const [updated] = await db
    .update(qualifiedLeads)
    .set(updates)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.id, leadId),
      ),
    )
    .returning();
  if (!updated) throw invariant('contact update returned no row');

  await logEvent(ctx, leadId, current.state, current.state, 'contact_update', {
    fields: Object.keys(input),
  });

  return updated;
}

export async function assign(
  ctx: WorkspaceContext,
  leadId: bigint,
  userId: string | null,
): Promise<QualifiedLead> {
  if (!canWrite(ctx)) throw permissionDenied('pipeline.assign');
  const current = await loadLead(ctx, leadId);
  const [updated] = await db
    .update(qualifiedLeads)
    .set({ assignedToUserId: userId, updatedAt: new Date() })
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.id, leadId),
      ),
    )
    .returning();
  if (!updated) throw invariant('assign update returned no row');
  await logEvent(ctx, leadId, current.state, current.state, 'assignment', {
    assignedToUserId: userId,
  });
  return updated;
}

export async function setNotes(
  ctx: WorkspaceContext,
  leadId: bigint,
  notes: string,
): Promise<QualifiedLead> {
  if (!canWrite(ctx)) throw permissionDenied('pipeline.notes');
  const current = await loadLead(ctx, leadId);
  const [updated] = await db
    .update(qualifiedLeads)
    .set({ notes: notes.trim() || null, updatedAt: new Date() })
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.id, leadId),
      ),
    )
    .returning();
  if (!updated) throw invariant('notes update returned no row');
  await logEvent(ctx, leadId, current.state, current.state, 'note', {});
  return updated;
}

// ---- read ----------------------------------------------------------

export interface ListLeadsFilter {
  state?: PipelineState | readonly PipelineState[];
  productProfileId?: bigint;
  assignedToUserId?: string;
  /** Default true. */
  includeClosed?: boolean;
  limit?: number;
}

export interface PipelineLeadRow {
  lead: QualifiedLead;
  product: ProductProfile;
  reviewItem: ReviewItem;
}

export async function listLeads(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  filter: ListLeadsFilter = {},
): Promise<PipelineLeadRow[]> {
  const conditions: SQL[] = [eq(qualifiedLeads.workspaceId, ctx.workspaceId)];
  if (filter.state !== undefined) {
    const states = Array.isArray(filter.state)
      ? (filter.state as PipelineState[])
      : [filter.state as PipelineState];
    if (states.length === 1) conditions.push(eq(qualifiedLeads.state, states[0]!));
  }
  if (filter.productProfileId !== undefined) {
    conditions.push(eq(qualifiedLeads.productProfileId, filter.productProfileId));
  }
  if (filter.assignedToUserId !== undefined) {
    conditions.push(eq(qualifiedLeads.assignedToUserId, filter.assignedToUserId));
  }
  const limit = Math.min(filter.limit ?? 200, 1000);
  const rows = await db
    .select({
      lead: qualifiedLeads,
      product: productProfiles,
      reviewItem: reviewItems,
    })
    .from(qualifiedLeads)
    .innerJoin(productProfiles, eq(productProfiles.id, qualifiedLeads.productProfileId))
    .innerJoin(reviewItems, eq(reviewItems.id, qualifiedLeads.reviewItemId))
    .where(and(...conditions))
    .orderBy(desc(qualifiedLeads.updatedAt))
    .limit(limit);
  return filter.includeClosed === false
    ? rows.filter((r) => r.lead.state !== 'closed')
    : rows;
}

export async function getLead(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<PipelineLeadRow & { events: PipelineEvent[] }> {
  const rows = await db
    .select({
      lead: qualifiedLeads,
      product: productProfiles,
      reviewItem: reviewItems,
    })
    .from(qualifiedLeads)
    .innerJoin(productProfiles, eq(productProfiles.id, qualifiedLeads.productProfileId))
    .innerJoin(reviewItems, eq(reviewItems.id, qualifiedLeads.reviewItemId))
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound('qualified_lead');
  const events = await db
    .select()
    .from(pipelineEvents)
    .where(
      and(
        eq(pipelineEvents.workspaceId, ctx.workspaceId),
        eq(pipelineEvents.qualifiedLeadId, id),
      ),
    )
    .orderBy(asc(pipelineEvents.createdAt));
  return { ...rows[0], events };
}

/** Counts per state for the kanban header. */
export async function getStateCounts(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<Record<PipelineState, number>> {
  const rows = await db
    .select()
    .from(qualifiedLeads)
    .where(eq(qualifiedLeads.workspaceId, ctx.workspaceId));
  const counts: Record<PipelineState, number> = {
    raw_discovered: 0,
    relevant: 0,
    contacted: 0,
    replied: 0,
    contact_identified: 0,
    qualified: 0,
    handed_over: 0,
    synced_to_crm: 0,
    closed: 0,
  };
  for (const r of rows) counts[r.state] += 1;
  return counts;
}

// ---- internals -----------------------------------------------------

async function loadLead(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<QualifiedLead> {
  const rows = await db
    .select()
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound('qualified_lead');
  return rows[0];
}

async function logEvent(
  ctx: WorkspaceContext,
  leadId: bigint,
  fromState: PipelineState | null,
  toState: PipelineState,
  eventKind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const row: NewPipelineEvent = {
    workspaceId: ctx.workspaceId,
    qualifiedLeadId: leadId,
    fromState,
    toState,
    eventKind,
    payload,
    actorUserId: ctx.userId,
  };
  await db.insert(pipelineEvents).values(row);
}

export const FORWARD_TRANSITIONS = FORWARD;
