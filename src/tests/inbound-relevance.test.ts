// flow:F-01 — inbound relevance gate (X1, I161, I165).
//
// Fixture .eml files go through the real parser (parseRawMessage →
// mailparser), then through the pure decision and the DB-backed
// assessment / syncInbound path.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  mailMessages,
  mailboxes,
  suppressionList,
  type MailMessage,
} from '@/lib/db/schema/mailing';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import { notifications } from '@/lib/db/schema/notifications';
import { auditLog, usageLog } from '@/lib/db/schema/audit';
import { tokenTransactions } from '@/lib/db/schema/tokens';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { MockMailProvider, type InboundMessage } from '@/lib/mail';
import { parseRawMessage } from '@/lib/mail/smtp-imap';
import {
  classifyInboundRelevance,
  extractRelevanceSignals,
  messageIdKey,
  type RelevanceFacts,
} from '@/lib/mail/relevance';
import { extractReplyText } from '@/lib/mail/reply-text';
import { makeWorkspaceContext, type WorkspaceContext } from '@/lib/services/context';
import { syncInbound } from '@/lib/services/mail';
import {
  assessInboundRelevance,
  autoSuppressionRefusal,
  backfillInboundRelevance,
  type StoredRelevanceSignals,
} from '@/lib/services/inbound-relevance';
import { updateReplyAutoActions } from '@/lib/services/reply-auto-actions';
import { maybeAutoTranslateInbound } from '@/lib/services/translation';
import { settleDetached } from '@/lib/detached';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

const FIXTURES = path.resolve(__dirname, 'fixtures/mail');

/** Our outbound Message-ID the fixtures answer / report on. */
const OUR_ID = '<7b2e9c41-3a5d-4f08-9e6b-1c2d3e4f5a6b@nulife.pl>';

async function parseFixture(name: string): Promise<InboundMessage> {
  const parsed = await parseRawMessage(readFileSync(path.join(FIXTURES, name)), 1);
  if (!parsed) throw new Error(`fixture ${name} did not parse`);
  return parsed;
}

const NO_FACTS: RelevanceFacts = {
  referencesOurOutbound: false,
  dsnMatchesOurOutbound: false,
  senderIsContactedLead: false,
  senderIsOwnMailbox: false,
};

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

interface Setup {
  ws: bigint;
  owner: string;
  mailboxId: bigint;
}

async function setup(): Promise<Setup> {
  const owner = await seedUser({ email: 'owner@test.local' });
  const ws = await seedWorkspace({ name: 'Relevance', ownerUserId: owner });
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
  return { ws, owner, mailboxId: mb!.id };
}

async function seedOutbound(
  s: Setup,
  input: { messageId: string; to: string[]; status?: MailMessage['status']; sentAt?: Date },
): Promise<void> {
  await db.insert(mailMessages).values({
    workspaceId: s.ws,
    mailboxId: s.mailboxId,
    direction: 'outbound',
    status: input.status ?? 'sent',
    messageId: input.messageId,
    fromAddress: 'sales@nulife.pl',
    toAddresses: input.to,
    subject: 'Who handles glazing on your team?',
    bodyText: 'Hello',
    sentAt: input.sentAt ?? new Date(),
  });
}

async function seedLead(s: Setup, contactEmail: string): Promise<bigint> {
  const { sourceRecords } = await import('@/lib/db/schema/connectors');
  const { reviewItems } = await import('@/lib/db/schema/review');
  const { productProfiles } = await import('@/lib/db/schema/products');
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId: s.ws,
      sourceSystem: 'mock',
      sourceId: `rel-${Date.now()}-${Math.random()}`,
      rawData: {},
      normalizedData: {},
      sourceUrl: 'https://target.example',
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({ workspaceId: s.ws, sourceRecordId: sr!.id, state: 'new' })
    .returning();
  const [product] = await db
    .insert(productProfiles)
    .values({ workspaceId: s.ws, name: 'Panels' })
    .returning();
  const [lead] = await db
    .insert(qualifiedLeads)
    .values({
      workspaceId: s.ws,
      reviewItemId: ri!.id,
      productProfileId: product!.id,
      state: 'relevant',
      relevantAt: new Date(),
      contactEmail,
    })
    .returning();
  return lead!.id;
}

async function syncFixtures(s: Setup, names: string[]): Promise<void> {
  const provider = new MockMailProvider();
  for (const name of names) provider.enqueueInbound(await parseFixture(name));
  await syncInbound(ctx(s.ws, s.owner), s.mailboxId, provider);
}

async function inboundByMessageId(ws: bigint, messageId: string): Promise<MailMessage> {
  const [row] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.workspaceId, ws), eq(mailMessages.messageId, messageId)));
  if (!row) throw new Error(`no inbound ${messageId}`);
  return row;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await settleDetached();
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ parse layer ===========================================

describe('parseRawMessage: signals captured at parse time', () => {
  it('a newsletter keeps List-Unsubscribe and ESP markers, and stores headers JSON-safely', async () => {
    const m = await parseFixture('newsletter.eml');
    expect(m.relevanceSignals).toMatchObject({
      source: 'parser',
      list_unsubscribe: true,
      list_headers: true,
      esp_markers: ['feedback-id', 'x-sg-eid'],
      content_type: 'multipart/alternative',
      dsn: null,
    });
    // The old String() pass stored List-* / Content-Type as '[object Object]'.
    expect(JSON.stringify(m.headers)).not.toContain('[object Object]');
    expect(m.headers['list-unsubscribe']).toContain('https://weekly-industry.example/u/421337');
    expect(m.headers['content-type']).toMatch(/^multipart\/alternative;/);
    // Encoded words stay decoded for the human-facing headers.
    expect(m.headers.subject).toBe('This week: concrete prices, new EU rules');
    expect(m.headers.from).toBe('"Building Materials Weekly" <news@weekly-industry.example>');
    expect(Array.isArray(m.headers.received) || typeof m.headers.received === 'string').toBe(true);
  });

  it('a Postfix DSN keeps its delivery-status block and the returned Message-ID', async () => {
    const m = await parseFixture('postfix-dsn.eml');
    const dsn = m.relevanceSignals!.dsn!;
    expect(m.relevanceSignals).toMatchObject({
      content_type: 'multipart/report',
      report_type: 'delivery-status',
      sender_role: 'mailer_daemon',
      auto_submitted: 'auto-replied',
    });
    expect(dsn.recipients).toEqual([
      expect.objectContaining({
        final_recipient: 'gone@target.example',
        action: 'failed',
        status: '5.1.1',
      }),
    ]);
    expect(dsn.recipients[0]!.diagnostic_code).toContain('User unknown');
    expect(dsn.original_message_id).toBe(OUR_ID);
    expect(dsn.original_message_id_source).toBe('rfc822_headers');
    // The report is no longer lost with the attachments: the body shows it.
    expect(m.textBody).toContain('Final-Recipient: rfc822; Gone@Target.example');
  });

  it('an Exchange NDR falls back to the Message-ID of the attached message/rfc822', async () => {
    const m = await parseFixture('exchange-ndr.eml');
    const dsn = m.relevanceSignals!.dsn!;
    expect(m.relevanceSignals!.sender_role).toBe('postmaster');
    expect(dsn.recipients.map((r) => r.final_recipient)).toEqual([
      'jan.kowalski@contoso-buyer.example',
    ]);
    expect(dsn.recipients[0]!.status).toBe('5.1.10');
    expect(dsn.original_message_id).toBe('<c0ffee00-1111-4222-8333-944455556666@nulife.pl>');
    expect(dsn.original_message_id_source).toBe('message_rfc822');
  });

  it('an OOF reply carries its auto markers', async () => {
    const m = await parseFixture('auto-reply.eml');
    expect(m.relevanceSignals).toMatchObject({
      auto_submitted: 'auto-replied',
      x_auto_response_suppress: 'All',
      list_unsubscribe: false,
      dsn: null,
    });
    expect(m.inReplyTo).toBe(OUR_ID);
  });

  it('legacy stored headers still say what survived (folded list key, precedence, sender)', () => {
    const legacy = extractRelevanceSignals({
      headers: {
        list: '[object Object]',
        'content-type': '[object Object]',
        precedence: 'Bulk',
        'auto-submitted': 'auto-generated',
        'x-mailchimp-campaign': 'abc',
      },
      fromAddress: 'no-reply@shop.example',
      source: 'stored_headers',
    });
    expect(legacy).toMatchObject({
      source: 'stored_headers',
      list_headers: true,
      list_unsubscribe: false,
      precedence: 'bulk',
      auto_submitted: 'auto-generated',
      esp_markers: ['x-mailchimp-campaign'],
      content_type: null,
      sender_role: 'noreply',
    });
  });
});

describe('extractReplyText', () => {
  it('drops the quoted history and our unsubscribe footer', async () => {
    const m = await parseFixture('prospect-reply.eml');
    const text = extractReplyText(m.textBody);
    expect(text).toContain('Could you send the spec sheet');
    expect(text).not.toMatch(/unsubscribe/i);
    expect(text).not.toContain('wrote:');
  });

  it('cuts at an Outlook header block and at a localized attribution', () => {
    const outlook = [
      'Not now, thanks.',
      '',
      '________________________________',
      'From: Sales <sales@nulife.pl>',
      'Sent: Tuesday, 29 September 2026 10:05',
      'To: Anna',
      'Subject: Who handles glazing?',
      '',
      'Hello Anna',
      '---',
      "Don't want these messages? Unsubscribe: https://app.example/api/unsubscribe/abc",
    ].join('\n');
    expect(extractReplyText(outlook)).toBe('Not now, thanks.');

    const polish = [
      'Proszę o katalog.',
      '',
      'wt., 29 wrz 2026 o 10:05 Sales <sales@nulife.pl> napisał(a):',
      '> Dzień dobry',
    ].join('\n');
    expect(extractReplyText(polish)).toBe('Proszę o katalog.');
  });

  it('keeps inline answers written above quoted lines, strips a bare footer', () => {
    const body = [
      'Yes, interested.',
      '> Would you like a sample?',
      'Please send two.',
      '',
      '---',
      'Nie chcesz otrzymywać tych wiadomości? Anuluj subskrypcję: https://x.example/api/unsubscribe/t',
    ].join('\n');
    expect(extractReplyText(body)).toBe('Yes, interested.\nPlease send two.');
  });
});

// ============ pure decision on real fixtures ========================

describe('classifyInboundRelevance on parsed fixtures', () => {
  it('newsletter, LinkedIn, Substack, mailing list and no-reply receipt are bulk', async () => {
    for (const name of [
      'newsletter.eml',
      'linkedin-notification.eml',
      'substack-post.eml',
      'mailing-list.eml',
      'receipt-noreply.eml',
    ]) {
      const m = await parseFixture(name);
      const verdict = classifyInboundRelevance(m.relevanceSignals!, NO_FACTS);
      expect(verdict.relevance, name).toBe('bulk');
    }
  });

  it('colleague mail is unrelated', async () => {
    const m = await parseFixture('colleague.eml');
    expect(classifyInboundRelevance(m.relevanceSignals!, NO_FACTS).relevance).toBe('unrelated');
  });

  it('a DSN is a bounce only when it is about our mail', async () => {
    const m = await parseFixture('postfix-dsn.eml');
    expect(
      classifyInboundRelevance(m.relevanceSignals!, { ...NO_FACTS, dsnMatchesOurOutbound: true })
        .relevance,
    ).toBe('bounce');
    expect(classifyInboundRelevance(m.relevanceSignals!, NO_FACTS).relevance).toBe('unrelated');
  });

  it('a reference to our outbound is a prospect reply, or an auto reply with auto markers', async () => {
    const reply = await parseFixture('prospect-reply.eml');
    const oof = await parseFixture('auto-reply.eml');
    const facts = { ...NO_FACTS, referencesOurOutbound: true };
    expect(classifyInboundRelevance(reply.relevanceSignals!, facts).relevance).toBe(
      'prospect_reply',
    );
    expect(classifyInboundRelevance(oof.relevanceSignals!, facts).relevance).toBe('auto_reply');
  });

  it("a contacted lead's address counts only without bulk signals; our own mailbox never counts", async () => {
    const lead = await parseFixture('lead-contact-no-refs.eml');
    expect(
      classifyInboundRelevance(lead.relevanceSignals!, { ...NO_FACTS, senderIsContactedLead: true })
        .relevance,
    ).toBe('prospect_reply');
    const newsletter = await parseFixture('newsletter.eml');
    expect(
      classifyInboundRelevance(newsletter.relevanceSignals!, {
        ...NO_FACTS,
        senderIsContactedLead: true,
      }).relevance,
    ).toBe('bulk');
    const reply = await parseFixture('prospect-reply.eml');
    expect(
      classifyInboundRelevance(reply.relevanceSignals!, {
        ...NO_FACTS,
        referencesOurOutbound: true,
        senderIsOwnMailbox: true,
      }).relevance,
    ).toBe('unrelated');
  });
});

describe('autoSuppressionRefusal', () => {
  it('allows only an unsubscribe from a proven prospect reply', () => {
    expect(autoSuppressionRefusal({ outreachRelevance: 'prospect_reply' }, 'unsubscribe')).toBeNull();
    for (const r of ['auto_reply', 'bounce', 'bulk', 'unrelated', null] as const) {
      expect(autoSuppressionRefusal({ outreachRelevance: r }, 'unsubscribe')).toMatch(
        /not a reply to our outreach/,
      );
    }
    expect(autoSuppressionRefusal({ outreachRelevance: 'prospect_reply' }, 'bounce')).toMatch(
      /F-32/,
    );
  });
});

// ============ DB-backed assessment ===================================

describe('assessInboundRelevance (DB facts)', { timeout: 20000 }, () => {
  it('matches In-Reply-To to our Message-ID case-insensitively', async () => {
    const s = await setup();
    await seedOutbound(s, { messageId: OUR_ID, to: ['anna@target.example'] });
    const m = await parseFixture('prospect-reply.eml');
    expect(m.inReplyTo).not.toBe(OUR_ID); // upper-case in the fixture
    const a = await assessInboundRelevance(ctx(s.ws, s.owner), {
      fromAddress: m.from.address,
      inReplyTo: m.inReplyTo,
      references: m.references,
      receivedAt: m.receivedAt,
      signals: m.relevanceSignals!,
    });
    expect(a.relevance).toBe('prospect_reply');
    expect(a.signals.evidence).toMatchObject({
      references_our_outbound: true,
      matched_message_ids: [messageIdKey(OUR_ID)],
    });
  });

  it('a reply referencing a FAILED send of ours is not proof (we never delivered it)', async () => {
    const s = await setup();
    await seedOutbound(s, { messageId: OUR_ID, to: ['anna@target.example'], status: 'failed' });
    const m = await parseFixture('prospect-reply.eml');
    const a = await assessInboundRelevance(ctx(s.ws, s.owner), {
      fromAddress: m.from.address,
      inReplyTo: m.inReplyTo,
      references: m.references,
      receivedAt: m.receivedAt,
      signals: m.relevanceSignals!,
    });
    expect(a.relevance).toBe('unrelated');
  });

  it('a DSN is a bounce by its returned Message-ID, or by a recently mailed Final-Recipient', async () => {
    const s = await setup();
    const dsn = await parseFixture('postfix-dsn.eml');
    const input = {
      fromAddress: dsn.from.address,
      inReplyTo: dsn.inReplyTo,
      references: dsn.references,
      receivedAt: new Date(),
      signals: dsn.relevanceSignals!,
    };
    // Mail we never sent.
    expect((await assessInboundRelevance(ctx(s.ws, s.owner), input)).relevance).toBe('unrelated');

    // Different Message-ID, but we mailed the Final-Recipient yesterday.
    await seedOutbound(s, {
      messageId: '<other@nulife.pl>',
      to: ['GONE@target.example'],
      sentAt: new Date(Date.now() - 86_400_000),
    });
    const byRecipient = await assessInboundRelevance(ctx(s.ws, s.owner), input);
    expect(byRecipient.relevance).toBe('bounce');
    expect(byRecipient.signals.evidence.matched_message_ids).toEqual([]);

    // Our Message-ID in the returned headers.
    await seedOutbound(s, { messageId: OUR_ID, to: ['gone@target.example'] });
    const byId = await assessInboundRelevance(ctx(s.ws, s.owner), input);
    expect(byId.relevance).toBe('bounce');
    expect(byId.signals.evidence.matched_message_ids).toEqual([messageIdKey(OUR_ID)]);
  });

  it("mail from a lead's contact address with no references is a prospect reply only once we have mailed it", async () => {
    const s = await setup();
    await seedLead(s, 'anna@target.example');
    const m = await parseFixture('lead-contact-no-refs.eml');
    const input = {
      fromAddress: m.from.address,
      inReplyTo: m.inReplyTo,
      references: m.references,
      receivedAt: m.receivedAt,
      signals: m.relevanceSignals!,
    };
    expect((await assessInboundRelevance(ctx(s.ws, s.owner), input)).relevance).toBe('unrelated');

    await seedOutbound(s, { messageId: '<first-touch@nulife.pl>', to: ['Anna@Target.example'] });
    const after = await assessInboundRelevance(ctx(s.ws, s.owner), input);
    expect(after.relevance).toBe('prospect_reply');
    expect(after.signals.evidence.sender_is_contacted_lead).toBe(true);
  });

  it('having mailed an address is not enough without a lead behind it', async () => {
    const s = await setup();
    await seedOutbound(s, { messageId: '<first-touch@nulife.pl>', to: ['anna@target.example'] });
    const m = await parseFixture('lead-contact-no-refs.eml');
    const a = await assessInboundRelevance(ctx(s.ws, s.owner), {
      fromAddress: m.from.address,
      inReplyTo: m.inReplyTo,
      references: m.references,
      receivedAt: m.receivedAt,
      signals: m.relevanceSignals!,
    });
    expect(a.relevance).toBe('unrelated');
  });
});

// ============ syncInbound integration ================================

async function enableEverything(s: Setup): Promise<void> {
  await updateReplyAutoActions(ctx(s.ws, s.owner), {
    autoSuppressUnsubscribe: true,
    autoSuppressBounce: true,
    autoCloseNegative: true,
    autoExtractRedirects: true,
  });
}

const BULK = [
  'newsletter.eml',
  'linkedin-notification.eml',
  'substack-post.eml',
  'mailing-list.eml',
  'receipt-noreply.eml',
];
const UNRELATED = ['colleague.eml', 'exchange-ndr.eml'];

describe('syncInbound behind the relevance gate', { timeout: 30000 }, () => {
  it('5 bulk + 2 unrelated messages with every auto-action on cause no side effects at all', async () => {
    const s = await setup();
    await enableEverything(s);
    await syncFixtures(s, [...BULK, ...UNRELATED]);

    const rows = await db
      .select()
      .from(mailMessages)
      .where(and(eq(mailMessages.workspaceId, s.ws), eq(mailMessages.direction, 'inbound')));
    expect(rows).toHaveLength(7);
    const byId = new Map(rows.map((r) => [r.messageId, r]));
    for (const name of BULK) {
      const m = await parseFixture(name);
      expect(byId.get(m.messageId)!.outreachRelevance, name).toBe('bulk');
    }
    for (const name of UNRELATED) {
      const m = await parseFixture(name);
      expect(byId.get(m.messageId)!.outreachRelevance, name).toBe('unrelated');
    }
    const newsletter = byId.get((await parseFixture('newsletter.eml')).messageId)!;
    expect(newsletter.relevanceSignals).toMatchObject({ list_unsubscribe: true });
    expect((newsletter.relevanceSignals as StoredRelevanceSignals).evidence.reason).toMatch(
      /bulk signals: .*list-unsubscribe/,
    );
    // Messages are still stored and threaded (they show in Conversations)…
    expect(rows.every((r) => r.threadId !== null)).toBe(true);
    // …but never classified.
    expect(rows.every((r) => r.replyClassification === null)).toBe(true);

    const ws = s.ws;
    expect(await db.select().from(suppressionList).where(eq(suppressionList.workspaceId, ws))).toHaveLength(0);
    expect(await db.select().from(contacts).where(eq(contacts.workspaceId, ws))).toHaveLength(0);
    expect(
      await db.select().from(contactAssociations).where(eq(contactAssociations.workspaceId, ws)),
    ).toHaveLength(0);
    expect(await db.select().from(notifications).where(eq(notifications.workspaceId, ws))).toHaveLength(0);
    expect(await db.select().from(usageLog).where(eq(usageLog.workspaceId, ws))).toHaveLength(0);
    expect(
      await db.select().from(tokenTransactions).where(eq(tokenTransactions.workspaceId, ws)),
    ).toHaveLength(0);
    const audits = await db.select().from(auditLog).where(eq(auditLog.workspaceId, ws));
    expect(audits.filter((a) => a.kind.startsWith('translation.'))).toHaveLength(0);
    expect(audits.filter((a) => a.kind === 'reply.classify')).toHaveLength(0);
    expect(audits.filter((a) => a.kind === 'suppression.add')).toHaveLength(0);
    expect(rows.every((r) => r.bodyTextNative === null)).toBe(true);

    // The sync audit reports what the gate decided.
    const sync = audits.find((a) => a.kind === 'mail.sync_inbound')!;
    expect(sync.payload).toMatchObject({ relevance: { bulk: 5, unrelated: 2 } });

    // The Polish receipt would have billed a translation; the guard holds
    // for direct callers too.
    const receipt = byId.get((await parseFixture('receipt-noreply.eml')).messageId)!;
    expect(await maybeAutoTranslateInbound(ctx(s.ws, s.owner), receipt.id)).toBe(
      'skipped:not_outreach',
    );
  });

  it('among the noise, a real prospect reply still classifies and notifies; the OOF and the bounce do not notify', async () => {
    const s = await setup();
    await enableEverything(s);
    await seedOutbound(s, {
      messageId: OUR_ID,
      to: ['anna@target.example', 'piotr@target.example', 'gone@target.example'],
    });
    await syncFixtures(s, [
      'newsletter.eml',
      'prospect-reply.eml',
      'auto-reply.eml',
      'postfix-dsn.eml',
    ]);
    await settleDetached();

    const reply = await inboundByMessageId(s.ws, (await parseFixture('prospect-reply.eml')).messageId);
    expect(reply.outreachRelevance).toBe('prospect_reply');
    // Quoted footer stripped: a spec request, not an unsubscribe.
    expect(reply.replyClassification).toBe('doc_request');

    const oof = await inboundByMessageId(s.ws, (await parseFixture('auto-reply.eml')).messageId);
    expect(oof.outreachRelevance).toBe('auto_reply');
    expect(oof.replyClassification).toBe('out_of_office');

    const bounce = await inboundByMessageId(s.ws, (await parseFixture('postfix-dsn.eml')).messageId);
    expect(bounce.outreachRelevance).toBe('bounce');
    expect(bounce.replyClassification).toBe('bounce');
    expect((bounce.relevanceSignals as StoredRelevanceSignals).dsn!.recipients[0]!.final_recipient).toBe(
      'gone@target.example',
    );

    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.workspaceId, s.ws));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'lead.replied', title: 'Reply from Anna Kowalska' });

    // Contacts only for the people who answered (not the daemon, not the newsletter).
    const people = await db.select().from(contacts).where(eq(contacts.workspaceId, s.ws));
    expect(people.map((c) => c.email).sort()).toEqual(['anna@target.example', 'piotr@target.example']);

    // Bounce auto-suppression is on but stays off until F-32: refused + audited.
    expect(
      await db.select().from(suppressionList).where(eq(suppressionList.workspaceId, s.ws)),
    ).toHaveLength(0);
    const refused = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, s.ws), eq(auditLog.kind, 'reply.auto_suppress_refused')));
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused[0]!.entityId).toBe(bounce.id.toString());
    expect(refused[0]!.payload).toMatchObject({ trigger: 'bounce', relevance: 'bounce' });
  });
});

// ============ backfill ===============================================

async function seedLegacyInbound(
  s: Setup,
  input: {
    messageId: string;
    from: string;
    headers?: Record<string, unknown>;
    inReplyTo?: string | null;
  },
): Promise<bigint> {
  const [row] = await db
    .insert(mailMessages)
    .values({
      workspaceId: s.ws,
      mailboxId: s.mailboxId,
      direction: 'inbound',
      status: 'received',
      messageId: input.messageId,
      inReplyTo: input.inReplyTo ?? null,
      references: input.inReplyTo ? [input.inReplyTo] : [],
      fromAddress: input.from,
      toAddresses: ['sales@nulife.pl'],
      subject: 'legacy',
      bodyText: 'please unsubscribe me',
      headers: input.headers ?? {},
      receivedAt: new Date(),
      replyClassification: 'unsubscribe',
    })
    .returning();
  return row!.id;
}

describe('backfillInboundRelevance', { timeout: 20000 }, () => {
  async function seedLegacyMix(s: Setup) {
    await seedOutbound(s, { messageId: OUR_ID, to: ['anna@target.example'] });
    return {
      newsletter: await seedLegacyInbound(s, {
        messageId: '<legacy-nl@shop.example>',
        from: 'news@shop.example',
        headers: { list: '[object Object]', 'content-type': '[object Object]' },
      }),
      bulkPrecedence: await seedLegacyInbound(s, {
        messageId: '<legacy-prec@vendor.example>',
        from: 'marketing@vendor.example',
        headers: { precedence: 'bulk' },
      }),
      noreply: await seedLegacyInbound(s, {
        messageId: '<legacy-noreply@rides.example>',
        from: 'noreply@rides.example',
      }),
      daemon: await seedLegacyInbound(s, {
        messageId: '<legacy-dsn@mail.example>',
        from: 'mailer-daemon@mail.example',
      }),
      colleague: await seedLegacyInbound(s, {
        messageId: '<legacy-colleague@partner.example>',
        from: 'marta@partner.example',
      }),
      reply: await seedLegacyInbound(s, {
        messageId: '<legacy-reply@target.example>',
        from: 'anna@target.example',
        inReplyTo: OUR_ID.toUpperCase(),
      }),
    };
  }

  it('dry run reports without writing', async () => {
    const s = await setup();
    const ids = await seedLegacyMix(s);
    const report = await backfillInboundRelevance(ctx(s.ws, s.owner));
    expect(report).toMatchObject({
      dryRun: true,
      scanned: 6,
      updated: 0,
      byRelevance: { bulk: 3, unrelated: 2, prospect_reply: 1, auto_reply: 0, bounce: 0 },
      outreachLinkedIds: [ids.reply.toString()],
    });
    const unlabelled = await db
      .select()
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, s.ws),
          eq(mailMessages.direction, 'inbound'),
          isNull(mailMessages.outreachRelevance),
        ),
      );
    expect(unlabelled).toHaveLength(6);
  });

  it('apply labels every row once, keeps classification labels, audits, and is idempotent', async () => {
    const s = await setup();
    const ids = await seedLegacyMix(s);
    const report = await backfillInboundRelevance(ctx(s.ws, s.owner), { dryRun: false });
    expect(report).toMatchObject({ dryRun: false, scanned: 6, updated: 6 });

    const label = async (id: bigint) => {
      const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, id));
      return row!;
    };
    expect((await label(ids.newsletter)).outreachRelevance).toBe('bulk');
    expect((await label(ids.bulkPrecedence)).outreachRelevance).toBe('bulk');
    expect((await label(ids.noreply)).outreachRelevance).toBe('bulk');
    expect((await label(ids.daemon)).outreachRelevance).toBe('unrelated');
    expect((await label(ids.colleague)).outreachRelevance).toBe('unrelated');
    expect((await label(ids.reply)).outreachRelevance).toBe('prospect_reply');
    const nl = await label(ids.newsletter);
    expect(nl.relevanceSignals).toMatchObject({ source: 'stored_headers', list_headers: true });
    // Clearing the old labels is the remediation's job (F-06), not this one.
    expect(nl.replyClassification).toBe('unsubscribe');

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, s.ws), eq(auditLog.kind, 'mail.relevance_backfill')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({ scanned: 6, updated: 6 });

    const again = await backfillInboundRelevance(ctx(s.ws, s.owner), { dryRun: false });
    expect(again).toMatchObject({ scanned: 0, updated: 0 });
  });

  it('is admin-only and workspace-scoped', async () => {
    const s = await setup();
    await seedLegacyMix(s);
    await expect(
      backfillInboundRelevance(ctx(s.ws, s.owner, 'member')),
    ).rejects.toMatchObject({ code: 'permission_denied' });

    const otherOwner = await seedUser({ email: 'other@test.local' });
    const other = await seedWorkspace({ name: 'Other', ownerUserId: otherOwner });
    const report = await backfillInboundRelevance(ctx(other, otherOwner), { dryRun: false });
    expect(report).toMatchObject({ scanned: 0, updated: 0 });
  });
});
