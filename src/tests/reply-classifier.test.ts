import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  mailMessages,
  mailThreads,
  suppressionList,
  type MailOutreachRelevance,
} from '@/lib/db/schema/mailing';
import { auditLog } from '@/lib/db/schema/audit';
import { settleDetached } from '@/lib/detached';
import {
  contactAssociations,
  contacts,
} from '@/lib/db/schema/contacts';
import { pipelineEvents, qualifiedLeads } from '@/lib/db/schema/pipeline';
import { outreachThreadState } from '@/lib/db/schema/outreach';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  analyseReply,
  classifyReply,
  constrainToRelevance,
  type ReplyClassification,
} from '@/lib/services/reply-classifier';
import {
  getReplyAutoActionsImpact,
  updateReplyAutoActions,
} from '@/lib/services/reply-auto-actions';
import { handleClassifiedReply } from '@/lib/services/outreach-reply-handler';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role'] = 'owner'): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

let seedCounter = 0;

beforeEach(async () => {
  await truncateAll();
  seedCounter = 0;
});

afterAll(async () => {
  // Let detached hooks (the reply handler's learning hook) finish before
  // the client closes; truncateAll does the same between tests.
  await settleDetached();
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ pure heuristic ========================================

describe('classifyReply (heuristic)', () => {
  it('detects unsubscribe', () => {
    const r = classifyReply('please unsubscribe me from this list');
    expect(r.type).toBe('unsubscribe');
    expect(r.suggestedAction).toBe('suppress');
  });

  it('detects bounce', () => {
    const r = classifyReply('Mailer-Daemon: your message was undeliverable');
    expect(r.type).toBe('bounce');
  });

  it('detects out-of-office', () => {
    const r = classifyReply('I am out of the office until next Monday');
    expect(r.type).toBe('out_of_office');
    expect(r.suggestedAction).toBe('wait_retry');
  });

  it('detects negative replies', () => {
    expect(classifyReply('not interested, thanks').type).toBe('negative');
    expect(classifyReply('please stop emailing').type).toBe('negative');
  });

  it('detects redirect + extracts emails', () => {
    const r = classifyReply(
      'Please contact john.smith@partner.example for this — they are a better fit.',
    );
    expect(r.type).toBe('redirect');
    expect(r.extractedEmails).toContain('john.smith@partner.example');
  });

  it('detects doc requests', () => {
    const r = classifyReply('Could you send the spec sheet please?');
    expect(r.type).toBe('doc_request');
  });

  it('falls back to question for plain ?', () => {
    const r = classifyReply('What is the lead time?');
    expect(r.type).toBe('question');
  });

  it('detects interest', () => {
    const r = classifyReply('we are interested — would love to learn more');
    expect(r.type).toBe('interest');
  });

  it('detects positive', () => {
    const r = classifyReply('Sure, sounds good');
    expect(r.type).toBe('positive');
  });

  it('returns irrelevant on empty body', () => {
    const r = classifyReply('   ');
    expect(r.type).toBe('irrelevant');
  });
});

describe('constrainToRelevance (flow:F-01)', () => {
  const unsub = classifyReply('please unsubscribe me');
  const redirect = classifyReply('Please contact erik@partner.example instead.');

  it('a prospect reply keeps its classification', () => {
    expect(constrainToRelevance(unsub, 'prospect_reply')).toBe(unsub);
  });

  it('an auto-reply is out-of-office unless it redirects', () => {
    const c = constrainToRelevance(unsub, 'auto_reply');
    expect(c.type).toBe('out_of_office');
    expect(c.suggestedAction).toBe('wait_retry');
    expect(constrainToRelevance(redirect, 'auto_reply')).toBe(redirect);
  });

  it('a delivery report is a bounce whatever its text says', () => {
    const c = constrainToRelevance(classifyReply('Sure, sounds good'), 'bounce');
    expect(c).toMatchObject({ type: 'bounce', extractedEmails: [] });
  });
});

// ============ analyseReply persistence + auto-actions ===============

/**
 * Insert a synthetic mail_thread + inbound mail_message + (optional)
 * lead with contact_association so analyseReply has something to act on.
 * Bypasses syncInbound to keep the test fast.
 */
async function seedSyntheticInbound(
  s: Setup,
  body: string,
  options: {
    withLead?: boolean;
    /** flow:F-01 relevance; defaults to a proven prospect reply. */
    relevance?: MailOutreachRelevance | null;
    fromAddress?: string;
  } = {},
): Promise<{ messageId: bigint; leadId: bigint | null; threadId: bigint }> {
  const ws = s.workspaceA;
  // Unique per seed within a test (several seeds may run in one ms); the
  // first seed's contact keeps the historical address.
  const n = ++seedCounter;
  const contactEmail = n === 1 ? 'anna@target.com' : `anna+${n}@target.com`;
  // Mailbox row stub — needed because mail_message.mailbox_id is FK.
  const { mailboxes } = await import('@/lib/db/schema/mailing');
  const [mb] = await db
    .insert(mailboxes)
    .values({
      workspaceId: ws,
      name: 'sales',
      fromAddress: 'sales@nulife.pl',
      smtpHost: 'smtp.x',
      smtpUser: 'sales@nulife.pl',
      smtpPasswordSecretKey: 'mailbox.smtpPassword_fixedfortests',
      imapFolder: 'INBOX',
      status: 'active',
      isDefault: true,
    })
    .returning();
  // Thread.
  const [thread] = await db
    .insert(mailThreads)
    .values({
      workspaceId: ws,
      mailboxId: mb!.id,
      subject: 'Re: hi',
      externalThreadKey: `subj:re-hi-${Date.now()}-${n}`,
      participants: ['anna@target.com', 'sales@nulife.pl'],
    })
    .returning();
  // Inbound message.
  const [msg] = await db
    .insert(mailMessages)
    .values({
      workspaceId: ws,
      mailboxId: mb!.id,
      threadId: thread!.id,
      direction: 'inbound',
      status: 'received',
      messageId: `<reply-${Date.now()}-${n}@x.com>`,
      fromAddress: options.fromAddress ?? 'anna@target.com',
      toAddresses: ['sales@nulife.pl'],
      subject: 'Re: hi',
      bodyText: body,
      outreachRelevance:
        options.relevance === undefined ? 'prospect_reply' : options.relevance,
    })
    .returning();
  let leadId: bigint | null = null;
  if (options.withLead) {
    const { sourceRecords } = await import('@/lib/db/schema/connectors');
    const { reviewItems: ri } = await import('@/lib/db/schema/review');
    const { productProfiles } = await import('@/lib/db/schema/products');
    const [contact] = await db
      .insert(contacts)
      .values({
        workspaceId: ws,
        email: contactEmail,
        name: 'Anna',
        status: 'active',
      })
      .returning();
    await db.insert(contactAssociations).values({
      workspaceId: ws,
      contactId: contact!.id,
      entityType: 'mail_thread',
      entityId: thread!.id.toString(),
    });
    const [sr] = await db
      .insert(sourceRecords)
      .values({
        workspaceId: ws,
        sourceSystem: 'mock',
        sourceId: `fake-${Date.now()}-${n}`,
        rawData: {},
        normalizedData: {},
        sourceUrl: 'https://example.com',
      })
      .returning();
    const [riRow] = await db
      .insert(ri)
      .values({
        workspaceId: ws,
        sourceRecordId: sr!.id,
        state: 'new',
      })
      .returning();
    const [product] = await db
      .insert(productProfiles)
      .values({ workspaceId: ws, name: 'P' })
      .returning();
    const [lead] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId: ws,
        reviewItemId: riRow!.id,
        productProfileId: product!.id,
        state: 'relevant',
        relevantAt: new Date(),
      })
      .returning();
    leadId = lead!.id;
    await db.insert(contactAssociations).values({
      workspaceId: ws,
      contactId: contact!.id,
      entityType: 'qualified_lead',
      entityId: lead!.id.toString(),
    });
  }
  return { messageId: msg!.id, leadId, threadId: thread!.id };
}

const unsubscribeVerdict: ReplyClassification = {
  type: 'unsubscribe',
  confidence: 70,
  rationale: 'test',
  extractedEmails: [],
  suggestedAction: 'suppress',
};

async function suppressionsOf(workspaceId: bigint) {
  return db
    .select()
    .from(suppressionList)
    .where(eq(suppressionList.workspaceId, workspaceId));
}

async function refusalsOf(workspaceId: bigint) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, workspaceId),
        eq(auditLog.kind, 'reply.auto_suppress_refused'),
      ),
    );
}

async function leadState(leadId: bigint | null) {
  const [row] = await db
    .select()
    .from(qualifiedLeads)
    .where(eq(qualifiedLeads.id, leadId!));
  return row!;
}

describe('analyseReply (DB-backed)', { timeout: 15000 }, () => {
  it('writes classification fields onto the message + audits', async () => {
    const s = await setup();
    const { messageId } = await seedSyntheticInbound(
      s,
      'Could you share the spec sheet?',
    );
    const result = await analyseReply(ctx(s.workspaceA, s.ownerA), messageId, {
      skipAutoActions: true,
    });
    expect(result.type).toBe('doc_request');
    const reloaded = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, messageId));
    expect(reloaded[0]!.replyClassification).toBe('doc_request');
    expect(reloaded[0]!.replyClassificationConfidence).toBeGreaterThan(50);
    expect(reloaded[0]!.replyClassifiedAt).toBeInstanceOf(Date);
  });

  // ia:F-03: the suppression switches default to OFF (migration 0062).
  it('autoSuppressUnsubscribe off (default): an unsubscribe-classified reply adds no suppression and leaves the lead open', async () => {
    const s = await setup();
    const { messageId, leadId, threadId } = await seedSyntheticInbound(
      s,
      'please unsubscribe',
      { withLead: true },
    );
    const verdict = await analyseReply(ctx(s.workspaceA, s.ownerA), messageId);
    expect(verdict.type).toBe('unsubscribe');
    expect(await suppressionsOf(s.workspaceA)).toHaveLength(0);
    expect((await leadState(leadId)).state).toBe('relevant');
    // The outreach handler (which ran via analyseReply) left the thread open too.
    const [state] = await db
      .select()
      .from(outreachThreadState)
      .where(eq(outreachThreadState.threadId, threadId));
    expect(state?.closedAt ?? null).toBeNull();
  });

  it('autoSuppressBounce off (default): a bounce-classified message adds no suppression', async () => {
    const s = await setup();
    const { messageId, leadId } = await seedSyntheticInbound(
      s,
      'Mailer-Daemon: undeliverable',
      { withLead: true },
    );
    const verdict = await analyseReply(ctx(s.workspaceA, s.ownerA), messageId);
    expect(verdict.type).toBe('bounce');
    expect(await suppressionsOf(s.workspaceA)).toHaveLength(0);
    expect((await leadState(leadId)).state).toBe('relevant');
  });

  it('the outreach handler alone honours autoSuppressUnsubscribe=false (no suppression, no close)', async () => {
    const s = await setup();
    const { messageId, leadId, threadId } = await seedSyntheticInbound(
      s,
      'please unsubscribe',
      { withLead: true },
    );
    const result = await handleClassifiedReply(
      ctx(s.workspaceA, s.ownerA),
      messageId,
      unsubscribeVerdict,
    );
    expect(result.action).toEqual({ kind: 'close_and_suppress', reason: 'unsubscribe' });
    expect(result.draftIds).toEqual([]);
    expect(await suppressionsOf(s.workspaceA)).toHaveLength(0);
    expect((await leadState(leadId)).state).toBe('relevant');
    const [state] = await db
      .select()
      .from(outreachThreadState)
      .where(eq(outreachThreadState.threadId, threadId));
    expect(state!.closedAt).toBeNull();
  });

  it('the outreach handler alone suppresses + closes when autoSuppressUnsubscribe is on', async () => {
    const s = await setup();
    await updateReplyAutoActions(ctx(s.workspaceA, s.ownerA), {
      autoSuppressUnsubscribe: true,
    });
    const { messageId, leadId, threadId } = await seedSyntheticInbound(
      s,
      'please unsubscribe',
      { withLead: true },
    );
    await handleClassifiedReply(ctx(s.workspaceA, s.ownerA), messageId, unsubscribeVerdict);
    const supps = await suppressionsOf(s.workspaceA);
    expect(supps.map((e) => e.value)).toEqual(['anna@target.com']);
    expect(supps[0]).toMatchObject({ source: 'reply', sourceRef: `mail_message:${messageId}` });
    expect((await leadState(leadId)).state).toBe('closed');
    const [state] = await db
      .select()
      .from(outreachThreadState)
      .where(eq(outreachThreadState.threadId, threadId));
    expect(state!.closedAt).toBeInstanceOf(Date);
  });

  it('autoSuppressUnsubscribe on: unsubscribe suppresses the sender, closes the lead, and both show in the impact count', async () => {
    const s = await setup();
    await updateReplyAutoActions(ctx(s.workspaceA, s.ownerA), {
      autoSuppressUnsubscribe: true,
    });
    const { messageId, leadId } = await seedSyntheticInbound(
      s,
      'please unsubscribe',
      { withLead: true },
    );
    await analyseReply(ctx(s.workspaceA, s.ownerA), messageId);
    const supp = (await suppressionsOf(s.workspaceA)).find(
      (e) => e.value === 'anna@target.com',
    );
    expect(supp).toBeTruthy();
    // F-03: automatic adds carry their provenance.
    expect(supp!.source).toBe('reply');
    expect(supp!.sourceRef).toBe(`mail_message:${messageId}`);
    expect((await leadState(leadId)).state).toBe('closed');

    // The close is tagged as automatic on its pipeline event…
    const events = await db
      .select()
      .from(pipelineEvents)
      .where(
        and(
          eq(pipelineEvents.qualifiedLeadId, leadId!),
          eq(pipelineEvents.toState, 'closed'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      replyAutoAction: 'unsubscribe',
      sourceMessageId: messageId.toString(),
    });
    // …so the settings page can count it.
    const impact = await getReplyAutoActionsImpact(ctx(s.workspaceA, s.ownerA));
    expect(impact).toMatchObject({
      suppressedAddresses: 1,
      stillSuppressed: 1,
      closedLeads: 1,
    });
  });

  // flow:F-01: bounce auto-suppression stays off until F-32 — even with the
  // switch on, a bounce suppresses nobody and closes nothing; the refusal is
  // audited so the owner can see the switch did not act.
  it('autoSuppressBounce on: a bounce is refused (F-32) — no suppression, lead open, refusal audited', async () => {
    const s = await setup();
    await updateReplyAutoActions(ctx(s.workspaceA, s.ownerA), {
      autoSuppressBounce: true,
    });
    const { messageId, leadId } = await seedSyntheticInbound(
      s,
      'Delivery to the following recipient failed permanently',
      { withLead: true, relevance: 'bounce', fromAddress: 'mailer-daemon@mx.target.com' },
    );
    const verdict = await analyseReply(ctx(s.workspaceA, s.ownerA), messageId);
    expect(verdict.type).toBe('bounce');
    expect(await suppressionsOf(s.workspaceA)).toHaveLength(0);
    expect((await leadState(leadId)).state).toBe('relevant');
    const refused = await refusalsOf(s.workspaceA);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused.every((r) => r.entityId === messageId.toString())).toBe(true);
    expect(refused.map((r) => (r.payload as { path: string }).path).sort()).toEqual([
      'outreach_reply_handler',
      'reply_classifier',
    ]);
    expect(refused[0]!.payload).toMatchObject({ trigger: 'bounce', relevance: 'bounce' });
  });

  it('autoSuppressUnsubscribe on: an auto-reply that says "unsubscribe" is read as out-of-office and suppresses nobody', async () => {
    const s = await setup();
    await updateReplyAutoActions(ctx(s.workspaceA, s.ownerA), {
      autoSuppressUnsubscribe: true,
    });
    const { messageId, leadId } = await seedSyntheticInbound(
      s,
      'I am away. To unsubscribe from my notifications, ignore this.',
      { withLead: true, relevance: 'auto_reply' },
    );
    const verdict = await analyseReply(ctx(s.workspaceA, s.ownerA), messageId);
    expect(verdict.type).toBe('out_of_office');
    expect(await suppressionsOf(s.workspaceA)).toHaveLength(0);
    expect((await leadState(leadId)).state).toBe('relevant');
  });

  it('mail that is not about our outreach is never classified, whatever the switches say', async () => {
    const s = await setup();
    await updateReplyAutoActions(ctx(s.workspaceA, s.ownerA), {
      autoSuppressUnsubscribe: true,
      autoCloseNegative: true,
    });
    for (const relevance of ['bulk', 'unrelated', null] as const) {
      const { messageId, leadId } = await seedSyntheticInbound(
        s,
        'please unsubscribe — not interested',
        { withLead: true, relevance },
      );
      const verdict = await analyseReply(ctx(s.workspaceA, s.ownerA), messageId);
      expect(verdict.type, String(relevance)).toBe('irrelevant');
      expect(verdict.rationale).toContain('not a reply to our outreach');
      const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, messageId));
      expect(row!.replyClassification).toBeNull();
      expect((await leadState(leadId)).state).toBe('relevant');
    }
    expect(await suppressionsOf(s.workspaceA)).toHaveLength(0);
    const classified = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, s.workspaceA), eq(auditLog.kind, 'reply.classify')));
    expect(classified).toHaveLength(0);
  });

  it('the outreach handler alone refuses to suppress from a message that is not a prospect reply', async () => {
    const s = await setup();
    await updateReplyAutoActions(ctx(s.workspaceA, s.ownerA), {
      autoSuppressUnsubscribe: true,
    });
    // Not linked to outreach at all: the handler does nothing.
    const bulk = await seedSyntheticInbound(s, 'unsubscribe', { withLead: true, relevance: 'bulk' });
    const r1 = await handleClassifiedReply(ctx(s.workspaceA, s.ownerA), bulk.messageId, unsubscribeVerdict);
    expect(r1.action.kind).toBe('none');
    // Linked, but machine-sent: the switch is on, the guard says no.
    const oof = await seedSyntheticInbound(s, 'unsubscribe', { withLead: true, relevance: 'auto_reply' });
    const r2 = await handleClassifiedReply(ctx(s.workspaceA, s.ownerA), oof.messageId, unsubscribeVerdict);
    expect(r2.action).toEqual({ kind: 'close_and_suppress', reason: 'unsubscribe' });
    expect(await suppressionsOf(s.workspaceA)).toHaveLength(0);
    expect((await leadState(oof.leadId)).state).toBe('relevant');
    const refused = await refusalsOf(s.workspaceA);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.payload).toMatchObject({
      trigger: 'unsubscribe',
      relevance: 'auto_reply',
      path: 'outreach_reply_handler',
    });
  });

  it('classifies the sender\'s own words: a quoted unsubscribe footer does not make a reply an unsubscribe', async () => {
    const s = await setup();
    await updateReplyAutoActions(ctx(s.workspaceA, s.ownerA), {
      autoSuppressUnsubscribe: true,
    });
    const { messageId, leadId } = await seedSyntheticInbound(
      s,
      [
        'Thanks - could you send the datasheet?',
        '',
        'On Tue, 29 Sep 2026 at 10:05, Sales <sales@nulife.pl> wrote:',
        '> Hello',
        '> ---',
        "> Don't want these messages? Unsubscribe: https://app.example/api/unsubscribe/abc",
      ].join('\n'),
      { withLead: true },
    );
    const verdict = await analyseReply(ctx(s.workspaceA, s.ownerA), messageId, {
      skipAutoActions: true,
    });
    expect(verdict.type).toBe('doc_request');
    // The quoted attribution's address is not "extracted" as a redirect target.
    expect(verdict.extractedEmails).toEqual([]);
    expect(await suppressionsOf(s.workspaceA)).toHaveLength(0);
    expect((await leadState(leadId)).state).toBe('relevant');
  });

  it('redirect auto-creates the extracted contact', async () => {
    const s = await setup();
    const { messageId } = await seedSyntheticInbound(
      s,
      'Please contact erik@partner.example for procurement.',
    );
    await analyseReply(ctx(s.workspaceA, s.ownerA), messageId);
    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.workspaceId, s.workspaceA));
    expect(rows.find((c) => c.email === 'erik@partner.example')).toBeTruthy();
  });

  it('autoCloseNegative is OFF by default — leaves lead open', async () => {
    const s = await setup();
    const { messageId, leadId } = await seedSyntheticInbound(
      s,
      'not interested, thanks',
      { withLead: true },
    );
    await analyseReply(ctx(s.workspaceA, s.ownerA), messageId);
    if (leadId) {
      const reloaded = await db
        .select()
        .from(qualifiedLeads)
        .where(eq(qualifiedLeads.id, leadId));
      expect(reloaded[0]!.state).toBe('relevant');
    }
  });

  it('autoCloseNegative ON closes lead on negative reply', async () => {
    const s = await setup();
    await updateReplyAutoActions(ctx(s.workspaceA, s.ownerA), {
      autoCloseNegative: true,
    });
    const { messageId, leadId } = await seedSyntheticInbound(
      s,
      'not interested at all',
      { withLead: true },
    );
    await analyseReply(ctx(s.workspaceA, s.ownerA), messageId);
    if (leadId) {
      const reloaded = await db
        .select()
        .from(qualifiedLeads)
        .where(eq(qualifiedLeads.id, leadId));
      expect(reloaded[0]!.state).toBe('closed');
      expect(reloaded[0]!.closeReason).toBe('lost');
    }
  });
});

// Settings authz / audit / impact / migration: reply-auto-actions.test.ts.
