// Hints service. Phase 22.
//
// A hint is a small piece of computed UX context attached to an entity
// (lead, thread, draft, contact). They are NOT persisted — every call
// derives them from current state. Pages call hintsForLead etc. and render
// the result via <HintBadge> / <HintBadgeList>.

import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { qualifications } from '@/lib/db/schema/qualifications';
import { qualifiedLeads, type QualifiedLead } from '@/lib/db/schema/pipeline';
import {
  outreachDrafts,
  outreachQueue,
  type OutreachDraft,
} from '@/lib/db/schema/outreach';
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

/**
 * Batched variant of hintsForLead. Replaces N round-trips with 2:
 *   1. Top qualification per (productProfileId) — DISTINCT ON in pg
 *   2. All pending drafts matching the (reviewItemId, productProfileId)
 *      pairs for the leads in question
 * Returns Map<leadId.toString, Hint[]>. Empty list if a lead has no
 * hints (so the caller doesn't have to default).
 */
export async function hintsForLeads(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  leads: ReadonlyArray<QualifiedLead>,
): Promise<Map<string, Hint[]>> {
  const out = new Map<string, Hint[]>();
  if (leads.length === 0) return out;
  for (const l of leads) out.set(l.id.toString(), []);

  const productIds = Array.from(new Set(leads.map((l) => l.productProfileId)));
  const reviewIds = Array.from(new Set(leads.map((l) => l.reviewItemId)));

  // 1) Top qualification per product. Drizzle splats `${array}` into a
  //    record-typed binding ($1, $2, …) inside raw `sql` templates, which
  //    breaks `= ANY(...)`. Use the query builder + JS-side DISTINCT ON
  //    emulation instead.
  const allQualRows =
    productIds.length > 0
      ? await db
          .select({
            productProfileId: qualifications.productProfileId,
            isRelevant: qualifications.isRelevant,
            relevanceScore: qualifications.relevanceScore,
            qualificationReason: qualifications.qualificationReason,
            rejectionReason: qualifications.rejectionReason,
          })
          .from(qualifications)
          .where(
            and(
              eq(qualifications.workspaceId, ctx.workspaceId),
              inArray(qualifications.productProfileId, productIds),
            ),
          )
          .orderBy(qualifications.productProfileId, desc(qualifications.relevanceScore))
      : [];
  const topByProduct = new Map<
    string,
    {
      isRelevant: boolean;
      relevanceScore: number;
      qualificationReason: string | null;
      rejectionReason: string | null;
    }
  >();
  for (const row of allQualRows) {
    const pid = row.productProfileId.toString();
    if (topByProduct.has(pid)) continue; // first row per partition wins (DISTINCT ON)
    topByProduct.set(pid, {
      isRelevant: row.isRelevant,
      relevanceScore: row.relevanceScore,
      qualificationReason: row.qualificationReason,
      rejectionReason: row.rejectionReason,
    });
  }

  // 2) Pending drafts. One query for all (reviewItemId, productProfileId)
  //    pairs in the lead set, then we match in JS — the alternative is
  //    a row-constructor IN which Drizzle doesn't expose cleanly.
  const draftRows =
    reviewIds.length > 0 && productIds.length > 0
      ? await db
          .select({
            id: outreachDrafts.id,
            reviewItemId: outreachDrafts.reviewItemId,
            productProfileId: outreachDrafts.productProfileId,
          })
          .from(outreachDrafts)
          .where(
            and(
              eq(outreachDrafts.workspaceId, ctx.workspaceId),
              inArray(outreachDrafts.reviewItemId, reviewIds),
              inArray(outreachDrafts.productProfileId, productIds),
              eq(outreachDrafts.status, 'draft'),
            ),
          )
      : [];
  const draftByPair = new Map<string, bigint>();
  for (const d of draftRows) {
    draftByPair.set(`${d.reviewItemId}:${d.productProfileId}`, d.id);
  }

  for (const lead of leads) {
    const hints: Hint[] = [];
    const top = topByProduct.get(lead.productProfileId.toString());
    if (top) {
      hints.push({
        type: 'product_fit',
        severity: top.isRelevant ? 'success' : 'warning',
        text: `score ${top.relevanceScore}`,
        detail: top.qualificationReason ?? top.rejectionReason ?? undefined,
        icon: top.isRelevant ? 'check' : 'alert-triangle',
      });
    }
    hints.push(...nextActionHintsForLead(lead));
    const draftId = draftByPair.get(`${lead.reviewItemId}:${lead.productProfileId}`);
    if (draftId !== undefined) {
      hints.push({
        type: 'pending_approval',
        severity: 'action',
        text: 'draft awaits approval',
        icon: 'mail',
        href: `/drafts/${draftId}`,
      });
    }
    out.set(lead.id.toString(), hints);
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

/**
 * Batched variant of hintsForDraft. One outreach_queue scan picks the
 * most-recent queue row per draft via DISTINCT ON, then we compose the
 * hints in JS from the already-fetched draft rows. The caller passes
 * the OutreachDraft objects (already in scope on /drafts so no extra
 * SELECT) — the function does NOT re-fetch drafts.
 */
export async function hintsForDrafts(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  drafts: ReadonlyArray<OutreachDraft>,
): Promise<Map<string, Hint[]>> {
  const out = new Map<string, Hint[]>();
  if (drafts.length === 0) return out;
  for (const d of drafts) out.set(d.id.toString(), []);

  const draftIds = drafts.map((d) => d.id);
  // Most-recent queue row per draft. Use the builder + JS-side DISTINCT ON
  // emulation — drizzle's raw `sql` template splats arrays into a record
  // binding which `= ANY(...)` cannot consume.
  const allQueueRows = await db
    .select({
      draftId: outreachQueue.draftId,
      status: outreachQueue.status,
      scheduledSendAt: outreachQueue.scheduledSendAt,
      lastError: outreachQueue.lastError,
    })
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.workspaceId, ctx.workspaceId),
        inArray(outreachQueue.draftId, draftIds),
      ),
    )
    .orderBy(outreachQueue.draftId, desc(outreachQueue.createdAt));
  const queueByDraft = new Map<
    string,
    {
      status: string;
      scheduledSendAt: Date;
      lastError: string | null;
    }
  >();
  for (const row of allQueueRows) {
    if (row.draftId === null) continue;
    const did = row.draftId.toString();
    if (queueByDraft.has(did)) continue; // first row per partition wins (DISTINCT ON)
    queueByDraft.set(did, {
      status: row.status,
      scheduledSendAt: row.scheduledSendAt,
      lastError: row.lastError,
    });
  }

  for (const draft of drafts) {
    const hints: Hint[] = [];
    if (draft.method === 'ai' || draft.method === 'hybrid') {
      hints.push({
        type: 'ai_generated',
        severity: 'info',
        text: 'AI draft — review carefully',
        icon: 'sparkles',
      });
    }
    if (draft.forbiddenStripped.length > 0) {
      hints.push({
        type: 'forbidden_stripped',
        severity: 'warning',
        text: `stripped ${draft.forbiddenStripped.length} forbidden phrase(s)`,
        detail: draft.forbiddenStripped.join(', '),
        icon: 'shield',
      });
    }
    const q = queueByDraft.get(draft.id.toString());
    if (q) {
      if (q.status === 'queued') {
        hints.push({
          type: 'send_scheduled',
          severity: 'info',
          text: `scheduled ${q.scheduledSendAt.toLocaleString()}`,
          icon: 'calendar',
          href: `/mailbox/queue?status=queued`,
        });
      } else if (q.status === 'sent') {
        hints.push({ type: 'sent', severity: 'success', text: 'sent', icon: 'check' });
      } else if (q.status === 'failed') {
        hints.push({
          type: 'send_failed',
          severity: 'warning',
          text: 'send failed',
          detail: q.lastError ?? undefined,
          icon: 'alert-octagon',
        });
      }
    }
    out.set(draft.id.toString(), hints);
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
