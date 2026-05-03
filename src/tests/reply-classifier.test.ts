import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  mailMessages,
  mailThreads,
  suppressionList,
} from '@/lib/db/schema/mailing';
import {
  contactAssociations,
  contacts,
} from '@/lib/db/schema/contacts';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  analyseReply,
  classifyReply,
  getReplyAutoActions,
  updateReplyAutoActions,
} from '@/lib/services/reply-classifier';
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

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
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

// ============ analyseReply persistence + auto-actions ===============

/**
 * Insert a synthetic mail_thread + inbound mail_message + (optional)
 * lead with contact_association so analyseReply has something to act on.
 * Bypasses syncInbound to keep the test fast.
 */
async function seedSyntheticInbound(
  s: Setup,
  body: string,
  options: { withLead?: boolean } = {},
): Promise<{ messageId: bigint; leadId: bigint | null }> {
  const ws = s.workspaceA;
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
      externalThreadKey: `subj:re-hi-${Date.now()}`,
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
      messageId: `<reply-${Date.now()}@x.com>`,
      fromAddress: 'anna@target.com',
      toAddresses: ['sales@nulife.pl'],
      subject: 'Re: hi',
      bodyText: body,
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
        email: 'anna@target.com',
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
        sourceId: `fake-${Date.now()}`,
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
  return { messageId: msg!.id, leadId };
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

  it('unsubscribe auto-suppresses the sender + closes the lead', async () => {
    const s = await setup();
    const { messageId, leadId } = await seedSyntheticInbound(
      s,
      'please unsubscribe',
      { withLead: true },
    );
    await analyseReply(ctx(s.workspaceA, s.ownerA), messageId);
    const supps = await db
      .select()
      .from(suppressionList)
      .where(eq(suppressionList.workspaceId, s.workspaceA));
    expect(supps.find((e) => e.value === 'anna@target.com')).toBeTruthy();
    if (leadId) {
      const reloadedLead = await db
        .select()
        .from(qualifiedLeads)
        .where(eq(qualifiedLeads.id, leadId));
      expect(reloadedLead[0]!.state).toBe('closed');
    }
  });

  it('bounce auto-suppresses', async () => {
    const s = await setup();
    const { messageId } = await seedSyntheticInbound(
      s,
      'Mailer-Daemon: undeliverable',
    );
    await analyseReply(ctx(s.workspaceA, s.ownerA), messageId);
    const supps = await db
      .select()
      .from(suppressionList)
      .where(eq(suppressionList.workspaceId, s.workspaceA));
    expect(supps.find((e) => e.reason === 'bounce_hard')).toBeTruthy();
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

// ============ settings =============================================

describe('reply auto-actions settings', () => {
  it('lazy-creates defaults', async () => {
    const s = await setup();
    const settings = await getReplyAutoActions(ctx(s.workspaceA, s.ownerA));
    expect(settings.autoSuppressBounce).toBe(true);
    expect(settings.autoSuppressUnsubscribe).toBe(true);
    expect(settings.autoCloseNegative).toBe(false);
    expect(settings.autoExtractRedirects).toBe(true);
  });

  it('updates persist + audit', async () => {
    const s = await setup();
    const updated = await updateReplyAutoActions(ctx(s.workspaceA, s.ownerA), {
      autoCloseNegative: true,
      autoExtractRedirects: false,
    });
    expect(updated.autoCloseNegative).toBe(true);
    expect(updated.autoExtractRedirects).toBe(false);
  });
});
