// Lead-scoped research service. Wraps IResearchProvider with:
//   - per-lead persistence + cache (workspace, lead, question_hash)
//   - role gates (member+ to run; viewers can read existing entries)
//   - audit logging on every mutation
//   - usage_log entry per real call (non-mock)

import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import {
  leadResearch,
  type LeadResearchEntry,
  type NewLeadResearchEntry,
} from '@/lib/db/schema/pipeline';
import {
  getResearchProviderForCtx,
  type ResearchOptions,
  type ResearchOutcome,
} from '@/lib/research';
import { recordAuditEvent } from './audit';
import { canWrite, type WorkspaceContext } from './context';
import { recordUsage } from './usage';

export class LeadResearchError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'LeadResearchError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new LeadResearchError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new LeadResearchError('lead not found', 'not_found');
const invalid = (msg: string) => new LeadResearchError(msg, 'invalid_input');

const QUESTION_MAX_LEN = 600;

function hashQuestion(question: string): string {
  return createHash('sha256')
    .update(question.trim().toLowerCase())
    .digest('hex');
}

export interface ResearchLeadInput {
  qualifiedLeadId: bigint;
  question: string;
  options?: ResearchOptions;
  /** Force a fresh call even when a cached row exists. */
  refresh?: boolean;
}

export interface ResearchLeadResult {
  entry: LeadResearchEntry;
  /** True when the call hit the cache and didn't re-bill the provider. */
  cached: boolean;
  /** Underlying provider outcome, present only when freshly run. */
  outcome?: ResearchOutcome;
}

/**
 * Run (or fetch cached) research against a qualified lead.
 */
export async function researchLead(
  ctx: WorkspaceContext,
  input: ResearchLeadInput,
): Promise<ResearchLeadResult> {
  if (!canWrite(ctx)) throw denied('lead_research.run');
  const question = input.question.trim();
  if (!question) throw invalid('question is required');
  if (question.length > QUESTION_MAX_LEN) {
    throw invalid(`question exceeds ${QUESTION_MAX_LEN} characters`);
  }

  // Verify the lead belongs to the workspace.
  const [lead] = await db
    .select({ id: qualifiedLeads.id })
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.id, input.qualifiedLeadId),
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (!lead) throw notFound();

  const questionHash = hashQuestion(question);

  // Cache lookup unless refresh was requested.
  if (!input.refresh) {
    const [cached] = await db
      .select()
      .from(leadResearch)
      .where(
        and(
          eq(leadResearch.workspaceId, ctx.workspaceId),
          eq(leadResearch.qualifiedLeadId, input.qualifiedLeadId),
          eq(leadResearch.questionHash, questionHash),
        ),
      )
      .orderBy(desc(leadResearch.createdAt))
      .limit(1);
    if (cached) return { entry: cached, cached: true };
  }

  // Cache miss → call the research provider.
  const provider = await getResearchProviderForCtx(ctx);
  const outcome = await provider.research(ctx, question, input.options);

  const row: NewLeadResearchEntry = {
    workspaceId: ctx.workspaceId,
    qualifiedLeadId: input.qualifiedLeadId,
    question,
    questionHash,
    answer: outcome.answer,
    citations: outcome.citations as unknown as NewLeadResearchEntry['citations'],
    queriesIssued: outcome.queriesIssued,
    providerId: outcome.providerId,
    costEstimateCents: Math.round(outcome.usage.costEstimateCents),
    createdBy: ctx.userId,
  };
  const [inserted] = await db.insert(leadResearch).values(row).returning();
  if (!inserted) {
    throw new LeadResearchError(
      'lead_research insert returned no row',
      'invariant_violation',
    );
  }

  await recordAuditEvent(ctx, {
    kind: 'lead_research.run',
    entityType: 'qualified_lead',
    entityId: input.qualifiedLeadId,
    payload: {
      provider: outcome.providerId,
      questionLength: question.length,
      citationCount: outcome.citations.length,
      costEstimateCents: outcome.usage.costEstimateCents,
      keySource: outcome.usage.keySource,
    },
  });

  // Per-call usage log so /settings/usage rolls research spend up.
  if (outcome.usage.keySource !== 'mock') {
    await recordUsage(ctx, {
      kind: 'research.query',
      provider: outcome.providerId,
      units: 1,
      costEstimateCents: Math.round(outcome.usage.costEstimateCents),
      payload: {
        keySource: outcome.usage.keySource,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        searchQueries: outcome.usage.searchQueries,
      },
    });
  }

  return { entry: inserted, cached: false, outcome };
}

/**
 * List recent research entries for a lead, newest first.
 */
export async function listLeadResearch(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  qualifiedLeadId: bigint,
  limit = 25,
): Promise<LeadResearchEntry[]> {
  return db
    .select()
    .from(leadResearch)
    .where(
      and(
        eq(leadResearch.workspaceId, ctx.workspaceId),
        eq(leadResearch.qualifiedLeadId, qualifiedLeadId),
      ),
    )
    .orderBy(desc(leadResearch.createdAt))
    .limit(limit);
}

/**
 * Delete a single research entry. Admin-gated to prevent operators from
 * removing audit-relevant rows by accident.
 */
export async function deleteLeadResearch(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<void> {
  if (!canWrite(ctx)) throw denied('lead_research.delete');
  const [row] = await db
    .select()
    .from(leadResearch)
    .where(
      and(
        eq(leadResearch.id, id),
        eq(leadResearch.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw notFound();
  await db.delete(leadResearch).where(eq(leadResearch.id, id));
  await recordAuditEvent(ctx, {
    kind: 'lead_research.delete',
    entityType: 'lead_research',
    entityId: id,
    payload: { qualifiedLeadId: row.qualifiedLeadId.toString() },
  });
}
