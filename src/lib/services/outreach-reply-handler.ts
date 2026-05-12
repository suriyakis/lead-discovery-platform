// Phase C/D — wiring: when an inbound reply has been classified, decide
// what to do next and (where appropriate) enqueue the next outreach
// draft, fork to a referred contact, or close + suppress.
//
// This sits BETWEEN reply-classifier.ts (which decides "what kind of
// reply is this?") and outreach.ts (which generates and persists the
// draft). It is intentionally a thin orchestration layer with no AI
// calls of its own — the decisions are pure (outreach-decision.ts) and
// the drafting is handled by the existing engine via dedicated entry
// points added below.

import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailMessages, mailThreads, type MailMessage } from '@/lib/db/schema/mailing';
import {
  outreachDrafts,
  outreachThreadState,
  type NewOutreachDraft,
  type NewOutreachThreadState,
  type OutreachStage,
} from '@/lib/db/schema/outreach';
import { workspaces } from '@/lib/db/schema/workspaces';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { contactAssociations } from '@/lib/db/schema/contacts';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { reviewItems } from '@/lib/db/schema/review';
import { productProfiles } from '@/lib/db/schema/products';
import { getStageProvider } from './outreach-stage-models';
import { buildProductKnowledgeBlock } from './outreach-knowledge';
import { canWrite, type WorkspaceContext } from './context';
import { recordAuditEvent } from './audit';
import {
  composeClosingDraft,
  composeEngagementDraft,
  composePitchDraft,
  composeReferralIntroDraft,
  type DraftVerdict,
  type ThreadMessage,
} from './outreach-engine';
import { decideOutreachAction, type OutreachAction } from './outreach-decision';
import type { ReplyClassification } from './reply-classifier';
import { transition as pipelineTransition } from './pipeline';
import { addSuppression } from './suppression';
import { resolveProfileLanguage } from '@/lib/i18n/language';

export class OutreachReplyHandlerError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OutreachReplyHandlerError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new OutreachReplyHandlerError(`Permission denied: ${op}`, 'permission_denied');

export interface HandleReplyResult {
  action: OutreachAction;
  /** Drafts created by this call (referral creates two). Empty for
   *  `none` / `close_and_suppress` actions. */
  draftIds: bigint[];
  /** New thread_state row id for the forked discovery thread, if any. */
  forkedThreadStateId: bigint | null;
}

/**
 * Main entry point. Called from analyseReply after the classifier has
 * persisted its verdict on the mail_messages row.
 *
 * Honors the workspace's `autoDraftReplies` flag: when off, the
 * decision is computed and audited but no draft is enqueued (operator
 * will write the next message manually).
 */
export async function handleClassifiedReply(
  ctx: WorkspaceContext,
  messageId: bigint,
  classification: ReplyClassification,
): Promise<HandleReplyResult> {
  if (!canWrite(ctx)) throw denied('outreach_reply.handle');

  // Reload the inbound message + thread + workspace defaults.
  const msg = await loadInboundMessage(ctx, messageId);
  if (!msg) {
    return { action: { kind: 'none', reason: 'message not found' }, draftIds: [], forkedThreadStateId: null };
  }
  if (!msg.threadId) {
    return { action: { kind: 'none', reason: 'message has no thread' }, draftIds: [], forkedThreadStateId: null };
  }

  const ws = await loadWorkspace(ctx);
  const lead = await leadForThread(ctx, msg.threadId);

  // Without a qualified_lead anchor we cannot generate a staged draft
  // (we'd have nothing to associate it with for the supersede dedupe).
  // Auto-actions for suppress / close still run via the existing
  // analyseReply path; here we just bail.
  if (!lead) {
    return {
      action: { kind: 'none', reason: 'thread is not linked to a qualified lead' },
      draftIds: [],
      forkedThreadStateId: null,
    };
  }

  const currentStage = (lead.currentStage as OutreachStage | undefined) ?? 'engagement';
  const action = decideOutreachAction({
    classification: classification.type,
    confidence: classification.confidence,
    extractedEmails: classification.extractedEmails,
    currentStage,
  });

  // Always write thread-state + audit, regardless of whether we draft.
  await upsertThreadState(ctx, {
    workspaceId: ctx.workspaceId,
    qualifiedLeadId: lead.id,
    threadId: msg.threadId,
    stage: action.kind === 'draft' ? action.stage : currentStage,
    lastInboundIntent: classification.type,
    lastInboundConfidence: classification.confidence,
    lastInboundAt: msg.receivedAt ?? new Date(),
  });

  await recordAuditEvent(ctx, {
    kind: 'outreach.reply_handled',
    entityType: 'mail_message',
    entityId: messageId,
    payload: {
      classification: classification.type,
      action: action.kind,
      autoDraftReplies: ws.autoDraftReplies,
      draftStage: action.kind === 'draft' ? action.stage : null,
      referralEmails: action.kind === 'referral' ? action.targetEmails : null,
    },
  });

  // close_and_suppress: terminal. The existing analyseReply auto-action
  // path also runs for unsubscribe/bounce — we defensively run here so
  // the outreach side stays consistent even if the operator turned off
  // the workspace-level reply_auto_actions flags.
  if (action.kind === 'close_and_suppress') {
    if (action.reason === 'unsubscribe' || action.reason === 'bounce') {
      try {
        await addSuppression(ctx, {
          kind: 'email',
          value: msg.fromAddress,
          reason: action.reason === 'unsubscribe' ? 'unsubscribe' : 'bounce_hard',
          note: `auto-suppressed by outreach handler from message ${msg.id}`,
        });
      } catch (err) {
        console.error('[outreach-reply-handler] suppression add failed:', err);
      }
    }
    if (lead.state !== 'closed') {
      try {
        await pipelineTransition(ctx, lead.id, {
          to: 'closed',
          closeReason: action.reason === 'unsubscribe' ? 'no_response' : 'lost',
          closeNote: `auto-close on ${classification.type}`,
          force: true,
        });
      } catch (err) {
        console.error('[outreach-reply-handler] close failed:', err);
      }
    }
    await closeThreadState(ctx, msg.threadId, action.reason);
    return { action, draftIds: [], forkedThreadStateId: null };
  }

  // none: nothing to enqueue.
  if (action.kind === 'none') {
    return { action, draftIds: [], forkedThreadStateId: null };
  }

  // Honor the workspace flag — auto-draft off means we record the
  // decision and stop here. Operator handles the reply by hand.
  if (!ws.autoDraftReplies) {
    return { action, draftIds: [], forkedThreadStateId: null };
  }

  // referral: fork. Two drafts written: closing thank-you in the
  // current thread + discovery to each new email (deduped). The new
  // discovery threads share contact_associations so a future inbound
  // from any of them is correctly linked back to this lead.
  if (action.kind === 'referral') {
    const draftIds: bigint[] = [];
    const product = await productForLead(ctx, lead);
    const language = resolveProfileLanguage(product);
    const channel = 'email';
    const thread = await loadThreadHistory(ctx, msg.threadId);

    // Closing runs on cheap-tier (terminal ack).
    const closingTier = await getStageProvider(ctx, 'closing');
    const closingVerdict = await composeClosingDraft(
      thread,
      'handed_off',
      product,
      { channel, language },
      closingTier.provider,
      action.targetEmails[0] ?? null,
      closingTier.model,
    );
    const closingId = await persistDraft(ctx, {
      lead,
      verdict: closingVerdict,
      channel,
      language,
      stage: 'closing',
      triggeredByMessageId: msg.id,
      parentDraftId: await latestOutboundDraftId(ctx, lead),
      referralChain: null,
    });
    draftIds.push(closingId);

    // 2. Discovery draft(s) to the referred email(s). One per email.
    //    Combined-thread dedupe per multi-product policy: if the same
    //    target email already has an in-flight thread for this lead,
    //    we still write the draft (operator can decide) but skip
    //    creating a duplicate thread_state row.
    // forkedStateId is intentionally const-null for now: the new
    // discovery thread doesn't exist until the queued send delivers,
    // at which point a post-send hook (Phase D Mark 2) will create
    // the thread_state row and link it back here.
    const forkedStateId: bigint | null = null;
    for (const targetEmail of action.targetEmails) {
      const referrerName = msg.fromName ?? null;
      // The "record" for a referred discovery is synthesized — we don't
      // have a fresh sourceRecord for the new contact yet. We pass the
      // lead's source record context so the prompt can still personalize.
      const synthRecord = await sourceRecordContext(ctx, lead);
      // Referral intro is a fresh first-touch email — runs on the
      // cheap discovery tier.
      const introTier = await getStageProvider(ctx, 'referral_intro');
      const introVerdict = await composeReferralIntroDraft(
        synthRecord,
        product,
        {
          fromName: referrerName,
          fromEmail: msg.fromAddress,
          reason: classification.rationale,
        },
        { channel, language },
        introTier.provider,
        introTier.model,
      );
      const introId = await persistDraft(ctx, {
        lead,
        verdict: introVerdict,
        channel,
        language,
        stage: 'discovery',
        triggeredByMessageId: msg.id,
        parentDraftId: closingId,
        referralChain: [
          {
            from_email: msg.fromAddress,
            from_name: msg.fromName ?? null,
            at: (msg.receivedAt ?? new Date()).toISOString(),
          },
        ],
      });
      draftIds.push(introId);

      // Link the original thread_state to the new email — done once
      // per fork, against the FIRST target email. Other extracted
      // emails are still drafted but the thread_state pointer holds
      // the primary handoff target.
      if (targetEmail === action.targetEmails[0]) {
        await markThreadHandoff(ctx, msg.threadId, targetEmail);
      }
    }

    return { action, draftIds, forkedThreadStateId: forkedStateId };
  }

  // draft: in-thread engagement / pitch. Single draft.
  if (action.kind === 'draft') {
    const product = await productForLead(ctx, lead);
    const language = resolveProfileLanguage(product);
    const channel = 'email';
    const thread = await loadThreadHistory(ctx, msg.threadId);

    // Engagement and pitch both run on Opus-tier — these are the
    // moments where the conversation either survives or dies, so the
    // cost premium is justified. Closing falls through here too,
    // intentionally on cheap-tier; pitch always overrides to Opus.
    // Retrieve product knowledge ONCE per inbound — the same query
    // (most recent inbound body) is the right anchor for both
    // engagement and pitch composers.
    const inboundQuery = (msg.bodyText ?? '').slice(0, 2000);
    const knowledge =
      action.stage === 'engagement' || action.stage === 'pitch'
        ? await buildProductKnowledgeBlock(
            ctx,
            product.id,
            inboundQuery,
            { topK: action.stage === 'pitch' ? 4 : 2, stageHint: action.stage },
          )
        : { formatted: '', chunkCount: 0, topSimilarity: 0 };

    let verdict: DraftVerdict;
    if (action.stage === 'pitch') {
      const tier = await getStageProvider(ctx, 'pitch');
      verdict = await composePitchDraft(
        thread,
        product,
        { channel, language },
        tier.provider,
        null, // research enrichment can be wired in later
        tier.model,
        knowledge.formatted || null,
      );
    } else if (action.stage === 'closing') {
      const tier = await getStageProvider(ctx, 'closing');
      verdict = await composeClosingDraft(
        thread,
        'qualified',
        product,
        { channel, language },
        tier.provider,
        null,
        tier.model,
      );
    } else {
      const tier = await getStageProvider(ctx, 'engagement');
      verdict = await composeEngagementDraft(
        thread,
        product,
        { channel, language },
        tier.provider,
        tier.model,
        knowledge.formatted || null,
      );
    }

    const draftId = await persistDraft(ctx, {
      lead,
      verdict,
      channel,
      language,
      stage: action.stage,
      triggeredByMessageId: msg.id,
      parentDraftId: await latestOutboundDraftId(ctx, lead),
      referralChain: null,
    });

    return { action, draftIds: [draftId], forkedThreadStateId: null };
  }

  // exhaustiveness — TS would flag this if a new action kind got added.
  return { action, draftIds: [], forkedThreadStateId: null };
}

// ─── persistence helpers ─────────────────────────────────────────────

interface PersistDraftInput {
  lead: { id: bigint; reviewItemId: bigint; productProfileId: bigint };
  verdict: DraftVerdict;
  channel: string;
  language: string;
  stage: OutreachStage;
  triggeredByMessageId: bigint | null;
  parentDraftId: bigint | null;
  referralChain: unknown | null;
}

async function persistDraft(
  ctx: WorkspaceContext,
  input: PersistDraftInput,
): Promise<bigint> {
  return db.transaction(async (tx) => {
    // Same supersede policy as outreach.generateOutreachDraft. The
    // partial unique index forbids two non-superseded drafts for the
    // same (review_item, product) pair.
    await tx
      .update(outreachDrafts)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(
        and(
          eq(outreachDrafts.workspaceId, ctx.workspaceId),
          eq(outreachDrafts.reviewItemId, input.lead.reviewItemId),
          eq(outreachDrafts.productProfileId, input.lead.productProfileId),
        ),
      );

    // Resolve the source_record id by walking the lead's review_item.
    const reviewRows = await tx
      .select({ sourceRecordId: reviewItems.sourceRecordId })
      .from(reviewItems)
      .where(eq(reviewItems.id, input.lead.reviewItemId))
      .limit(1);
    const sourceRecordId = reviewRows[0]?.sourceRecordId;
    if (!sourceRecordId) {
      throw new OutreachReplyHandlerError(
        'review_item missing source_record_id',
        'invariant_violation',
      );
    }

    const row: NewOutreachDraft = {
      workspaceId: ctx.workspaceId,
      reviewItemId: input.lead.reviewItemId,
      sourceRecordId,
      productProfileId: input.lead.productProfileId,
      qualificationId: null,
      status: 'draft',
      stage: input.stage,
      parentDraftId: input.parentDraftId,
      triggeredByMessageId: input.triggeredByMessageId,
      referralChain: input.referralChain,
      channel: input.channel,
      language: input.language,
      subject: input.verdict.subject,
      body: input.verdict.body,
      confidence: input.verdict.confidence,
      method: input.verdict.method,
      model: input.verdict.model,
      evidence: serializeEvidence(input.verdict),
      forbiddenStripped: input.verdict.forbiddenStripped,
      matchedLessonIds: input.verdict.matchedLessonIds,
      createdBy: ctx.userId,
    };

    const [created] = await tx.insert(outreachDrafts).values(row).returning();
    if (!created) {
      throw new OutreachReplyHandlerError(
        'outreach_draft insert returned no row',
        'invariant_violation',
      );
    }
    return created.id;
  });
}

function serializeEvidence(v: DraftVerdict): Record<string, unknown> {
  return {
    promptSystem: v.evidence.promptSystem,
    promptUser: v.evidence.promptUser,
    matchedLessonIds: v.evidence.matchedLessonIds.map((id) => id.toString()),
    fields: v.evidence.fields,
  };
}

async function loadInboundMessage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<MailMessage | null> {
  const rows = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.id, id),
        eq(mailMessages.direction, 'inbound'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function loadWorkspace(ctx: Pick<WorkspaceContext, 'workspaceId'>) {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!rows[0]) {
    throw new OutreachReplyHandlerError('workspace not found', 'not_found');
  }
  return rows[0];
}

async function leadForThread(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  threadId: bigint,
) {
  // Same walk as reply-classifier.leadForThread, exposed differently.
  const threadAssoc = await db
    .select()
    .from(contactAssociations)
    .where(
      and(
        eq(contactAssociations.workspaceId, ctx.workspaceId),
        eq(contactAssociations.entityType, 'mail_thread'),
        eq(contactAssociations.entityId, threadId.toString()),
      ),
    )
    .limit(1);
  if (!threadAssoc[0]) return null;
  const contactId = threadAssoc[0].contactId;
  const leadAssoc = await db
    .select()
    .from(contactAssociations)
    .where(
      and(
        eq(contactAssociations.workspaceId, ctx.workspaceId),
        eq(contactAssociations.entityType, 'qualified_lead'),
        eq(contactAssociations.contactId, contactId),
      ),
    )
    .limit(1);
  if (!leadAssoc[0]) return null;
  const leadId = BigInt(leadAssoc[0].entityId);
  const rows = await db
    .select()
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.id, leadId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function productForLead(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  lead: { productProfileId: bigint },
) {
  const rows = await db
    .select()
    .from(productProfiles)
    .where(
      and(
        eq(productProfiles.workspaceId, ctx.workspaceId),
        eq(productProfiles.id, lead.productProfileId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new OutreachReplyHandlerError('product_profile not found', 'not_found');
  }
  return rows[0];
}

async function loadThreadHistory(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  threadId: bigint,
): Promise<ThreadMessage[]> {
  const rows = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.threadId, threadId),
      ),
    )
    .orderBy(asc(mailMessages.id));
  return rows.map((r) => ({
    direction: r.direction,
    body: (r.bodyText ?? '').slice(0, 4000),
    at: (r.receivedAt ?? r.sentAt ?? r.createdAt).toISOString(),
    fromName: r.fromName,
    fromAddress: r.fromAddress,
  }));
}

async function sourceRecordContext(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  lead: { reviewItemId: bigint },
) {
  const rows = await db
    .select({
      title: sourceRecords.normalizedData,
      domain: sourceRecords.sourceUrl,
      url: sourceRecords.sourceUrl,
    })
    .from(reviewItems)
    .innerJoin(sourceRecords, eq(sourceRecords.id, reviewItems.sourceRecordId))
    .where(
      and(
        eq(reviewItems.workspaceId, ctx.workspaceId),
        eq(reviewItems.id, lead.reviewItemId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return { title: null, domain: null, url: null };
  const normalized = row.title as Record<string, unknown> | null;
  const titleText =
    typeof normalized?.title === 'string' ? (normalized.title as string) : null;
  let domainText: string | null = null;
  try {
    if (row.url) domainText = new URL(row.url).hostname.replace(/^www\./, '');
  } catch {
    domainText = null;
  }
  return { title: titleText, domain: domainText, url: row.url };
}

async function latestOutboundDraftId(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  lead: { reviewItemId: bigint; productProfileId: bigint },
): Promise<bigint | null> {
  const rows = await db
    .select({ id: outreachDrafts.id })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.reviewItemId, lead.reviewItemId),
        eq(outreachDrafts.productProfileId, lead.productProfileId),
      ),
    )
    .orderBy(desc(outreachDrafts.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

interface UpsertThreadStateInput {
  workspaceId: bigint;
  qualifiedLeadId: bigint;
  threadId: bigint;
  stage: OutreachStage;
  lastInboundIntent: string;
  lastInboundConfidence: number;
  lastInboundAt: Date;
}

async function upsertThreadState(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  input: UpsertThreadStateInput,
): Promise<void> {
  const row: NewOutreachThreadState = {
    workspaceId: input.workspaceId,
    qualifiedLeadId: input.qualifiedLeadId,
    threadId: input.threadId,
    stage: input.stage,
    lastInboundIntent: input.lastInboundIntent,
    lastInboundConfidence: input.lastInboundConfidence,
    lastInboundAt: input.lastInboundAt,
  };
  await db
    .insert(outreachThreadState)
    .values(row)
    .onConflictDoUpdate({
      target: [outreachThreadState.workspaceId, outreachThreadState.threadId],
      set: {
        stage: input.stage,
        lastInboundIntent: input.lastInboundIntent,
        lastInboundConfidence: input.lastInboundConfidence,
        lastInboundAt: input.lastInboundAt,
        updatedAt: new Date(),
      },
    });
  void ctx;
}

async function closeThreadState(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  threadId: bigint,
  reason: string,
): Promise<void> {
  await db
    .update(outreachThreadState)
    .set({
      closedAt: new Date(),
      closedReason: reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(outreachThreadState.workspaceId, ctx.workspaceId),
        eq(outreachThreadState.threadId, threadId),
      ),
    );
}

async function markThreadHandoff(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  threadId: bigint,
  referralToEmail: string,
): Promise<void> {
  await db
    .update(outreachThreadState)
    .set({
      closedAt: new Date(),
      closedReason: 'handed_off',
      referralToEmail,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(outreachThreadState.workspaceId, ctx.workspaceId),
        eq(outreachThreadState.threadId, threadId),
      ),
    );
  // void mailThreads (kept import to satisfy the dependency graph if
  // the type narrows in future)
  void mailThreads;
}
