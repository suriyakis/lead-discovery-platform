// MOB-02: the two workspace shapes the attention summary is pinned on,
// written through Drizzle into the lane's test database (truncateAll first).
//
//   prodShaped(scale)  production on 2026-10-01 (prod_report.md), times
//                      `scale` for the performance budget: a trial workspace,
//                      not live, two products; 310 untouched review items of
//                      which 1 is relevant, each judged by both products; a
//                      newsletter-only inbox in the X1 shape (bulk and
//                      unrelated mail, nothing from a prospect); a failing
//                      mailbox (13 failures, no backoff) next to an active
//                      one; 0 sends; one draft whose pair has no lead; a
//                      dozen unread notifications for the owner.
//   happyPath()        a working loop: review items across two products
//                      (one needs_review, two assigned), leads with contact
//                      emails, drafts in every status, follow-ups in several
//                      states, prospect threads answered and unanswered,
//                      trashed and spam replies, a newsletter, an
//                      auto-reply; unread notifications per user and an
//                      unread support reply.
//
// Each fixture returns the numbers the summary must report (`expected`).

import { db } from '@/lib/db/client';
import { autopilotSettings } from '@/lib/db/schema/autopilot';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  type MailOutreachRelevance,
} from '@/lib/db/schema/mailing';
import { notifications } from '@/lib/db/schema/notifications';
import { outreachDrafts, outreachQueue, type OutreachDraftStatus } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { qualifications } from '@/lib/db/schema/qualifications';
import { reviewItems, type ReviewItemState } from '@/lib/db/schema/review';
import { supportThreads } from '@/lib/db/schema/support';
import { workspaces } from '@/lib/db/schema/workspaces';
import { eq } from 'drizzle-orm';
import type { AttentionCountKey } from '@/lib/attention/types';
import { makeWorkspaceContext, type WorkspaceContext } from '@/lib/services/context';
import { createProductProfile } from '@/lib/services/product-profile';
import { seedUser, seedWorkspace } from './db';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

export interface AttentionFixture {
  workspaceId: bigint;
  ownerId: string;
  memberId: string;
  /** The owner's context (counts per user are the owner's). */
  ctx: WorkspaceContext;
  memberCtx: WorkspaceContext;
  products: bigint[];
  activeMailboxId: bigint;
  failingMailboxId: bigint | null;
  /** The numbers the summary must report for the owner. */
  expected: Partial<Record<AttentionCountKey, number>>;
  /** Threads by role (happyPath). */
  threads: Record<string, bigint>;
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq += 1)}`;

async function people(name: string, live: boolean) {
  const ownerId = await seedUser({
    email: `${name}-owner-${uniq()}@test.local`,
    name: `${name} owner`,
  });
  const memberId = await seedUser({
    email: `${name}-member-${uniq()}@test.local`,
    name: `${name} member`,
  });
  const workspaceId = await seedWorkspace({
    name,
    ownerUserId: ownerId,
    live,
    extraMembers: [{ userId: memberId, role: 'member' }],
  });
  return {
    workspaceId,
    ownerId,
    memberId,
    ctx: makeWorkspaceContext({ workspaceId, userId: ownerId, role: 'owner' }),
    memberCtx: makeWorkspaceContext({ workspaceId, userId: memberId, role: 'member' }),
  };
}

async function mailbox(
  workspaceId: bigint,
  status: 'active' | 'failing',
  extra: Partial<typeof mailboxes.$inferInsert> = {},
): Promise<bigint> {
  const n = uniq();
  const [row] = await db
    .insert(mailboxes)
    .values({
      workspaceId,
      name: extra.name ?? `box-${n}`,
      fromAddress: `box-${n}@test.local`,
      smtpHost: 'smtp.test.local',
      smtpUser: `box-${n}`,
      smtpPasswordSecretKey: `mailbox.smtp_${n}`,
      imapFolder: 'INBOX',
      status,
      ...extra,
    })
    .returning({ id: mailboxes.id });
  return row!.id;
}

/** Records with review items in `state`, judged by every product (only
 *  the first `relevant` relevant, for the first product). */
async function records(
  workspaceId: bigint,
  products: bigint[],
  n: number,
  opts: { state?: ReviewItemState; relevant?: number; at?: Date; assignedTo?: string | null } = {},
): Promise<Array<{ recordId: bigint; reviewItemId: bigint }>> {
  if (n === 0) return [];
  const at = opts.at ?? ago(2 * DAY);
  const out: Array<{ recordId: bigint; reviewItemId: bigint }> = [];
  // Batches keep each INSERT well under the bind-parameter limit.
  for (let start = 0; start < n; start += 1000) {
    const size = Math.min(1000, n - start);
    const srs = await db
      .insert(sourceRecords)
      .values(
        Array.from({ length: size }, () => ({
          workspaceId,
          sourceSystem: 'mock',
          sourceId: `att-${uniq()}`,
          rawData: {},
          normalizedData: { name: `Company ${seq}` },
        })),
      )
      .returning({ id: sourceRecords.id });
    const items = await db
      .insert(reviewItems)
      .values(
        srs.map((r) => ({
          workspaceId,
          sourceRecordId: r.id,
          state: opts.state ?? ('new' as const),
          assignedToUserId: opts.assignedTo ?? null,
          createdAt: at,
          updatedAt: at,
        })),
      )
      .returning({ id: reviewItems.id, sourceRecordId: reviewItems.sourceRecordId });
    for (const productId of products) {
      await db.insert(qualifications).values(
        items.map((it, i) => {
          const relevant = productId === products[0] && start + i < (opts.relevant ?? 0);
          return {
            workspaceId,
            sourceRecordId: it.sourceRecordId,
            productProfileId: productId,
            isRelevant: relevant,
            relevanceScore: relevant ? 85 : 20,
            confidence: 70,
            method: 'ai',
          };
        }),
      );
    }
    out.push(...items.map((it) => ({ recordId: it.sourceRecordId, reviewItemId: it.id })));
  }
  return out;
}

/** An approved record with a qualified lead and one draft of `status`. */
async function leadWithDraft(
  workspaceId: bigint,
  productId: bigint,
  status: OutreachDraftStatus,
  opts: { lead?: boolean; contactEmail?: string | null } = {},
): Promise<{ draftId: bigint; leadId: bigint | null; reviewItemId: bigint }> {
  const [rec] = await records(workspaceId, [productId], 1, { state: 'approved', relevant: 1 });
  let leadId: bigint | null = null;
  if (opts.lead !== false) {
    const [lead] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId,
        reviewItemId: rec!.reviewItemId,
        productProfileId: productId,
        state: 'relevant',
        contactEmail:
          opts.contactEmail === undefined ? `lead-${uniq()}@prospect.test` : opts.contactEmail,
      })
      .returning({ id: qualifiedLeads.id });
    leadId = lead!.id;
  }
  const [draft] = await db
    .insert(outreachDrafts)
    .values({
      workspaceId,
      reviewItemId: rec!.reviewItemId,
      sourceRecordId: rec!.recordId,
      productProfileId: productId,
      status,
      subject: `Quick question ${uniq()}`,
      body: 'Who handles concrete repair?',
      method: 'rules',
      ...(status === 'approved' ? { approvedAt: ago(3 * DAY) } : {}),
    })
    .returning({ id: outreachDrafts.id });
  return { draftId: draft!.id, leadId, reviewItemId: rec!.reviewItemId };
}

interface MessageSpec {
  direction: 'inbound' | 'outbound';
  at: Date;
  relevance?: MailOutreachRelevance;
  status?: 'sent' | 'failed' | 'received';
  trashed?: boolean;
  spam?: boolean;
}

/** One thread with its messages, oldest first. */
async function thread(
  workspaceId: bigint,
  mailboxId: bigint,
  messages: MessageSpec[],
): Promise<bigint> {
  const key = uniq();
  const [t] = await db
    .insert(mailThreads)
    .values({
      workspaceId,
      mailboxId,
      subject: `Thread ${key}`,
      externalThreadKey: `att-${key}`,
      participants: ['anna@prospect.test'],
      messageCount: messages.length,
      lastMessageAt: messages.at(-1)?.at ?? null,
    })
    .returning({ id: mailThreads.id });
  await db.insert(mailMessages).values(
    messages.map((m, i) => ({
      workspaceId,
      mailboxId,
      threadId: t!.id,
      direction: m.direction,
      status: m.status ?? (m.direction === 'inbound' ? ('received' as const) : ('sent' as const)),
      messageId: `<att-${key}-${i}@test>`,
      fromAddress: m.direction === 'inbound' ? 'anna@prospect.test' : 'sales@test.local',
      toAddresses: [m.direction === 'inbound' ? 'sales@test.local' : 'anna@prospect.test'],
      subject: `Re: Thread ${key}`,
      bodyText: `message ${i}`,
      outreachRelevance: m.direction === 'inbound' ? (m.relevance ?? 'prospect_reply') : null,
      createdAt: m.at,
      ...(m.direction === 'inbound' ? { receivedAt: m.at } : { sentAt: m.at }),
      ...(m.trashed ? { trashedAt: new Date() } : {}),
      ...(m.spam ? { spamAt: new Date(), spamReason: 'manual' } : {}),
    })),
  );
  return t!.id;
}

async function unread(workspaceId: bigint, userId: string | null, n: number): Promise<void> {
  if (n === 0) return;
  await db.insert(notifications).values(
    Array.from({ length: n }, (_, i) => ({
      workspaceId,
      userId,
      kind: 'lead.replied',
      title: `Reply from newsletter ${i}`,
    })),
  );
}

/** Production on 2026-10-01, times `scale`. */
export async function prodShaped(options: { scale?: number } = {}): Promise<AttentionFixture> {
  const scale = Math.max(1, Math.floor(options.scale ?? 1));
  const p = await people('prod', false);
  const products = [
    (await createProductProfile(p.ctx, { name: 'Vetrofluid' })).id,
    (await createProductProfile(p.ctx, { name: 'Concrete repair' })).id,
  ];
  // Every production workspace is on the trial; they predate plan limits,
  // which only gate NEW resources, so the two products stay.
  await db
    .update(workspaces)
    .set({ plan: 'trial', subscriptionStatus: 'trial' })
    .where(eq(workspaces.id, p.workspaceId));
  const failingMailboxId = await mailbox(p.workspaceId, 'failing', {
    name: 'sales',
    lastError: 'IMAP: Command failed',
    imapConsecutiveFailures: 13,
    imapNextSyncAfter: null,
  });
  const activeMailboxId = await mailbox(p.workspaceId, 'active', { name: 'inbox' });
  await records(p.workspaceId, products, 310 * scale, {
    relevant: 1,
    at: new Date('2026-07-08T12:00:00Z'),
  });
  // X1: the inbox is newsletters and other unrelated mail — 40 threads of
  // 3 messages per scale step, no outbound at all.
  for (let i = 0; i < 40 * scale; i += 1) {
    await thread(p.workspaceId, activeMailboxId, [
      { direction: 'inbound', at: ago((i % 50) * DAY + 3 * HOUR), relevance: 'bulk' },
      { direction: 'inbound', at: ago((i % 50) * DAY + 2 * HOUR), relevance: 'unrelated' },
      { direction: 'inbound', at: ago((i % 50) * DAY + HOUR), relevance: 'bulk' },
    ]);
  }
  // Production's one draft: its pair has no lead.
  await leadWithDraft(p.workspaceId, products[0]!, 'draft', { lead: false });
  await db.insert(autopilotSettings).values({
    workspaceId: p.workspaceId,
    autopilotEnabled: false,
    enableAutoApproveProjects: true,
    autoApproveThreshold: 70,
  });
  await unread(p.workspaceId, p.ownerId, 12);
  return {
    ...p,
    products,
    activeMailboxId,
    failingMailboxId,
    threads: {},
    expected: {
      'review.open': 310 * scale,
      'review.needsReview': 0,
      'review.mine': 0,
      'drafts.approve': 1,
      'followUps.approve': 0,
      'replies.awaiting': 0,
      'replies.overdue': 0,
      'notifications.unread': 12,
      'support.unread': 0,
    },
  };
}

/** A working loop in two products. */
export async function happyPath(): Promise<AttentionFixture> {
  const p = await people('happy', true);
  const products = [
    (await createProductProfile(p.ctx, { name: 'Sealer' })).id,
    (await createProductProfile(p.ctx, { name: 'Primer' })).id,
  ];
  const activeMailboxId = await mailbox(p.workspaceId, 'active', { name: 'sales' });

  // Review: 3 new (1 assigned to the owner), 1 needs_review (assigned to
  // the member); approved and rejected ones are decided.
  await records(p.workspaceId, products, 1, { relevant: 1, assignedTo: p.ownerId });
  await records(p.workspaceId, [products[1]!, products[0]!], 1, { relevant: 1 });
  await records(p.workspaceId, products, 1);
  await records(p.workspaceId, products, 1, {
    state: 'needs_review',
    relevant: 1,
    assignedTo: p.memberId,
  });
  await records(p.workspaceId, products, 1, { state: 'rejected' });
  await records(p.workspaceId, products, 1, { state: 'archived' });

  // Drafts in every status (each pair has one active draft).
  const drafts: Record<string, bigint> = {};
  for (const status of ['draft', 'needs_edit', 'approved', 'rejected', 'superseded'] as const) {
    drafts[status] = (await leadWithDraft(p.workspaceId, products[0]!, status)).draftId;
  }
  // The approved one is on its way.
  await db.insert(outreachQueue).values({
    workspaceId: p.workspaceId,
    mailboxId: activeMailboxId,
    draftId: drafts.approved!,
    toAddresses: ['lead@prospect.test'],
    subject: 'Quick question',
    bodyText: 'Hi',
    status: 'queued',
  });

  // Prospect threads.
  const threads: Record<string, bigint> = {};
  // Waiting more than a day.
  threads.waitingOld = await thread(p.workspaceId, activeMailboxId, [
    { direction: 'outbound', at: ago(3 * DAY) },
    { direction: 'inbound', at: ago(2 * DAY) },
  ]);
  // Waiting since this morning.
  threads.waitingNew = await thread(p.workspaceId, activeMailboxId, [
    { direction: 'outbound', at: ago(3 * DAY) },
    { direction: 'inbound', at: ago(2 * HOUR) },
  ]);
  // Our answer failed to send: still waiting.
  threads.answerFailed = await thread(p.workspaceId, activeMailboxId, [
    { direction: 'outbound', at: ago(4 * DAY) },
    { direction: 'inbound', at: ago(30 * HOUR) },
    { direction: 'outbound', at: ago(29 * HOUR), status: 'failed' },
  ]);
  // Answered.
  threads.answered = await thread(p.workspaceId, activeMailboxId, [
    { direction: 'outbound', at: ago(4 * DAY) },
    { direction: 'inbound', at: ago(3 * DAY) },
    { direction: 'outbound', at: ago(2 * DAY) },
  ]);
  // The prospect reply was trashed / flagged as spam.
  threads.trashed = await thread(p.workspaceId, activeMailboxId, [
    { direction: 'outbound', at: ago(3 * DAY) },
    { direction: 'inbound', at: ago(DAY), trashed: true },
  ]);
  threads.spam = await thread(p.workspaceId, activeMailboxId, [
    { direction: 'outbound', at: ago(3 * DAY) },
    { direction: 'inbound', at: ago(DAY), spam: true },
  ]);
  // Not prospect replies at all.
  threads.newsletter = await thread(p.workspaceId, activeMailboxId, [
    { direction: 'inbound', at: ago(5 * HOUR), relevance: 'bulk' },
  ]);
  threads.outOfOffice = await thread(p.workspaceId, activeMailboxId, [
    { direction: 'outbound', at: ago(DAY) },
    { direction: 'inbound', at: ago(20 * HOUR), relevance: 'auto_reply' },
  ]);

  // Follow-ups: 2 awaiting approval, 1 pending, 1 sent (on the answered lead).
  const lead = await leadWithDraft(p.workspaceId, products[1]!, 'approved');
  await db.insert(outreachQueue).values({
    workspaceId: p.workspaceId,
    mailboxId: activeMailboxId,
    draftId: lead.draftId,
    toAddresses: ['lead@prospect.test'],
    subject: 'Quick question',
    bodyText: 'Hi',
    status: 'sent',
  });
  await db.insert(outreachFollowUps).values(
    (['awaiting_approval', 'awaiting_approval', 'pending', 'sent'] as const).map((status, i) => ({
      workspaceId: p.workspaceId,
      qualifiedLeadId: lead.leadId!,
      threadId: threads.answered!,
      stepNumber: i + 1,
      totalSteps: 4,
      scheduledFor: new Date(Date.now() + (i + 1) * DAY),
      status,
    })),
  );

  await unread(p.workspaceId, p.ownerId, 2);
  await unread(p.workspaceId, p.memberId, 1);
  await db.insert(supportThreads).values([
    { workspaceId: p.workspaceId, subject: 'Help with mailboxes', customerUnread: true },
    { workspaceId: p.workspaceId, subject: 'Read already', customerUnread: false },
  ]);

  return {
    ...p,
    products,
    activeMailboxId,
    failingMailboxId: null,
    threads,
    expected: {
      'review.open': 4,
      'review.needsReview': 1,
      'review.mine': 1,
      'drafts.approve': 2,
      'followUps.approve': 2,
      'replies.awaiting': 3,
      'replies.overdue': 2,
      'notifications.unread': 2,
      'support.unread': 1,
    },
  };
}
