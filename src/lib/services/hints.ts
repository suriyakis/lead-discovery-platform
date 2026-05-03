// Hints service. Phase 22.
//
// A hint is a small piece of computed UX context attached to an entity
// (lead, thread, draft, contact). They are NOT persisted — every call
// derives them from current state. Pages call hintsForLead etc. and render
// the result via <HintBadge> / <HintBadgeList>.

import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { qualifications } from '@/lib/db/schema/qualifications';
import { qualifiedLeads, type QualifiedLead } from '@/lib/db/schema/pipeline';
import { outreachDrafts, outreachQueue } from '@/lib/db/schema/outreach';
import { mailMessages, mailThreads, type MailThread } from '@/lib/db/schema/mailing';
import type { WorkspaceContext } from './context';

export type HintSeverity = 'info' | 'warning' | 'action' | 'success';

export interface Hint {
  type: string;
  severity: HintSeverity;
  text: string;
  detail?: string;
  /** Lucide icon name suggestion. The UI is free to ignore. */
  icon?: string;
  /** Optional internal href for click-through. */
  href?: string;
}

// ---- per-lead hints -----------------------------------------------

export async function hintsForLead(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  leadId: bigint,
): Promise<Hint[]> {
  const out: Hint[] = [];
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
  const lead = leadRows[0];
  if (!lead) return out;

  // 1) product_fit
  const qRows = await db
    .select()
    .from(qualifications)
    .where(
      and(
        eq(qualifications.workspaceId, ctx.workspaceId),
        eq(qualifications.productProfileId, lead.productProfileId),
      ),
    )
    .orderBy(desc(qualifications.relevanceScore))
    .limit(1);
  const top = qRows[0];
  if (top) {
    out.push({
      type: 'product_fit',
      severity: top.isRelevant ? 'success' : 'warning',
      text: `score ${top.relevanceScore}`,
      detail: top.qualificationReason ?? top.rejectionReason ?? undefined,
      icon: top.isRelevant ? 'check' : 'alert-triangle',
    });
  }

  // 2) next_action — based on state
  out.push(...nextActionHintsForLead(lead));

  // 3) draft pending
  const drafts = await db
    .select()
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.reviewItemId, lead.reviewItemId),
        eq(outreachDrafts.productProfileId, lead.productProfileId),
        eq(outreachDrafts.status, 'draft'),
      ),
    )
    .limit(1);
  if (drafts[0]) {
    out.push({
      type: 'pending_approval',
      severity: 'action',
      text: 'draft awaits approval',
      icon: 'mail',
      href: `/drafts/${drafts[0].id}`,
    });
  }

  return out;
}

function nextActionHintsForLead(lead: QualifiedLead): Hint[] {
  switch (lead.state) {
    case 'relevant':
      return [
        { type: 'next_action', severity: 'action', text: 'send first outreach', icon: 'send' },
      ];
    case 'contacted':
      return [
        { type: 'next_action', severity: 'info', text: 'awaiting reply', icon: 'clock' },
      ];
    case 'replied':
      return [
        { type: 'next_action', severity: 'action', text: 'classify reply, send next message', icon: 'reply' },
      ];
    case 'qualified':
      return [
        { type: 'next_action', severity: 'success', text: 'push to CRM as deal', icon: 'briefcase' },
      ];
    case 'closed':
      return [
        {
          type: 'next_action',
          severity: 'info',
          text: lead.closeReason ? `closed (${lead.closeReason})` : 'closed',
          icon: 'archive',
        },
      ];
    default:
      return [];
  }
}

// ---- per-thread hints ---------------------------------------------

export async function hintsForThread(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  threadId: bigint,
): Promise<Hint[]> {
  const out: Hint[] = [];
  const threadRows = await db
    .select()
    .from(mailThreads)
    .where(
      and(
        eq(mailThreads.workspaceId, ctx.workspaceId),
        eq(mailThreads.id, threadId),
      ),
    )
    .limit(1);
  const thread = threadRows[0];
  if (!thread) return out;

  // Last inbound classification, if any.
  const inboundRows = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.threadId, threadId),
        eq(mailMessages.direction, 'inbound'),
      ),
    )
    .orderBy(desc(mailMessages.createdAt))
    .limit(1);
  const last = inboundRows[0];
  if (last && last.replyClassification) {
    out.push(replyClassificationHint(last.replyClassification, last.replyClassificationConfidence));
  }
  void thread;
  return out;
}

function replyClassificationHint(type: string, conf: number | null): Hint {
  const severity: HintSeverity = (() => {
    switch (type) {
      case 'positive':
      case 'interest':
        return 'success';
      case 'unsubscribe':
      case 'bounce':
      case 'negative':
        return 'warning';
      case 'redirect':
      case 'doc_request':
      case 'question':
        return 'action';
      default:
        return 'info';
    }
  })();
  return {
    type: 'reply_classification',
    severity,
    text: type.replace(/_/g, ' '),
    detail: conf ? `confidence ${conf}` : undefined,
    icon: 'tag',
  };
}

// ---- per-draft hints ----------------------------------------------

export async function hintsForDraft(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  draftId: bigint,
): Promise<Hint[]> {
  const out: Hint[] = [];
  const draftRows = await db
    .select()
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.workspaceId, ctx.workspaceId),
        eq(outreachDrafts.id, draftId),
      ),
    )
    .limit(1);
  const draft = draftRows[0];
  if (!draft) return out;

  // 1) AI-generated awareness
  if (draft.method === 'ai' || draft.method === 'hybrid') {
    out.push({
      type: 'ai_generated',
      severity: 'info',
      text: 'AI draft — review carefully',
      icon: 'sparkles',
    });
  }
  // 2) forbidden phrases stripped
  if (draft.forbiddenStripped.length > 0) {
    out.push({
      type: 'forbidden_stripped',
      severity: 'warning',
      text: `stripped ${draft.forbiddenStripped.length} forbidden phrase(s)`,
      detail: draft.forbiddenStripped.join(', '),
      icon: 'shield',
    });
  }
  // 3) queued for send
  const queued = await db
    .select()
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.workspaceId, ctx.workspaceId),
        eq(outreachQueue.draftId, draftId),
      ),
    )
    .orderBy(desc(outreachQueue.createdAt))
    .limit(1);
  if (queued[0]) {
    if (queued[0].status === 'queued') {
      out.push({
        type: 'send_scheduled',
        severity: 'info',
        text: `scheduled ${queued[0].scheduledSendAt.toLocaleString()}`,
        icon: 'calendar',
        href: `/mailbox/queue?status=queued`,
      });
    } else if (queued[0].status === 'sent') {
      out.push({ type: 'sent', severity: 'success', text: 'sent', icon: 'check' });
    } else if (queued[0].status === 'failed') {
      out.push({
        type: 'send_failed',
        severity: 'warning',
        text: 'send failed',
        detail: queued[0].lastError ?? undefined,
        icon: 'alert-octagon',
      });
    }
  }

  return out;
}

// ---- batch endpoints (workspace-wide quick stats) -----------------

export async function leadStateSummary(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<{ state: string; count: number }[]> {
  const rows = await db
    .select({ state: qualifiedLeads.state, c: count() })
    .from(qualifiedLeads)
    .where(eq(qualifiedLeads.workspaceId, ctx.workspaceId))
    .groupBy(qualifiedLeads.state);
  return rows.map((r) => ({ state: r.state, count: Number(r.c) }));
}
