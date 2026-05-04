// Phase 36: deliverability dashboard. Read-only aggregator that joins
// data we already collect — outbound sends (mail_messages), opens
// (mail_messages.open_count + email_opens), inbound replies + their
// reply_classification (Phase 20), bounces (mail_messages.status +
// suppression_list reason), unsubscribes (suppression_list reason via
// Phase 35), and outreach_queue terminal states (Phase 19).
//
// Per-mailbox metrics come from mail_messages.mailbox_id; workspace-
// wide totals roll those up plus suppression_list (which isn't keyed
// to a mailbox) and outreach_queue (which is per-mailbox but useful
// in aggregate too).
//
// Pure read service. No mutations, no audit-log entries.

import { and, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  mailboxes,
  mailMessages,
  suppressionList,
  type MailboxStatus,
} from '@/lib/db/schema/mailing';
import {
  outreachQueue,
  type OutreachQueueStatus,
} from '@/lib/db/schema/outreach';
import type { WorkspaceContext } from './context';

export interface DeliverabilityRange {
  /** Window length in days. Clamped to [1, 365]. Default 30. */
  sinceDays?: number;
  /** Override the end of the window. Default = now. */
  until?: Date;
}

export interface MailboxDeliverability {
  mailboxId: string;
  mailboxName: string;
  fromAddress: string;
  status: MailboxStatus;
  /** Outbound messages with status in (sent, delivered) created in window. */
  sent: number;
  /** Subset of `sent` that recorded at least one open. */
  opened: number;
  /** Sum of open_count across the window's outbound. */
  totalOpens: number;
  /** Outbound with status='bounced' in window. */
  bounced: number;
  /** Outbound with status='failed' in window. */
  failed: number;
  /** Inbound replies received in window on this mailbox. */
  replied: number;
  /** Outreach queue rows that ended terminal states in window. */
  queueSent: number;
  queueSkipped: number;
  queueFailed: number;
  /** opened / max(sent, 1). */
  openRate: number;
  /** bounced / max(sent, 1). */
  bounceRate: number;
  /** replied / max(sent, 1). */
  replyRate: number;
}

export interface DeliverabilityTotals {
  sent: number;
  opened: number;
  totalOpens: number;
  bounced: number;
  failed: number;
  replied: number;
  /** Workspace-scoped (suppression isn't keyed to a mailbox). */
  unsubscribed: number;
  bouncedHardSuppressed: number;
  bouncedSoftSuppressed: number;
  queueSent: number;
  queueSkipped: number;
  queueFailed: number;
}

export interface DeliverabilityReport {
  windowStart: Date;
  windowEnd: Date;
  sinceDays: number;
  totals: DeliverabilityTotals;
  byMailbox: MailboxDeliverability[];
  /** Inbound reply classification breakdown over window. */
  replyClassifications: { classification: string; count: number }[];
}

function clampSinceDays(input: number | undefined): number {
  const n = Number.isFinite(input) ? Math.floor(input as number) : 30;
  if (n < 1) return 1;
  if (n > 365) return 365;
  return n;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Build the workspace deliverability report. All counts are scoped to
 * the workspace and the rolling time window.
 */
export async function getDeliverabilityReport(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  range: DeliverabilityRange = {},
): Promise<DeliverabilityReport> {
  const sinceDays = clampSinceDays(range.sinceDays);
  const windowEnd = range.until ?? new Date();
  const windowStart = new Date(windowEnd.getTime() - sinceDays * 24 * 60 * 60 * 1000);

  const wsCond = eq(mailMessages.workspaceId, ctx.workspaceId);

  // Per-mailbox outbound aggregate.
  const outboundConds: SQL[] = [
    wsCond,
    eq(mailMessages.direction, 'outbound'),
    gte(mailMessages.createdAt, windowStart),
  ];
  const outboundRows = await db
    .select({
      mailboxId: mailMessages.mailboxId,
      sent: sql<number>`count(*) filter (where ${mailMessages.status} in ('sent','delivered'))::int`,
      opened: sql<number>`count(*) filter (where ${mailMessages.status} in ('sent','delivered') and ${mailMessages.openCount} > 0)::int`,
      totalOpens: sql<number>`coalesce(sum(${mailMessages.openCount}) filter (where ${mailMessages.status} in ('sent','delivered')), 0)::int`,
      bounced: sql<number>`count(*) filter (where ${mailMessages.status} = 'bounced')::int`,
      failed: sql<number>`count(*) filter (where ${mailMessages.status} = 'failed')::int`,
    })
    .from(mailMessages)
    .where(and(...outboundConds))
    .groupBy(mailMessages.mailboxId);

  // Per-mailbox inbound replies in window.
  const inboundConds: SQL[] = [
    wsCond,
    eq(mailMessages.direction, 'inbound'),
    gte(mailMessages.createdAt, windowStart),
  ];
  const inboundRows = await db
    .select({
      mailboxId: mailMessages.mailboxId,
      replied: sql<number>`count(*)::int`,
    })
    .from(mailMessages)
    .where(and(...inboundConds))
    .groupBy(mailMessages.mailboxId);

  // Per-mailbox queue terminal states in window. Use updatedAt because
  // status flips (queued → sent / skipped / failed) update that column.
  const queueConds: SQL[] = [
    eq(outreachQueue.workspaceId, ctx.workspaceId),
    gte(outreachQueue.updatedAt, windowStart),
    inArray(outreachQueue.status, ['sent', 'skipped', 'failed'] as OutreachQueueStatus[]),
  ];
  const queueRows = await db
    .select({
      mailboxId: outreachQueue.mailboxId,
      status: outreachQueue.status,
      c: sql<number>`count(*)::int`,
    })
    .from(outreachQueue)
    .where(and(...queueConds))
    .groupBy(outreachQueue.mailboxId, outreachQueue.status);

  // All non-archived mailboxes — we want to render rows even for ones
  // with zero activity in the window.
  const mailboxRows = await db
    .select({
      id: mailboxes.id,
      name: mailboxes.name,
      fromAddress: mailboxes.fromAddress,
      status: mailboxes.status,
    })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, ctx.workspaceId));

  // Index helpers.
  const outboundBy = new Map<string, (typeof outboundRows)[number]>();
  for (const r of outboundRows) outboundBy.set(String(r.mailboxId), r);
  const inboundBy = new Map<string, number>();
  for (const r of inboundRows) inboundBy.set(String(r.mailboxId), Number(r.replied));
  const queueBy = new Map<string, { sent: number; skipped: number; failed: number }>();
  for (const r of queueRows) {
    const key = String(r.mailboxId);
    const cur = queueBy.get(key) ?? { sent: 0, skipped: 0, failed: 0 };
    if (r.status === 'sent') cur.sent = Number(r.c);
    else if (r.status === 'skipped') cur.skipped = Number(r.c);
    else if (r.status === 'failed') cur.failed = Number(r.c);
    queueBy.set(key, cur);
  }

  const byMailbox: MailboxDeliverability[] = mailboxRows.map((m) => {
    const id = String(m.id);
    const ob = outboundBy.get(id);
    const sent = Number(ob?.sent ?? 0);
    const opened = Number(ob?.opened ?? 0);
    const totalOpens = Number(ob?.totalOpens ?? 0);
    const bounced = Number(ob?.bounced ?? 0);
    const failed = Number(ob?.failed ?? 0);
    const replied = inboundBy.get(id) ?? 0;
    const q = queueBy.get(id) ?? { sent: 0, skipped: 0, failed: 0 };
    return {
      mailboxId: id,
      mailboxName: m.name,
      fromAddress: m.fromAddress,
      status: m.status,
      sent,
      opened,
      totalOpens,
      bounced,
      failed,
      replied,
      queueSent: q.sent,
      queueSkipped: q.skipped,
      queueFailed: q.failed,
      openRate: rate(opened, sent),
      bounceRate: rate(bounced, sent),
      replyRate: rate(replied, sent),
    };
  });

  // Sort: most-active mailboxes first, then by name for stable display.
  byMailbox.sort((a, b) => {
    if (b.sent !== a.sent) return b.sent - a.sent;
    return a.mailboxName.localeCompare(b.mailboxName);
  });

  // Workspace-scoped suppression counts in window.
  const suppressionRows = await db
    .select({
      reason: suppressionList.reason,
      c: sql<number>`count(*)::int`,
    })
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.workspaceId, ctx.workspaceId),
        gte(suppressionList.createdAt, windowStart),
      ),
    )
    .groupBy(suppressionList.reason);
  let unsubscribed = 0;
  let bouncedHardSuppressed = 0;
  let bouncedSoftSuppressed = 0;
  for (const r of suppressionRows) {
    if (r.reason === 'unsubscribe') unsubscribed = Number(r.c);
    else if (r.reason === 'bounce_hard') bouncedHardSuppressed = Number(r.c);
    else if (r.reason === 'bounce_soft') bouncedSoftSuppressed = Number(r.c);
  }

  // Reply classification breakdown.
  const replyClassRows = await db
    .select({
      classification: sql<string>`coalesce(${mailMessages.replyClassification}, 'unclassified')`,
      c: sql<number>`count(*)::int`,
    })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.direction, 'inbound'),
        gte(mailMessages.createdAt, windowStart),
      ),
    )
    .groupBy(sql`coalesce(${mailMessages.replyClassification}, 'unclassified')`);

  const replyClassifications = replyClassRows
    .map((r) => ({ classification: String(r.classification), count: Number(r.c) }))
    .sort((a, b) => b.count - a.count);

  // Totals — sum the per-mailbox numbers (no double-counting since each
  // message belongs to exactly one mailbox) and overlay the workspace-
  // scoped suppression rows.
  const totals: DeliverabilityTotals = {
    sent: byMailbox.reduce((a, b) => a + b.sent, 0),
    opened: byMailbox.reduce((a, b) => a + b.opened, 0),
    totalOpens: byMailbox.reduce((a, b) => a + b.totalOpens, 0),
    bounced: byMailbox.reduce((a, b) => a + b.bounced, 0),
    failed: byMailbox.reduce((a, b) => a + b.failed, 0),
    replied: byMailbox.reduce((a, b) => a + b.replied, 0),
    unsubscribed,
    bouncedHardSuppressed,
    bouncedSoftSuppressed,
    queueSent: byMailbox.reduce((a, b) => a + b.queueSent, 0),
    queueSkipped: byMailbox.reduce((a, b) => a + b.queueSkipped, 0),
    queueFailed: byMailbox.reduce((a, b) => a + b.queueFailed, 0),
  };

  return {
    windowStart,
    windowEnd,
    sinceDays,
    totals,
    byMailbox,
    replyClassifications,
  };
}
