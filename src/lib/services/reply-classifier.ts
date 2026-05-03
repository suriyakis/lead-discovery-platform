// Reply classifier. Phase 20.
//
// Two layers:
//   1. classifyReply(message): pure heuristic — keyword matching against
//      patterns. Cheap, deterministic, runs synchronously on every inbound
//      message. Used as the default whenever no AI provider is wired in.
//   2. analyseReply(ctx, message, ai?): the service entry point. Uses the
//      AI provider when supplied; otherwise falls back to classifyReply.
//      Persists the result onto mail_messages and (optionally) triggers
//      auto-actions per the workspace's reply_auto_actions row.

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  mailMessages,
  replyAutoActions,
  type MailMessage,
  type ReplyAutoActions,
} from '@/lib/db/schema/mailing';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { contactAssociations } from '@/lib/db/schema/contacts';
import { recordAuditEvent } from './audit';
import { canWrite, type WorkspaceContext } from './context';
import { upsertContact, attachContact } from './contacts';
import { addSuppression } from './suppression';
import { transition as pipelineTransition } from './pipeline';
import type { IAIProvider } from '@/lib/ai';

export type ReplyClass =
  | 'positive'
  | 'redirect'
  | 'question'
  | 'interest'
  | 'doc_request'
  | 'negative'
  | 'out_of_office'
  | 'bounce'
  | 'unsubscribe'
  | 'irrelevant';

export interface ReplyClassification {
  type: ReplyClass;
  confidence: number; // 0..100
  /** Plain-text reasoning for the audit trail. */
  rationale: string;
  /** Email addresses extracted from a redirect-style reply. */
  extractedEmails: string[];
  /** Suggested next action — service layer may auto-execute or just log. */
  suggestedAction:
    | 'reply'
    | 'redirect_to_extracted'
    | 'close_lost'
    | 'suppress'
    | 'wait_retry'
    | 'human_review';
}

const PATTERNS: Array<{ type: ReplyClass; keywords: RegExp[]; suggestedAction: ReplyClassification['suggestedAction'] }> = [
  {
    type: 'unsubscribe',
    keywords: [
      /\bunsubscribe\b/i,
      /\bopt[\s-]?out\b/i,
      /please remove me/i,
      /stop sending/i,
      /\bremove from (?:your |the )?list\b/i,
    ],
    suggestedAction: 'suppress',
  },
  {
    type: 'bounce',
    keywords: [
      /undeliverable/i,
      /delivery (?:failed|failure)/i,
      /mail.+(?:not|undeliv)/i,
      /mailer[\s-]?daemon/i,
      /returning your message/i,
    ],
    suggestedAction: 'suppress',
  },
  {
    type: 'out_of_office',
    keywords: [
      /out of (?:the )?office/i,
      /\bauto[\s-]?reply\b/i,
      /\bauto[\s-]?response\b/i,
      /vacation/i,
      /will be (?:back|away|out)/i,
    ],
    suggestedAction: 'wait_retry',
  },
  {
    type: 'negative',
    keywords: [
      /\bnot interested\b/i,
      /\bno thanks?\b/i,
      /\bdo not (?:contact|email)\b/i,
      /not a (?:fit|match)/i,
      /please stop/i,
    ],
    suggestedAction: 'close_lost',
  },
  {
    type: 'redirect',
    keywords: [
      /please (?:contact|reach|email|speak (?:with|to))/i,
      /forward(?:ing|ed)? (?:this|to)/i,
      /you should (?:talk|speak|reach out) to/i,
      /\bbetter (?:contact|fit|person)\b/i,
    ],
    suggestedAction: 'redirect_to_extracted',
  },
  {
    type: 'doc_request',
    keywords: [
      /(?:could you|please) (?:send|share|provide).+?(?:spec|datasheet|brochure|doc)/i,
      /\battach(?:ment|ed)? (?:the|your|spec|brochure)\b/i,
      /\bcould we get the (?:specs|details)\b/i,
    ],
    suggestedAction: 'reply',
  },
  {
    type: 'question',
    keywords: [/\?/],
    suggestedAction: 'reply',
  },
  {
    type: 'interest',
    keywords: [
      /\binterested\b/i,
      /\b(?:would|could) (?:like|love) to learn more\b/i,
      /\btell me more\b/i,
      /\bset up a call\b/i,
      /\bschedule (?:a )?call\b/i,
    ],
    suggestedAction: 'reply',
  },
  {
    type: 'positive',
    keywords: [
      /\b(?:sure|sounds good|let'?s do it|happy to)\b/i,
      /\b(?:yes|yep), (?:please|that works)\b/i,
    ],
    suggestedAction: 'reply',
  },
];

const EMAIL_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

export function classifyReply(text: string | null | undefined): ReplyClassification {
  const body = (text ?? '').trim();
  const empty = !body;
  const extractedEmails = empty
    ? []
    : Array.from(new Set((body.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())));

  if (empty) {
    return {
      type: 'irrelevant',
      confidence: 30,
      rationale: 'empty body',
      extractedEmails: [],
      suggestedAction: 'human_review',
    };
  }

  for (const pattern of PATTERNS) {
    for (const re of pattern.keywords) {
      if (re.test(body)) {
        return {
          type: pattern.type,
          confidence: 70,
          rationale: `matched: ${re.source.slice(0, 80)}`,
          extractedEmails,
          suggestedAction: pattern.suggestedAction,
        };
      }
    }
  }

  return {
    type: 'irrelevant',
    confidence: 40,
    rationale: 'no pattern matched',
    extractedEmails,
    suggestedAction: 'human_review',
  };
}

// ---- service entry point ------------------------------------------

export interface AnalyseReplyOptions {
  /** Optional AI provider — if supplied, wraps classifyReply with an AI
      call that can override the heuristic. Phase 20 keeps the prompt
      simple; richer prompts land later. */
  ai?: IAIProvider;
  /** Skip auto-actions (test seam). */
  skipAutoActions?: boolean;
}

export async function analyseReply(
  ctx: WorkspaceContext,
  messageId: bigint,
  options: AnalyseReplyOptions = {},
): Promise<ReplyClassification> {
  if (!canWrite(ctx)) {
    throw new Error('Permission denied: reply.analyse');
  }
  const rows = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.id, messageId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new Error('mail_message not found');
  const msg = rows[0];
  if (msg.direction !== 'inbound') {
    throw new Error('analyseReply only valid for inbound messages');
  }

  // Heuristic first. AI provider can override (we accept its result if it
  // returns a known class; otherwise we keep the heuristic).
  const heuristic = classifyReply(msg.bodyText);
  let final = heuristic;
  if (options.ai) {
    try {
      const aiResult = await options.ai.generateText(
        {
          system:
            'Classify the inbound email into one of: positive, redirect, question, interest, doc_request, negative, out_of_office, bounce, unsubscribe, irrelevant. Reply with the single word.',
          prompt: msg.bodyText ?? '(no body)',
        },
        { temperature: 0 },
      );
      const candidate = aiResult.text.trim().toLowerCase().replace(/[^a-z_]/g, '') as ReplyClass;
      const valid = PATTERNS.some((p) => p.type === candidate) ||
        candidate === 'irrelevant' ||
        candidate === 'positive' ||
        candidate === 'question' ||
        candidate === 'interest';
      if (valid) {
        const matchedPattern = PATTERNS.find((p) => p.type === candidate);
        final = {
          type: candidate,
          confidence: 85,
          rationale: `AI: ${aiResult.model}`,
          extractedEmails: heuristic.extractedEmails,
          suggestedAction: matchedPattern?.suggestedAction ?? 'human_review',
        };
      }
    } catch (err) {
      console.error('[reply-classifier] AI fallback failed:', err);
    }
  }

  await db
    .update(mailMessages)
    .set({
      replyClassification: final.type,
      replyClassificationConfidence: final.confidence,
      replyClassifiedAt: new Date(),
      extractedEmails: final.extractedEmails,
      updatedAt: new Date(),
    })
    .where(eq(mailMessages.id, messageId));

  await recordAuditEvent(ctx, {
    kind: 'reply.classify',
    entityType: 'mail_message',
    entityId: messageId,
    payload: {
      type: final.type,
      confidence: final.confidence,
      rationale: final.rationale,
      extractedEmailsCount: final.extractedEmails.length,
      suggestedAction: final.suggestedAction,
    },
  });

  if (!options.skipAutoActions) {
    await applyAutoActions(ctx, msg, final);
  }

  return final;
}

// ---- auto-actions -------------------------------------------------

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
    throw new Error('reply_auto_actions init returned no row');
  }
  return reload[0];
}

export interface UpdateReplyAutoActionsInput {
  autoSuppressBounce?: boolean;
  autoSuppressUnsubscribe?: boolean;
  autoCloseNegative?: boolean;
  autoExtractRedirects?: boolean;
}

export async function updateReplyAutoActions(
  ctx: WorkspaceContext,
  input: UpdateReplyAutoActionsInput,
): Promise<ReplyAutoActions> {
  if (!canWrite(ctx)) throw new Error('Permission denied: reply.auto_actions.update');
  await getReplyAutoActions(ctx);
  const updates: Partial<ReplyAutoActions> & { updatedAt: Date } = {
    updatedAt: new Date(),
    updatedBy: ctx.userId,
  };
  if (input.autoSuppressBounce !== undefined) {
    updates.autoSuppressBounce = input.autoSuppressBounce;
  }
  if (input.autoSuppressUnsubscribe !== undefined) {
    updates.autoSuppressUnsubscribe = input.autoSuppressUnsubscribe;
  }
  if (input.autoCloseNegative !== undefined) {
    updates.autoCloseNegative = input.autoCloseNegative;
  }
  if (input.autoExtractRedirects !== undefined) {
    updates.autoExtractRedirects = input.autoExtractRedirects;
  }
  const [updated] = await db
    .update(replyAutoActions)
    .set(updates)
    .where(eq(replyAutoActions.workspaceId, ctx.workspaceId))
    .returning();
  if (!updated) {
    throw new Error('reply_auto_actions update returned no row');
  }
  await recordAuditEvent(ctx, {
    kind: 'reply.auto_actions.update',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: { ...input } as Record<string, unknown>,
  });
  return updated;
}

async function applyAutoActions(
  ctx: WorkspaceContext,
  msg: MailMessage,
  classification: ReplyClassification,
): Promise<void> {
  const settings = await getReplyAutoActions(ctx);

  // Resolve qualified_lead via thread → contact_associations.
  let lead = null as Awaited<ReturnType<typeof leadForThread>>;
  if (msg.threadId) {
    lead = await leadForThread(ctx, msg.threadId);
  }

  if (
    classification.type === 'unsubscribe' &&
    settings.autoSuppressUnsubscribe
  ) {
    try {
      await addSuppression(ctx, {
        kind: 'email',
        value: msg.fromAddress,
        reason: 'unsubscribe',
        note: `auto-suppressed from message ${msg.id}`,
      });
    } catch (err) {
      console.error('[reply-classifier] unsubscribe suppress failed:', err);
    }
    if (lead && lead.state !== 'closed') {
      try {
        await pipelineTransition(ctx, lead.id, {
          to: 'closed',
          closeReason: 'no_response',
          closeNote: 'unsubscribe',
          force: true,
        });
      } catch (err) {
        console.error('[reply-classifier] close on unsubscribe failed:', err);
      }
    }
    return;
  }

  if (classification.type === 'bounce' && settings.autoSuppressBounce) {
    try {
      await addSuppression(ctx, {
        kind: 'email',
        value: msg.fromAddress,
        reason: 'bounce_hard',
        note: `auto-suppressed from message ${msg.id}`,
      });
    } catch (err) {
      console.error('[reply-classifier] bounce suppress failed:', err);
    }
    if (lead && lead.state !== 'closed') {
      try {
        await pipelineTransition(ctx, lead.id, {
          to: 'closed',
          closeReason: 'wrong_fit',
          closeNote: 'bounce',
          force: true,
        });
      } catch (err) {
        console.error('[reply-classifier] close on bounce failed:', err);
      }
    }
    return;
  }

  if (classification.type === 'negative' && settings.autoCloseNegative) {
    if (lead && lead.state !== 'closed') {
      try {
        await pipelineTransition(ctx, lead.id, {
          to: 'closed',
          closeReason: 'lost',
          closeNote: 'negative reply',
          force: true,
        });
      } catch (err) {
        console.error('[reply-classifier] close on negative failed:', err);
      }
    }
    return;
  }

  if (
    classification.type === 'redirect' &&
    settings.autoExtractRedirects &&
    classification.extractedEmails.length > 0
  ) {
    for (const email of classification.extractedEmails) {
      try {
        const contact = await upsertContact(ctx, { email });
        if (msg.threadId) {
          await attachContact(ctx, contact.id, {
            type: 'mail_thread',
            id: msg.threadId.toString(),
            relation: 'redirect_target',
          });
        }
      } catch (err) {
        console.error('[reply-classifier] extract-redirect failed:', err);
      }
    }
  }
}

async function leadForThread(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  threadId: bigint,
) {
  // Walk: thread → contact_associations(entity=mail_thread) → contact_id
  // → contact_associations(entity=qualified_lead) → qualified_leads.
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
  const leadRows = await db
    .select()
    .from(qualifiedLeads)
    .where(
      and(
        eq(qualifiedLeads.workspaceId, ctx.workspaceId),
        eq(qualifiedLeads.id, leadId),
      ),
    )
    .limit(1);
  return leadRows[0] ?? null;
}
