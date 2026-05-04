import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  suppressionList,
} from '@/lib/db/schema/mailing';
import { outreachQueue } from '@/lib/db/schema/outreach';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { getDeliverabilityReport } from '@/lib/services/deliverability';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
  mailboxA1: bigint;
  mailboxA2: bigint;
  mailboxB1: bigint;
  threadA1: bigint;
  threadA2: bigint;
  threadB1: bigint;
}

async function seedMailbox(
  workspaceId: bigint,
  name: string,
  fromAddress: string,
  status: 'active' | 'paused' = 'active',
): Promise<bigint> {
  const [mb] = await db
    .insert(mailboxes)
    .values({
      workspaceId,
      name,
      fromAddress,
      smtpHost: 'smtp.x',
      smtpUser: fromAddress,
      smtpPasswordSecretKey: `mailbox.smtp_p36_${name}`,
      imapFolder: 'INBOX',
      status,
      isDefault: false,
    })
    .returning();
  return mb!.id;
}

async function seedThread(
  workspaceId: bigint,
  mailboxId: bigint,
  subject: string,
): Promise<bigint> {
  const [t] = await db
    .insert(mailThreads)
    .values({
      workspaceId,
      mailboxId,
      subject,
      externalThreadKey: `subj:${subject}-${Math.random()}`,
      participants: [],
    })
    .returning();
  return t!.id;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA-p36@test.local' });
  const ownerB = await seedUser({ email: 'ownerB-p36@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A36', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B36', ownerUserId: ownerB });
  const mailboxA1 = await seedMailbox(workspaceA, 'sales', 'sales@a.local');
  const mailboxA2 = await seedMailbox(workspaceA, 'support', 'support@a.local');
  const mailboxB1 = await seedMailbox(workspaceB, 'b-sales', 'sales@b.local');
  const threadA1 = await seedThread(workspaceA, mailboxA1, 'a1');
  const threadA2 = await seedThread(workspaceA, mailboxA2, 'a2');
  const threadB1 = await seedThread(workspaceB, mailboxB1, 'b1');
  return {
    workspaceA,
    workspaceB,
    ownerA,
    ownerB,
    mailboxA1,
    mailboxA2,
    mailboxB1,
    threadA1,
    threadA2,
    threadB1,
  };
}

interface InsertMessageOpts {
  workspaceId: bigint;
  mailboxId: bigint;
  threadId: bigint;
  direction: 'outbound' | 'inbound';
  status:
    | 'queued'
    | 'sending'
    | 'sent'
    | 'delivered'
    | 'bounced'
    | 'failed'
    | 'received';
  openCount?: number;
  replyClassification?: string;
  createdAt?: Date;
}

async function insertMessage(opts: InsertMessageOpts, idx: number): Promise<void> {
  await db.insert(mailMessages).values({
    workspaceId: opts.workspaceId,
    mailboxId: opts.mailboxId,
    threadId: opts.threadId,
    direction: opts.direction,
    status: opts.status,
    messageId: `<p36-${idx}-${Math.random().toString(36).slice(2)}@x>`,
    fromAddress: opts.direction === 'outbound' ? 'sender@a.local' : 'them@target.com',
    toAddresses:
      opts.direction === 'outbound' ? ['target@target.com'] : ['sender@a.local'],
    subject: 'hi',
    bodyText: 'hello',
    openCount: opts.openCount ?? 0,
    firstOpenedAt: (opts.openCount ?? 0) > 0 ? new Date() : null,
    replyClassification: opts.replyClassification ?? null,
    ...(opts.createdAt
      ? { createdAt: opts.createdAt, updatedAt: opts.createdAt }
      : {}),
  });
}

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('getDeliverabilityReport', () => {
  it('returns zeros for an empty workspace', async () => {
    const s = await setup();
    const r = await getDeliverabilityReport(ctx(s.workspaceA, s.ownerA));
    expect(r.totals.sent).toBe(0);
    expect(r.totals.opened).toBe(0);
    expect(r.totals.replied).toBe(0);
    expect(r.totals.bounced).toBe(0);
    expect(r.totals.unsubscribed).toBe(0);
    expect(r.byMailbox).toHaveLength(2); // both A mailboxes still listed
    expect(r.byMailbox.every((m) => m.sent === 0)).toBe(true);
    expect(r.replyClassifications).toEqual([]);
  });

  it('aggregates outbound sends, opens, bounces, and failures per mailbox', async () => {
    const s = await setup();
    // mailboxA1: 4 sent, 2 opened, 1 bounced, 0 failed
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'outbound', status: 'sent' },
      1,
    );
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'outbound', status: 'sent', openCount: 1 },
      2,
    );
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'outbound', status: 'sent', openCount: 3 },
      3,
    );
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'outbound', status: 'delivered' },
      4,
    );
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'outbound', status: 'bounced' },
      5,
    );
    // mailboxA2: 1 sent, 0 opened, 0 bounced, 1 failed
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA2, threadId: s.threadA2, direction: 'outbound', status: 'sent' },
      6,
    );
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA2, threadId: s.threadA2, direction: 'outbound', status: 'failed' },
      7,
    );

    const r = await getDeliverabilityReport(ctx(s.workspaceA, s.ownerA));
    expect(r.totals.sent).toBe(5); // 4 from A1 (sent + delivered) + 1 from A2
    expect(r.totals.opened).toBe(2); // both from A1
    expect(r.totals.totalOpens).toBe(4); // 1 + 3
    expect(r.totals.bounced).toBe(1);
    expect(r.totals.failed).toBe(1);

    const a1 = r.byMailbox.find((m) => m.mailboxId === String(s.mailboxA1))!;
    expect(a1.sent).toBe(4);
    expect(a1.opened).toBe(2);
    expect(a1.openRate).toBeCloseTo(0.5, 5);
    expect(a1.bounced).toBe(1);
    expect(a1.bounceRate).toBeCloseTo(0.25, 5);

    const a2 = r.byMailbox.find((m) => m.mailboxId === String(s.mailboxA2))!;
    expect(a2.sent).toBe(1);
    expect(a2.failed).toBe(1);

    // Most-active mailbox sorts first.
    expect(r.byMailbox[0]!.mailboxId).toBe(String(s.mailboxA1));
  });

  it('counts inbound replies per mailbox and classifies them', async () => {
    const s = await setup();
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'outbound', status: 'sent' },
      1,
    );
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'inbound', status: 'received', replyClassification: 'positive' },
      2,
    );
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'inbound', status: 'received', replyClassification: 'positive' },
      3,
    );
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'inbound', status: 'received', replyClassification: 'negative' },
      4,
    );
    // unclassified inbound — should bucket into 'unclassified'.
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'inbound', status: 'received' },
      5,
    );

    const r = await getDeliverabilityReport(ctx(s.workspaceA, s.ownerA));
    expect(r.totals.replied).toBe(4);
    const a1 = r.byMailbox.find((m) => m.mailboxId === String(s.mailboxA1))!;
    expect(a1.replied).toBe(4);
    expect(a1.replyRate).toBeCloseTo(4, 5); // 4 replies / 1 sent

    expect(r.replyClassifications.find((c) => c.classification === 'positive')?.count).toBe(2);
    expect(r.replyClassifications.find((c) => c.classification === 'negative')?.count).toBe(1);
    expect(r.replyClassifications.find((c) => c.classification === 'unclassified')?.count).toBe(1);
    // Sorted descending by count.
    expect(r.replyClassifications[0]!.classification).toBe('positive');
  });

  it('counts workspace-scoped suppression entries by reason', async () => {
    const s = await setup();
    await db.insert(suppressionList).values([
      { workspaceId: s.workspaceA, kind: 'email', address: 'a@x.com', value: 'a@x.com', reason: 'unsubscribe' },
      { workspaceId: s.workspaceA, kind: 'email', address: 'b@x.com', value: 'b@x.com', reason: 'unsubscribe' },
      { workspaceId: s.workspaceA, kind: 'email', address: 'c@x.com', value: 'c@x.com', reason: 'bounce_hard' },
      { workspaceId: s.workspaceA, kind: 'email', address: 'd@x.com', value: 'd@x.com', reason: 'bounce_soft' },
      // Other workspace — must not leak.
      { workspaceId: s.workspaceB, kind: 'email', address: 'a@x.com', value: 'a@x.com', reason: 'unsubscribe' },
    ]);

    const r = await getDeliverabilityReport(ctx(s.workspaceA, s.ownerA));
    expect(r.totals.unsubscribed).toBe(2);
    expect(r.totals.bouncedHardSuppressed).toBe(1);
    expect(r.totals.bouncedSoftSuppressed).toBe(1);

    const rB = await getDeliverabilityReport(ctx(s.workspaceB, s.ownerB));
    expect(rB.totals.unsubscribed).toBe(1);
    expect(rB.totals.bouncedHardSuppressed).toBe(0);
  });

  it('counts outreach_queue terminal states per mailbox', async () => {
    const s = await setup();
    await db.insert(outreachQueue).values([
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, toAddresses: ['x@y.com'], subject: 'q1', status: 'sent' },
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, toAddresses: ['x@y.com'], subject: 'q2', status: 'skipped', lastError: 'suppressed: x@y.com' },
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, toAddresses: ['x@y.com'], subject: 'q3', status: 'failed', lastError: 'smtp 550' },
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA2, toAddresses: ['x@y.com'], subject: 'q4', status: 'skipped', lastError: 'domain cooldown' },
      // queued / cancelled — should NOT count in any bucket.
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, toAddresses: ['x@y.com'], subject: 'q5', status: 'queued' },
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, toAddresses: ['x@y.com'], subject: 'q6', status: 'cancelled' },
    ]);

    const r = await getDeliverabilityReport(ctx(s.workspaceA, s.ownerA));
    expect(r.totals.queueSent).toBe(1);
    expect(r.totals.queueSkipped).toBe(2);
    expect(r.totals.queueFailed).toBe(1);

    const a1 = r.byMailbox.find((m) => m.mailboxId === String(s.mailboxA1))!;
    expect(a1.queueSent).toBe(1);
    expect(a1.queueSkipped).toBe(1);
    expect(a1.queueFailed).toBe(1);
    const a2 = r.byMailbox.find((m) => m.mailboxId === String(s.mailboxA2))!;
    expect(a2.queueSkipped).toBe(1);
  });

  it('respects the time window — older rows excluded', async () => {
    const s = await setup();
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'outbound', status: 'sent', createdAt: old },
      1,
    );
    await insertMessage(
      { workspaceId: s.workspaceA, mailboxId: s.mailboxA1, threadId: s.threadA1, direction: 'outbound', status: 'sent' },
      2,
    );

    const r7 = await getDeliverabilityReport(ctx(s.workspaceA, s.ownerA), { sinceDays: 7 });
    expect(r7.totals.sent).toBe(1); // only the recent one

    const r90 = await getDeliverabilityReport(ctx(s.workspaceA, s.ownerA), { sinceDays: 90 });
    expect(r90.totals.sent).toBe(2);
  });

  it('clamps sinceDays to [1, 365]', async () => {
    const s = await setup();
    const r0 = await getDeliverabilityReport(ctx(s.workspaceA, s.ownerA), { sinceDays: 0 });
    expect(r0.sinceDays).toBe(1);
    const rHuge = await getDeliverabilityReport(ctx(s.workspaceA, s.ownerA), { sinceDays: 9999 });
    expect(rHuge.sinceDays).toBe(365);
  });

  it('isolates workspaces — A does not see B', async () => {
    const s = await setup();
    await insertMessage(
      { workspaceId: s.workspaceB, mailboxId: s.mailboxB1, threadId: s.threadB1, direction: 'outbound', status: 'sent', openCount: 5 },
      1,
    );
    await db.insert(suppressionList).values({
      workspaceId: s.workspaceB,
      kind: 'email',
      address: 'leak@x.com',
      value: 'leak@x.com',
      reason: 'unsubscribe',
    });

    const rA = await getDeliverabilityReport(ctx(s.workspaceA, s.ownerA));
    expect(rA.totals.sent).toBe(0);
    expect(rA.totals.unsubscribed).toBe(0);
    expect(rA.byMailbox.every((m) => m.mailboxId !== String(s.mailboxB1))).toBe(true);

    const rB = await getDeliverabilityReport(ctx(s.workspaceB, s.ownerB));
    expect(rB.totals.sent).toBe(1);
    expect(rB.totals.opened).toBe(1);
    expect(rB.totals.unsubscribed).toBe(1);
  });
});
