// The platform shows only the conversations it started, and the replies
// to them (platformMailCondition, src/lib/services/mail-scope.ts).
//
// IMAP sync stores the whole synced folder — newsletters, colleagues,
// receipts, and on prod hundreds of rows from before the relevance gate
// (outreach_relevance NULL). None of it may reach Conversations, a mailbox
// page, the folder badges, the follow-up chips, a contact page, a thread
// page or Today.

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommunicationDetail from '@/app/(app)/communication/[threadId]/page';
import { expectRedirect, renderToHtml } from './helpers/next-render';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import { settleDetached } from '@/lib/detached';
import { db } from '@/lib/db/client';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import { mailMessages, mailThreads } from '@/lib/db/schema/mailing';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { productProfiles } from '@/lib/db/schema/products';
import { reviewItems } from '@/lib/db/schema/review';
import { handleClassifiedReply } from '@/lib/services/outreach-reply-handler';
import type { ReplyClassification } from '@/lib/services/reply-classifier';
import { getContactDetail, upsertContact } from '@/lib/services/contacts';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { createMailbox } from '@/lib/services/mailbox';
import {
  countMessagesByFolder,
  countMessagesMatching,
  listMessages,
} from '@/lib/services/mail';
import { MAIL_FOLDERS } from '@/lib/services/mail-folders';
import { countCommunicationByStatus, listCommunication } from '@/lib/services/communication';
import { getCommandPaletteIndex } from '@/lib/services/command-palette';
import { getDashboardSignals } from '@/lib/services/dashboard-signals';
import { describeSyncCounts, listPlatformThreadMessages } from '@/lib/services/mail-scope';
import type { OutreachRelevance } from '@/lib/mail/relevance';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

// The conversation page signs in through a plain session object instead
// of Auth.js; getWorkspaceContext() stays real.
const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  // The reply handler's learning hook runs detached; let it finish first.
  await settleDetached();
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

interface World {
  ctx: WorkspaceContext;
  mailboxId: bigint;
}

async function world(): Promise<World> {
  const owner = await seedUser({ email: 'scope-owner@test.local' });
  const workspaceId = await seedWorkspace({ name: 'scope', ownerUserId: owner });
  const ctx = makeWorkspaceContext({ workspaceId, userId: owner, role: 'owner' });
  const mb = await createMailbox(ctx, {
    name: 'sales',
    fromAddress: 'sales@scope.test',
    fromName: 'Sales',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: 'sales@scope.test',
    smtpPassword: 'secret',
    imap: null,
    isDefault: true,
  });
  return { ctx, mailboxId: mb.id };
}

let n = 0;
async function thread(w: World, subject: string): Promise<bigint> {
  n += 1;
  const [row] = await db
    .insert(mailThreads)
    .values({
      workspaceId: w.ctx.workspaceId,
      mailboxId: w.mailboxId,
      subject,
      externalThreadKey: `scope-thread-${n}-${Date.now()}`,
      lastMessageAt: new Date(),
    })
    .returning({ id: mailThreads.id });
  return row!.id;
}

async function message(
  w: World,
  threadId: bigint,
  m: {
    direction: 'inbound' | 'outbound';
    relevance?: OutreachRelevance | null;
    subject: string;
    status?: 'sent' | 'received';
    trashed?: boolean;
    spam?: boolean;
    at?: Date;
    signals?: Record<string, unknown>;
    from?: string;
    body?: string;
  },
): Promise<bigint> {
  n += 1;
  const [row] = await db
    .insert(mailMessages)
    .values({
      ...(m.at ? { createdAt: m.at } : {}),
      relevanceSignals: m.signals ?? null,
      spamAt: m.spam ? new Date() : null,
      workspaceId: w.ctx.workspaceId,
      mailboxId: w.mailboxId,
      threadId,
      direction: m.direction,
      status: m.status ?? (m.direction === 'outbound' ? 'sent' : 'received'),
      messageId: `<scope-${n}-${Date.now()}@test.local>`,
      fromAddress: m.from ?? (m.direction === 'outbound' ? 'sales@scope.test' : 'someone@else.test'),
      toAddresses: [m.direction === 'outbound' ? 'lead@target.test' : 'sales@scope.test'],
      subject: m.subject,
      bodyText: m.body ?? null,
      outreachRelevance: m.relevance ?? null,
      receivedAt: m.direction === 'inbound' ? new Date() : null,
      sentAt: m.direction === 'outbound' ? new Date() : null,
      trashedAt: m.trashed ? new Date() : null,
    })
    .returning({ id: mailMessages.id });
  return row!.id;
}

/** A mailbox like Francesco's: one conversation the platform started (our
 *  pitch, the lead's reply, an out-of-office, a bounce), plus the rest of
 *  the mailbox — a newsletter, a colleague, a pre-gate legacy row, and a
 *  trashed newsletter. */
async function mixedMailbox(w: World) {
  const ours = await thread(w, 'Pitch');
  await message(w, ours, { direction: 'outbound', subject: 'Pitch' });
  await message(w, ours, { direction: 'inbound', relevance: 'prospect_reply', subject: 'Re: Pitch' });
  await message(w, ours, { direction: 'inbound', relevance: 'auto_reply', subject: 'Out of office' });
  await message(w, ours, { direction: 'inbound', relevance: 'bounce', subject: 'Undeliverable' });

  const newsletter = await thread(w, 'Weekly digest');
  await message(w, newsletter, { direction: 'inbound', relevance: 'bulk', subject: 'Weekly digest' });
  const colleague = await thread(w, 'Lunch?');
  await message(w, colleague, { direction: 'inbound', relevance: 'unrelated', subject: 'Lunch?' });
  const legacy = await thread(w, 'Invoice 2026-06');
  await message(w, legacy, { direction: 'inbound', relevance: null, subject: 'Invoice 2026-06' });
  const trashedNews = await thread(w, 'Old promo');
  await message(w, trashedNews, {
    direction: 'inbound',
    relevance: 'bulk',
    subject: 'Old promo',
    trashed: true,
  });
  return { ours, newsletter, colleague, legacy };
}

const NOT_OURS = ['Weekly digest', 'Lunch?', 'Invoice 2026-06', 'Old promo'];

describe('Conversations list only platform mail', () => {
  it('the inbox lists replies to our mail and nothing else from the mailbox', async () => {
    const w = await world();
    await mixedMailbox(w);
    const inbox = await listMessages(w.ctx, { folder: 'inbox' });
    expect(inbox.map((r) => r.message.subject).sort()).toEqual(
      ['Out of office', 'Re: Pitch', 'Undeliverable'].sort(),
    );
    expect(await countMessagesMatching(w.ctx, { folder: 'inbox' })).toBe(3);
  });

  it('no folder lists or counts the rest of the mailbox — not even Trash', async () => {
    const w = await world();
    await mixedMailbox(w);
    const counts = await countMessagesByFolder(w.ctx);
    expect(counts).toEqual({ inbox: 3, sent: 1, queued: 0, errors: 0, spam: 0, trash: 0 });
    for (const folder of MAIL_FOLDERS) {
      const rows = await listMessages(w.ctx, { folder });
      for (const r of rows) expect(NOT_OURS).not.toContain(r.message.subject);
      expect(rows).toHaveLength(counts[folder]);
    }
    // The per-mailbox page counts the same way.
    expect(await countMessagesByFolder(w.ctx, w.mailboxId)).toEqual(counts);
  });

  it('a search cannot reach mail the platform did not start', async () => {
    const w = await world();
    await mixedMailbox(w);
    expect(await listMessages(w.ctx, { folder: 'inbox', search: 'digest' })).toHaveLength(0);
    expect(await listMessages(w.ctx, { folder: 'inbox', search: 'Pitch' })).toHaveLength(1);
  });
});

describe('the follow-up chips list only threads the platform started', () => {
  it('a thread with only mailbox mail is not listed', async () => {
    const w = await world();
    const { ours } = await mixedMailbox(w);
    const rows = await listCommunication(w.ctx);
    expect(rows.map((r) => r.threadId)).toEqual([ours]);
    expect(rows[0]!.derivedStatus).toBe('replied');
    expect((await countCommunicationByStatus(w.ctx)).all).toBe(1);
  });

  it('a newsletter filed on our thread does not make it "replied"', async () => {
    const w = await world();
    const ours = await thread(w, 'Pitch');
    await message(w, ours, { direction: 'outbound', subject: 'Pitch' });
    // Subject threading can file unrelated mail next to our outreach.
    await message(w, ours, { direction: 'inbound', relevance: 'bulk', subject: 'Pitch weekly' });
    const rows = await listCommunication(w.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.derivedStatus).toBe('sent');
  });
});

describe('a contact page lists only platform mail', () => {
  it("a lead contact's newsletter and old mail stay off the contact page", async () => {
    const w = await world();
    const contact = await upsertContact(w.ctx, { email: 'someone@else.test' });
    const { ours, newsletter, colleague, legacy } = await mixedMailbox(w);
    // Sync links every message and thread from a known address to the contact.
    await db
      .update(mailMessages)
      .set({ contactId: contact.id })
      .where(eq(mailMessages.workspaceId, w.ctx.workspaceId));
    await db.insert(contactAssociations).values(
      [ours, newsletter, colleague, legacy].map((t) => ({
        workspaceId: w.ctx.workspaceId,
        contactId: contact.id,
        entityType: 'mail_thread',
        entityId: t.toString(),
      })),
    );
    const detail = await getContactDetail(w.ctx, contact.id);
    expect(detail.threads.map((t) => t.id)).toEqual([ours]);
    expect(detail.recentMessages.map((m) => m.subject).sort()).toEqual(
      ['Pitch', 'Re: Pitch', 'Out of office', 'Undeliverable'].sort(),
    );
  });
});

describe('Today counts replies, not inbound mail', () => {
  it('replies7d and the recent-replies card ignore the rest of the mailbox', async () => {
    const w = await world();
    await mixedMailbox(w);
    const signals = await getDashboardSignals(w.ctx);
    expect(signals.degraded).toBe(false);
    // A person answering us; the out-of-office and the bounce are not replies.
    expect(signals.replies7d).toBe(1);
    expect(signals.recentInbound.map((m) => m.subject)).toEqual(['Re: Pitch']);
  });

  it('a reply the user trashed or flagged as spam is not waiting for them', async () => {
    const w = await world();
    const ours = await thread(w, 'Pitch');
    await message(w, ours, { direction: 'outbound', subject: 'Pitch' });
    await message(w, ours, { direction: 'inbound', relevance: 'prospect_reply', subject: 'Re: Pitch' });
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'prospect_reply',
      subject: 'Re: Pitch (trashed)',
      trashed: true,
    });
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'prospect_reply',
      subject: 'Re: Pitch (spam)',
      spam: true,
    });
    const signals = await getDashboardSignals(w.ctx);
    expect(signals.replies7d).toBe(1);
    expect(signals.recentInbound.map((m) => m.subject)).toEqual(['Re: Pitch']);
  });
});

describe('one thread as the thread page and the reply assistant read it', () => {
  it('drops mailbox mail filed on our thread and keeps the conversation in order', async () => {
    const w = await world();
    const ours = await thread(w, 'Pitch');
    const t0 = Date.now() - 60 * 60_000;
    await message(w, ours, { direction: 'outbound', subject: 'Pitch', at: new Date(t0) });
    // Subject threading filed a newsletter between our pitch and the reply.
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'bulk',
      subject: 'Pitch weekly',
      at: new Date(t0 + 60_000),
    });
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'prospect_reply',
      subject: 'Re: Pitch',
      at: new Date(t0 + 120_000),
    });
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'prospect_reply',
      subject: 'Re: Pitch (trashed)',
      trashed: true,
      at: new Date(t0 + 180_000),
    });
    const all = await listPlatformThreadMessages(w.ctx, ours);
    expect(all.map((m) => m.subject)).toEqual(['Pitch', 'Re: Pitch', 'Re: Pitch (trashed)']);
    const visible = await listPlatformThreadMessages(w.ctx, ours, { excludeHidden: true });
    expect(visible.map((m) => m.subject)).toEqual(['Pitch', 'Re: Pitch']);
  });

  it("a thread of mailbox mail reads as empty — and so does another workspace's thread", async () => {
    const w = await world();
    const { ours, newsletter, legacy } = await mixedMailbox(w);
    expect(await listPlatformThreadMessages(w.ctx, newsletter)).toEqual([]);
    expect(await listPlatformThreadMessages(w.ctx, legacy)).toEqual([]);
    const otherOwner = await seedUser({ email: 'scope-other@test.local' });
    const otherWs = await seedWorkspace({ name: 'scope-other', ownerUserId: otherOwner });
    expect(await listPlatformThreadMessages({ workspaceId: otherWs }, ours)).toEqual([]);
  });
});

describe('the outreach reply drafts read only the conversation', () => {
  /** Records every prompt the composers send. */
  class CapturingAi implements IAIProvider {
    public readonly id = 'capture';
    public readonly model = 'capture-1';
    public prompts: string[] = [];
    async generateText(i: AIGenInput): Promise<AIGenResult> {
      this.prompts.push(`${i.system ?? ''}\n${i.prompt}`);
      return { text: 'Happy to explain.', model: this.model, usage: { inputTokens: 1, outputTokens: 1 } };
    }
    async generateJson<T>(): Promise<T> {
      throw new Error('not used');
    }
    estimateCost(): number {
      return 0;
    }
    async healthCheck() {
      return { ok: true, detail: 'capture' };
    }
  }

  const question: ReplyClassification = {
    type: 'question',
    confidence: 80,
    rationale: 'test',
    extractedEmails: [],
    suggestedAction: 'human_review',
  };

  /** The qualified lead whose outreach conversation is `threadId`, linked
   *  the way the reply handler finds it (contact → thread, contact → lead). */
  async function leadOnThread(w: World, threadId: bigint, email: string): Promise<void> {
    const ws = w.ctx.workspaceId;
    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: ws, email, name: 'Lena Lead', status: 'active' })
      .returning();
    const [source] = await db
      .insert(sourceRecords)
      .values({
        workspaceId: ws,
        sourceSystem: 'mock',
        sourceId: `scope-lead-${threadId}`,
        rawData: {},
        normalizedData: {},
        sourceUrl: 'https://target.test',
      })
      .returning();
    const [review] = await db
      .insert(reviewItems)
      .values({ workspaceId: ws, sourceRecordId: source!.id, state: 'new' })
      .returning();
    const [product] = await db
      .insert(productProfiles)
      .values({ workspaceId: ws, name: 'Panels' })
      .returning();
    const [lead] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId: ws,
        reviewItemId: review!.id,
        productProfileId: product!.id,
        state: 'relevant',
        relevantAt: new Date(),
        contactEmail: email,
      })
      .returning();
    await db.insert(contactAssociations).values([
      { workspaceId: ws, contactId: contact!.id, entityType: 'mail_thread', entityId: threadId.toString() },
      { workspaceId: ws, contactId: contact!.id, entityType: 'qualified_lead', entityId: lead!.id.toString() },
    ]);
  }

  afterEach(() => {
    _setAIProviderForTests(null);
  });

  it("a newsletter, a colleague's mail and a trashed or spammed reply on the thread never reach the composer", async () => {
    const w = await world();
    const ours = await thread(w, 'Pitch');
    const t0 = Date.now() - 60 * 60_000;
    const at = (min: number) => new Date(t0 + min * 60_000);
    await message(w, ours, { direction: 'outbound', subject: 'Pitch', body: 'PITCH-BODY-OURS', at: at(0) });
    // Subject threading filed mailbox mail on our outreach thread.
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'bulk',
      subject: 'Pitch weekly',
      from: 'news@digest.test',
      body: 'DIGEST-BODY-NEWSLETTER',
      at: at(1),
    });
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'unrelated',
      subject: 'Pitch deck?',
      from: 'colleague@else.test',
      body: 'COLLEAGUE-BODY-LUNCH',
      at: at(2),
    });
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'prospect_reply',
      subject: 'Re: Pitch',
      from: 'lead@target.test',
      body: 'TRASHED-REPLY-BODY',
      trashed: true,
      at: at(3),
    });
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'prospect_reply',
      subject: 'Re: Pitch',
      from: 'lead@target.test',
      body: 'SPAMMED-REPLY-BODY',
      spam: true,
      at: at(4),
    });
    const replyId = await message(w, ours, {
      direction: 'inbound',
      relevance: 'prospect_reply',
      subject: 'Re: Pitch',
      from: 'lead@target.test',
      body: 'REPLY-BODY-HOW-DOES-IT-WORK',
      at: at(5),
    });
    await leadOnThread(w, ours, 'lead@target.test');
    const ai = new CapturingAi();
    _setAIProviderForTests(ai);

    const r = await handleClassifiedReply(w.ctx, replyId, question);
    expect(r.action.kind).toBe('draft');
    expect(r.draftIds).toHaveLength(1);
    const [draft] = await db.select().from(outreachDrafts).where(eq(outreachDrafts.id, r.draftIds[0]!));
    const promptUser = (draft!.evidence as { promptUser: string }).promptUser;
    const sent = ai.prompts.join('\n');
    for (const prompt of [sent, promptUser]) {
      expect(prompt).toContain('PITCH-BODY-OURS');
      expect(prompt).toContain('REPLY-BODY-HOW-DOES-IT-WORK');
      expect(prompt.indexOf('PITCH-BODY-OURS')).toBeLessThan(prompt.indexOf('REPLY-BODY-HOW-DOES-IT-WORK'));
      for (const absent of [
        'DIGEST-BODY-NEWSLETTER',
        'news@digest.test',
        'COLLEAGUE-BODY-LUNCH',
        'TRASHED-REPLY-BODY',
        'SPAMMED-REPLY-BODY',
      ]) {
        expect(prompt).not.toContain(absent);
      }
    }
  });
});

describe('the conversation page (/communication/[threadId])', () => {
  async function open(w: World, threadId: bigint): Promise<string> {
    session.current = {
      user: { id: w.ctx.userId.toString(), role: 'member', accountStatus: 'active' },
    };
    const tree = await CommunicationDetail({
      params: Promise.resolve({ threadId: threadId.toString() }),
      searchParams: Promise.resolve({}),
    });
    return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
  }

  it('shows our conversation without the newsletter filed on it', async () => {
    const w = await world();
    const ours = await thread(w, 'Pitch');
    // A message bubble shows the sender and the body (never the subject,
    // and the reply form already says "Re: Pitch"), so each message gets
    // its own sender and body to look for.
    await message(w, ours, { direction: 'outbound', subject: 'Pitch', body: 'PITCH-BODY-OURS' });
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'bulk',
      subject: 'Weekly digest',
      from: 'news@digest.test',
      body: 'DIGEST-BODY-NEWSLETTER',
    });
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'prospect_reply',
      subject: 'Re: Pitch',
      from: 'lead@target.test',
      body: 'REPLY-BODY-FROM-LEAD',
    });
    const html = await open(w, ours);
    expect(html).toContain('PITCH-BODY-OURS');
    expect(html).toContain('REPLY-BODY-FROM-LEAD');
    expect(html).not.toContain('DIGEST-BODY-NEWSLETTER');
    expect(html).not.toContain('news@digest.test');
  });

  it('a thread of mailbox mail, opened by its URL, goes back to Conversations', async () => {
    const w = await world();
    const { newsletter } = await mixedMailbox(w);
    const target = await expectRedirect(() => open(w, newsletter));
    const url = new URL(target, 'http://app.test');
    expect(url.pathname).toBe('/communication');
    expect(url.searchParams.get('message')).toContain('not started by the platform');
  });
});

describe('replies the relevance gate did not class as replies', () => {
  it('a pre-gate reply (relevance NULL) shows on a thread holding our outbound, nowhere else', async () => {
    const w = await world();
    const ours = await thread(w, 'Pitch');
    await message(w, ours, { direction: 'outbound', subject: 'Pitch' });
    await message(w, ours, { direction: 'inbound', relevance: null, subject: 'Re: Pitch (legacy)' });
    const elsewhere = await thread(w, 'Invoice 2026-06');
    await message(w, elsewhere, { direction: 'inbound', relevance: null, subject: 'Invoice 2026-06' });

    const inbox = await listMessages(w.ctx, { folder: 'inbox' });
    expect(inbox.map((r) => r.message.subject)).toEqual(['Re: Pitch (legacy)']);
    const rows = await listCommunication(w.ctx);
    expect(rows.map((r) => r.threadId)).toEqual([ours]);
    expect(rows[0]!.derivedStatus).toBe('replied');
  });

  it("a colleague's reply-all to our outreach stays in the conversation", async () => {
    const w = await world();
    const ours = await thread(w, 'Pitch');
    await message(w, ours, { direction: 'outbound', subject: 'Pitch' });
    // The gate keeps a reply from one of our own mailboxes 'unrelated' (no
    // suppression, no reply handler) but records that it answers our mail.
    await message(w, ours, {
      direction: 'inbound',
      relevance: 'unrelated',
      subject: 'Re: Pitch (colleague)',
      signals: { evidence: { references_our_outbound: true, sender_is_own_mailbox: true } },
    });
    const lunch = await thread(w, 'Lunch?');
    await message(w, lunch, {
      direction: 'inbound',
      relevance: 'unrelated',
      subject: 'Lunch?',
      signals: { evidence: { references_our_outbound: false, sender_is_own_mailbox: true } },
    });

    const visible = await listPlatformThreadMessages(w.ctx, ours);
    expect(visible.map((m) => m.subject)).toEqual(['Pitch', 'Re: Pitch (colleague)']);
    const inbox = await listMessages(w.ctx, { folder: 'inbox' });
    expect(inbox.map((r) => r.message.subject)).toEqual(['Re: Pitch (colleague)']);
    expect((await listCommunication(w.ctx)).map((r) => r.threadId)).toEqual([ours]);
  });
});

describe('thread counts and times follow platform mail only', () => {
  it('a newsletter filed on our thread neither raises its count nor moves it up', async () => {
    const w = await world();
    const now = Date.now();
    const older = await thread(w, 'Older pitch');
    await message(w, older, { direction: 'outbound', subject: 'Older pitch', at: new Date(now - 2 * 3600_000) });
    await message(w, older, {
      direction: 'inbound',
      relevance: 'bulk',
      subject: 'Older pitch digest',
      at: new Date(now),
    });
    // What touchThread leaves on the denormalised columns after that sync.
    await db
      .update(mailThreads)
      .set({ messageCount: 2, lastMessageAt: new Date(now) })
      .where(eq(mailThreads.id, older));
    const newer = await thread(w, 'Newer pitch');
    await message(w, newer, { direction: 'outbound', subject: 'Newer pitch', at: new Date(now - 3600_000) });
    await db
      .update(mailThreads)
      .set({ messageCount: 1, lastMessageAt: new Date(now - 3600_000) })
      .where(eq(mailThreads.id, newer));

    const rows = await listCommunication(w.ctx);
    expect(rows.map((r) => r.threadId)).toEqual([newer, older]);
    const olderRow = rows.find((r) => r.threadId === older)!;
    expect(olderRow.messageCount).toBe(1);
    expect(olderRow.lastMessageAt?.getTime()).toBe(now - 2 * 3600_000);
    // The date filter reads the same time: the digest is not activity.
    const lastHour = await listCommunication(w.ctx, { dateFrom: new Date(now - 90 * 60_000) });
    expect(lastHour.map((r) => r.threadId)).toEqual([newer]);

    const palette = (await getCommandPaletteIndex(w.ctx)).filter((e) => e.kind === 'thread');
    expect(palette.map((e) => e.label)).toEqual(['Newer pitch', 'Older pitch']);

    const contact = await upsertContact(w.ctx, { email: 'lead@target.test' });
    await db.insert(contactAssociations).values(
      [older, newer].map((t) => ({
        workspaceId: w.ctx.workspaceId,
        contactId: contact.id,
        entityType: 'mail_thread',
        entityId: t.toString(),
      })),
    );
    const detail = await getContactDetail(w.ctx, contact.id);
    expect(detail.threads.map((t) => t.id)).toEqual([newer, older]);
    expect(detail.threads.find((t) => t.id === older)!.messageCount).toBe(1);
  });

  it('the command palette lists only threads the platform started', async () => {
    const w = await world();
    await mixedMailbox(w);
    const palette = (await getCommandPaletteIndex(w.ctx)).filter((e) => e.kind === 'thread');
    expect(palette.map((e) => e.label)).toEqual(['Pitch']);
  });
});

describe('a sync says what reaches Conversations', () => {
  it('describeSyncCounts separates replies from the rest of the mailbox', () => {
    expect(describeSyncCounts({ fetched: 40, inserted: 0, replies: 0 })).toBe('fetched 40, nothing new');
    expect(describeSyncCounts({ fetched: 3, inserted: 2, replies: 2 })).toBe(
      'fetched 3: 2 new in Conversations',
    );
    expect(describeSyncCounts({ fetched: 40, inserted: 39, replies: 1 })).toBe(
      'fetched 40: 1 new in Conversations, 38 other mailbox messages not shown',
    );
    expect(describeSyncCounts({ fetched: 2, inserted: 1, replies: 0 })).toBe(
      'fetched 2: 0 new in Conversations, 1 other mailbox message not shown',
    );
  });
});
