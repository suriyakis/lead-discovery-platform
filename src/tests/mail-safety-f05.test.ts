// flow:F-05 — safe manual mail.
//   (1) one-to-one mode: compose / thread replies / reply drafts carry no
//       unsubscribe footer and no List-Unsubscribe headers; cold sends and
//       follow-ups keep both; the signature is added once (I089, I090).
//   (2) the unsubscribe link needs a human: GET shows a page, HEAD does
//       nothing, only POST opts out — and stops queued mail, follow-ups and
//       open leads for that address (I012).
//   (3) send errors suppress a recipient only on a RCPT-stage 5.1.x / 5.2.1
//       rejection; a refused login marks the mailbox failing (I007).

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import { auditLog } from '@/lib/db/schema/audit';
import {
  connectorRecipes,
  connectorRuns,
  connectors,
  sourceRecords,
} from '@/lib/db/schema/connectors';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  suppressionList,
} from '@/lib/db/schema/mailing';
import { notifications } from '@/lib/db/schema/notifications';
import {
  outreachDrafts,
  outreachQueue,
  outreachThreadState,
  type OutreachStage,
} from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { reviewItems } from '@/lib/db/schema/review';
import { MockMailProvider, type OutboundMessage, type SendResult } from '@/lib/mail';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { processDueFollowUps, scheduleFollowUps } from '@/lib/services/follow-up';
import {
  isHardBounce,
  retrySend,
  sendMessage,
  sendModeFromHeaders,
} from '@/lib/services/mail';
import { createMailbox } from '@/lib/services/mailbox';
import { drainQueue, sendModeForDraft } from '@/lib/services/outreach-queue';
import { createProductProfile } from '@/lib/services/product-profile';
import { createSignature } from '@/lib/services/signatures';
import { addSuppression } from '@/lib/services/suppression';
import { buildComposeSendInput } from '@/app/mailbox/[id]/compose/compose-input';
import { GET, HEAD, POST } from '@/app/api/unsubscribe/[token]/route';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

// ---- fixtures --------------------------------------------------------

interface Setup {
  workspaceA: bigint;
  ownerA: string;
  mailboxId: bigint;
  productId: bigint;
}

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'f05-owner@test.local' });
  const workspaceA = await seedWorkspace({ name: 'f05-a', ownerUserId: ownerA });
  const mb = await createMailbox(ctx(workspaceA, ownerA), {
    name: 'sales',
    fromAddress: 'sales@nulife.pl',
    fromName: 'Sales',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: 'sales@nulife.pl',
    smtpPassword: 'secret',
    imap: null,
    isDefault: true,
  });
  const product = await createProductProfile(ctx(workspaceA, ownerA), { name: 'P1' });
  return { workspaceA, ownerA, mailboxId: mb.id, productId: product.id };
}

async function makeReviewItem(workspaceId: bigint): Promise<{ reviewItemId: bigint; sourceRecordId: bigint }> {
  const [conn] = await db
    .insert(connectors)
    .values({ workspaceId, name: 'mock-conn', templateType: 'mock', active: true })
    .returning();
  const [recipe] = await db
    .insert(connectorRecipes)
    .values({ workspaceId, connectorId: conn!.id, name: 'mock-recipe', templateType: 'mock' })
    .returning();
  const [run] = await db
    .insert(connectorRuns)
    .values({ workspaceId, connectorId: conn!.id, recipeId: recipe!.id, status: 'succeeded' })
    .returning();
  const [sr] = await db
    .insert(sourceRecords)
    .values({
      workspaceId,
      sourceSystem: 'mock',
      sourceId: `mock-${Date.now()}-${Math.random()}`,
      connectorId: conn!.id,
      recipeId: recipe!.id,
      runId: run!.id,
      rawData: {},
      normalizedData: {},
    })
    .returning();
  const [ri] = await db
    .insert(reviewItems)
    .values({ workspaceId, sourceRecordId: sr!.id, state: 'approved' })
    .returning();
  return { reviewItemId: ri!.id, sourceRecordId: sr!.id };
}

async function makeLead(s: Setup, contactEmail: string) {
  const { reviewItemId, sourceRecordId } = await makeReviewItem(s.workspaceA);
  const [lead] = await db
    .insert(qualifiedLeads)
    .values({
      workspaceId: s.workspaceA,
      reviewItemId,
      productProfileId: s.productId,
      state: 'contacted',
      contactEmail,
    })
    .returning();
  return { lead: lead!, reviewItemId, sourceRecordId };
}

async function makeQueuedDraft(
  s: Setup,
  to: string,
  opts: { stage?: OutreachStage; triggeredByMessageId?: bigint | null } = {},
) {
  const { lead, reviewItemId, sourceRecordId } = await makeLead(s, to);
  const [draft] = await db
    .insert(outreachDrafts)
    .values({
      workspaceId: s.workspaceA,
      reviewItemId,
      sourceRecordId,
      productProfileId: s.productId,
      status: 'approved',
      stage: opts.stage ?? 'discovery',
      triggeredByMessageId: opts.triggeredByMessageId ?? null,
      subject: 'Quick question',
      body: 'Who handles concrete repair at your company?',
      method: 'rules',
    })
    .returning();
  const [entry] = await db
    .insert(outreachQueue)
    .values({
      workspaceId: s.workspaceA,
      mailboxId: s.mailboxId,
      draftId: draft!.id,
      toAddresses: [to],
      subject: draft!.subject!,
      bodyText: draft!.body,
      delayMode: 'immediate',
      scheduledSendAt: new Date(Date.now() - 60_000),
      status: 'queued',
      createdBy: s.ownerA,
    })
    .returning();
  return { lead, draft: draft!, entry: entry! };
}

/** A nodemailer-shaped SMTP error. */
function smtpError(
  code: string,
  command: string,
  response: string | null,
  extra: Record<string, unknown> = {},
): Error {
  const err = new Error(response ? `${code} failed: ${response}` : code) as Error &
    Record<string, unknown>;
  err.code = code;
  err.command = command;
  if (response) {
    err.response = response;
    err.responseCode = Number(response.slice(0, 3));
  }
  return Object.assign(err, extra);
}

class ThrowingProvider extends MockMailProvider {
  public calls = 0;
  constructor(private readonly make: (message: OutboundMessage) => Error) {
    super();
  }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.calls += 1;
    throw this.make(message);
  }
}

const eauth = () =>
  smtpError('EAUTH', 'AUTH PLAIN', '535 5.7.8 Error: authentication failed: UGFzc3dvcmQ6');

async function suppressionsIn(workspaceId: bigint) {
  return db.select().from(suppressionList).where(eq(suppressionList.workspaceId, workspaceId));
}

async function mailboxRow(id: bigint) {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, id));
  return row!;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- (1) send mode ---------------------------------------------------

describe('one-to-one mode (I089) and the signature (I090)', () => {
  it('compose carries no footer and no List-Unsubscribe header, and the signature once', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await createSignature(c, {
      name: 'Default',
      bodyText: '— Jakub @ Nulife',
      mailboxId: s.mailboxId,
      isDefault: true,
    });
    const built = buildComposeSendInput(
      {
        mailboxId: s.mailboxId.toString(),
        to: 'anna@target.com',
        cc: '',
        bcc: '',
        subject: 'Hello',
        // The compose page no longer pre-fills the signature; the
        // operator writes only the message.
        body: 'Hello Anna,\n\nthanks for the call.',
        targetLanguage: '',
        translatedSubject: '',
        translatedBody: '',
        signature: '__default__',
      },
      'en',
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.mode).toBe('one_to_one');

    const provider = new MockMailProvider();
    await sendMessage(c, { ...built.input, providerOverride: provider });
    const sent = provider.sent[0]!.message;
    expect(count(sent.text ?? '', '— Jakub @ Nulife')).toBe(1);
    expect(sent.text).not.toContain('/api/unsubscribe/');
    expect(sent.headers?.['List-Unsubscribe']).toBeUndefined();
    expect(sent.headers?.['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('compose with "No signature" sends none', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    await createSignature(c, {
      name: 'Default',
      bodyText: '— Jakub @ Nulife',
      mailboxId: s.mailboxId,
      isDefault: true,
    });
    const built = buildComposeSendInput(
      {
        mailboxId: s.mailboxId.toString(),
        to: 'anna@target.com',
        cc: '',
        bcc: '',
        subject: 'Hello',
        body: 'Plain note.',
        targetLanguage: '',
        translatedSubject: '',
        translatedBody: '',
        signature: '__none__',
      },
      'en',
    );
    if (!built.ok) throw new Error(built.error);
    const provider = new MockMailProvider();
    await sendMessage(c, { ...built.input, providerOverride: provider });
    expect(provider.sent[0]!.message.text).toBe('Plain note.');
  });

  it('a thread reply carries no footer and no List-Unsubscribe header', async () => {
    const s = await setup();
    const provider = new MockMailProvider();
    await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mode: 'one_to_one',
      mailboxId: s.mailboxId,
      to: [{ address: 'anna@target.com' }],
      subject: 'Re: Hello',
      text: 'Sure, Tuesday works.',
      inReplyTo: '<prospect-1@target.com>',
      references: ['<prospect-1@target.com>'],
      providerOverride: provider,
    });
    const sent = provider.sent[0]!.message;
    expect(sent.text).not.toContain('/api/unsubscribe/');
    expect(sent.headers?.['List-Unsubscribe']).toBeUndefined();
    expect(sent.headers?.['In-Reply-To']).toBe('<prospect-1@target.com>');
  });

  it('a queued cold send still carries the footer and both List-Unsubscribe headers', async () => {
    const s = await setup();
    const { entry } = await makeQueuedDraft(s, 'anna@target.com');
    const provider = new MockMailProvider();
    const r = await drainQueue(ctx(s.workspaceA, s.ownerA), { providerOverride: provider });
    expect(r.sent).toBe(1);
    const sent = provider.sent[0]!.message;
    expect(sent.text).toContain('/api/unsubscribe/');
    expect(sent.headers?.['List-Unsubscribe']).toMatch(/^<https?:\/\/.+\/api\/unsubscribe\/[a-f0-9]+>, <mailto:/);
    expect(sent.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const [row] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, entry.id));
    expect(row!.status).toBe('sent');
  });

  it('a queued draft answering the prospect’s reply is one-to-one', async () => {
    const s = await setup();
    const { entry } = await makeQueuedDraft(s, 'anna@target.com', {
      stage: 'engagement',
      triggeredByMessageId: 999n,
    });
    const provider = new MockMailProvider();
    await drainQueue(ctx(s.workspaceA, s.ownerA), { providerOverride: provider });
    const sent = provider.sent[0]!.message;
    expect(sent.text).not.toContain('/api/unsubscribe/');
    expect(sent.headers?.['List-Unsubscribe']).toBeUndefined();
    const [row] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, entry.id));
    expect(row!.status).toBe('sent');
  });

  it('sendModeForDraft: only a non-discovery draft triggered by an inbound reply is one-to-one', () => {
    expect(sendModeForDraft({ stage: 'discovery', triggeredByMessageId: null })).toBe('sequence');
    // A referral intro is a first touch to a new person.
    expect(sendModeForDraft({ stage: 'discovery', triggeredByMessageId: 5n })).toBe('sequence');
    // Backfilled 'engagement' drafts with no trigger stay sequence.
    expect(sendModeForDraft({ stage: 'engagement', triggeredByMessageId: null })).toBe('sequence');
    expect(sendModeForDraft({ stage: 'engagement', triggeredByMessageId: 5n })).toBe('one_to_one');
    expect(sendModeForDraft({ stage: 'pitch', triggeredByMessageId: 5n })).toBe('one_to_one');
    expect(sendModeForDraft({ stage: 'closing', triggeredByMessageId: 5n })).toBe('one_to_one');
  });

  it('a retry keeps the original mode (read back from its headers)', async () => {
    expect(sendModeFromHeaders({ 'List-Unsubscribe': '<x>' })).toBe('sequence');
    expect(sendModeFromHeaders({ 'list-unsubscribe': '<x>' })).toBe('sequence');
    expect(sendModeFromHeaders({ 'In-Reply-To': '<y>' })).toBe('one_to_one');
    expect(sendModeFromHeaders(null)).toBe('one_to_one');

    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const failing = new ThrowingProvider(() => new Error('connect ECONNREFUSED 51.89.234.14:587'));
    await expect(
      sendMessage(c, {
        mode: 'one_to_one',
        mailboxId: s.mailboxId,
        to: [{ address: 'anna@target.com' }],
        subject: 'Re: Hello',
        text: 'Personal reply.',
        providerOverride: failing,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    const [failed] = await db
      .select()
      .from(mailMessages)
      .where(and(eq(mailMessages.workspaceId, s.workspaceA), eq(mailMessages.status, 'failed')));
    const ok = new MockMailProvider();
    const r = await retrySend(c, [failed!.id], ok);
    expect(r.retried).toHaveLength(1);
    expect(ok.sent[0]!.message.headers?.['List-Unsubscribe']).toBeUndefined();
    expect(ok.sent[0]!.message.text).not.toContain('/api/unsubscribe/');
  });
});

// ---- (2) unsubscribe needs a human ----------------------------------

async function seedSentMessage(
  s: Setup,
  token: string,
  to: string,
  opts: { targetLanguage?: string; threadId?: bigint } = {},
) {
  const threadId =
    opts.threadId ??
    (
      await db
        .insert(mailThreads)
        .values({
          workspaceId: s.workspaceA,
          mailboxId: s.mailboxId,
          subject: 'Quick question',
          externalThreadKey: `subj:quick-${token}`,
          participants: [to, 'sales@nulife.pl'],
        })
        .returning()
    )[0]!.id;
  const [m] = await db
    .insert(mailMessages)
    .values({
      workspaceId: s.workspaceA,
      mailboxId: s.mailboxId,
      threadId,
      direction: 'outbound',
      status: 'sent',
      messageId: `<${token}@nulife.pl>`,
      fromAddress: 'sales@nulife.pl',
      toAddresses: [to],
      subject: 'Quick question',
      bodyText: 'hello',
      targetLanguage: opts.targetLanguage ?? null,
      trackingToken: token,
    })
    .returning();
  return { messageId: m!.id, threadId };
}

function params(token: string) {
  return { params: Promise.resolve({ token }) };
}

describe('unsubscribe endpoint (I012)', () => {
  it('GET shows a confirmation page and HEAD does nothing — 0 suppressions', async () => {
    const s = await setup();
    const token = 'a'.repeat(32);
    await seedSentMessage(s, token, 'anna@target.com');
    const url = `http://localhost/api/unsubscribe/${token}`;

    const get = await GET(new Request(url), params(token));
    expect(get.status).toBe(200);
    expect(get.headers.get('cache-control')).toBe('no-store');
    const html = await get.text();
    expect(html).toContain('<form method="post">');
    expect(html).toContain('name="confirm" value="1"');
    expect(html).toContain('Unsubscribe');
    expect(html).toContain('Wrong person? Tell us who');
    expect(html).toContain('mailto:sales@nulife.pl');
    // The address is masked, never printed in full.
    expect(html).toContain('a***@target.com');
    expect(html).not.toContain('anna@target.com');

    const head = await HEAD();
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    expect(await suppressionsIn(s.workspaceA)).toHaveLength(0);
  });

  it('GET for an unknown token renders the not-valid page and writes nothing', async () => {
    const s = await setup();
    const res = await GET(new Request('http://localhost/x'), params('c'.repeat(32)));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('This link is not valid');
    expect(await suppressionsIn(s.workspaceA)).toHaveLength(0);
  });

  it('a one-click POST suppresses (unsubscribe_link) and cancels 1 queued row and 2 pending follow-ups', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const token = 'b'.repeat(32);

    // The recipient's lead, its sent first touch and two pending steps.
    const { lead } = await makeLead(s, 'anna@target.com');
    const { threadId } = await seedSentMessage(s, token, 'anna@target.com');
    await db.insert(outreachThreadState).values({
      workspaceId: s.workspaceA,
      qualifiedLeadId: lead.id,
      threadId,
      stage: 'discovery',
    });
    await scheduleFollowUps(c, { threadId, qualifiedLeadId: lead.id });
    const steps = await db
      .select()
      .from(outreachFollowUps)
      .where(eq(outreachFollowUps.qualifiedLeadId, lead.id));
    // Keep exactly two pending steps for the acceptance count.
    for (const extra of steps.slice(2)) {
      await db.delete(outreachFollowUps).where(eq(outreachFollowUps.id, extra.id));
    }
    // One queued send to the same address (another draft), one to someone else.
    const queued = await makeQueuedDraft(s, 'Anna@Target.com');
    const other = await makeQueuedDraft(s, 'bob@other.com');

    const res = await POST(
      new Request(`http://localhost/api/unsubscribe/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      }),
      params(token),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');

    const rows = await suppressionsIn(s.workspaceA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      value: 'anna@target.com',
      reason: 'unsubscribe',
      source: 'unsubscribe_link',
    });

    const queue = await db.select().from(outreachQueue).where(eq(outreachQueue.workspaceId, s.workspaceA));
    const byId = new Map(queue.map((q) => [q.id.toString(), q]));
    expect(byId.get(queued.entry.id.toString())!.status).toBe('cancelled');
    expect(byId.get(other.entry.id.toString())!.status).toBe('queued');
    expect(queue.filter((q) => q.status === 'cancelled')).toHaveLength(1);

    const followUps = await db
      .select()
      .from(outreachFollowUps)
      .where(eq(outreachFollowUps.workspaceId, s.workspaceA));
    expect(followUps).toHaveLength(2);
    for (const f of followUps) {
      expect(f.status).toBe('skipped');
      expect(f.skipReason).toBe('unsubscribed');
    }

    // The (legacy) leads targeting the address are closed; bob's is not.
    const [closedLead] = await db.select().from(qualifiedLeads).where(eq(qualifiedLeads.id, lead.id));
    expect(closedLead!.state).toBe('closed');
    const [bobLead] = await db.select().from(qualifiedLeads).where(eq(qualifiedLeads.id, other.lead.id));
    expect(bobLead!.state).toBe('contacted');

    const [stopped] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, s.workspaceA), eq(auditLog.kind, 'unsubscribe.outreach_stopped')));
    expect(stopped!.userId).toBeNull();
    expect(stopped!.payload).toMatchObject({
      source: 'unsubscribe_link',
      cancelledQueueIds: [queued.entry.id.toString()],
    });

    // Idempotent: a second POST changes nothing and still answers 200.
    const again = await POST(
      new Request(`http://localhost/api/unsubscribe/${token}`, {
        method: 'POST',
        body: 'List-Unsubscribe=One-Click',
      }),
      params(token),
    );
    expect(again.status).toBe(200);
    expect(await suppressionsIn(s.workspaceA)).toHaveLength(1);
  });

  it('the page button POST shows the done page in the email’s language', async () => {
    const s = await setup();
    const token = 'd'.repeat(32);
    await seedSentMessage(s, token, 'anna@target.com', { targetLanguage: 'de' });

    const page = await (await GET(new Request('http://localhost/x'), params(token))).text();
    expect(page).toContain('lang="de"');
    expect(page).toContain('Abmelden');
    expect(page).toContain('Falsche Person?');

    const res = await POST(
      new Request(`http://localhost/api/unsubscribe/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'confirm=1',
      }),
      params(token),
    );
    const html = await res.text();
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('Sie wurden abgemeldet');
    expect(html).toContain('a***@target.com');
    expect(await suppressionsIn(s.workspaceA)).toHaveLength(1);
  });
});

// ---- (3) send failures ------------------------------------------------

describe('send failures suppress only on a recipient hard rejection (I007)', () => {
  it('EAUTH 535 creates 0 suppressions, marks the mailbox failing and notifies once', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const provider = new ThrowingProvider(eauth);
    for (const to of ['anna@target.com', 'bob@other.com']) {
      await expect(
        sendMessage(c, {
          mode: 'one_to_one',
          mailboxId: s.mailboxId,
          to: [{ address: to }],
          subject: 'Hello',
          text: 'x',
          providerOverride: provider,
        }),
      ).rejects.toThrow(/535/);
    }

    expect(await suppressionsIn(s.workspaceA)).toHaveLength(0);

    const mb = await mailboxRow(s.mailboxId);
    expect(mb.status).toBe('failing');
    expect(mb.lastError).toMatch(/^SMTP: .*535/);
    expect(mb.imapNextSyncAfter).not.toBeNull();

    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.workspaceId, s.workspaceA), eq(notifications.kind, 'mailbox.failing')));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.href).toBe(`/mailbox/${s.mailboxId}`);
    expect(notes[0]!.body).toContain('No recipient was suppressed');

    // The failure rows are ordinary failures — retryable once fixed.
    const failed = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceA));
    expect(failed).toHaveLength(2);
    for (const f of failed) {
      expect(f.status).toBe('failed');
      expect(isHardBounce(f)).toBe(false);
    }
  });

  it('the queue holds behind the failing mailbox: one login attempt, entries stay queued', async () => {
    const s = await setup();
    const first = await makeQueuedDraft(s, 'anna@target.com');
    const second = await makeQueuedDraft(s, 'bob@other.com');
    const provider = new ThrowingProvider(eauth);

    const r = await drainQueue(ctx(s.workspaceA, s.ownerA), { providerOverride: provider });
    expect(provider.calls).toBe(1);
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(0);

    for (const id of [first.entry.id, second.entry.id]) {
      const [row] = await db.select().from(outreachQueue).where(eq(outreachQueue.id, id));
      expect(row!.status).toBe('queued');
      expect(row!.lastError).toMatch(/^Held: the mailbox is failing/);
      expect(row!.scheduledSendAt.getTime()).toBeGreaterThan(Date.now());
    }
    expect(await suppressionsIn(s.workspaceA)).toHaveLength(0);
    expect((await mailboxRow(s.mailboxId)).status).toBe('failing');
  });

  it('RCPT 550 5.1.1 suppresses only that recipient (source smtp)', async () => {
    const s = await setup();
    const provider = new ThrowingProvider(() => {
      const gone = Object.assign(
        smtpError('EENVELOPE', 'RCPT TO', '550 5.1.1 <gone@target.com>: Recipient address rejected: User unknown'),
        { recipient: 'gone@target.com' },
      );
      const busy = Object.assign(
        smtpError('EENVELOPE', 'RCPT TO', '451 4.7.1 <busy@target.com>: Greylisted, try again later'),
        { recipient: 'busy@target.com' },
      );
      return smtpError('EENVELOPE', 'RCPT TO', '451 4.7.1 Greylisted', {
        rejected: ['gone@target.com', 'busy@target.com'],
        rejectedErrors: [gone, busy],
      });
    });
    await expect(
      sendMessage(ctx(s.workspaceA, s.ownerA), {
        mode: 'one_to_one',
        mailboxId: s.mailboxId,
        to: [{ address: 'gone@target.com' }, { address: 'busy@target.com' }],
        subject: 'Hello',
        text: 'x',
        providerOverride: provider,
      }),
    ).rejects.toThrow();

    const [failed] = await db.select().from(mailMessages).where(eq(mailMessages.workspaceId, s.workspaceA));
    expect(failed!.status).toBe('bounced');

    const rows = await suppressionsIn(s.workspaceA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      value: 'gone@target.com',
      reason: 'bounce_hard',
      source: 'smtp',
      sourceRef: `mail_message:${failed!.id}`,
      expiresAt: null,
    });
    expect((await mailboxRow(s.mailboxId)).status).toBe('active');
  });

  it('451 creates no suppression (nor do 421, a dead connection or a relay refusal)', async () => {
    const s = await setup();
    const errors: Array<() => Error> = [
      () => smtpError('EENVELOPE', 'RCPT TO', '451 4.7.1 <anna@target.com>: Greylisted, try again later'),
      () => smtpError('EPROTOCOL', 'CONN', '421 4.7.0 Too many connections, slow down'),
      () => Object.assign(new Error('connect ECONNREFUSED 51.89.234.14:587'), { code: 'ESOCKET', command: 'CONN' }),
      () => smtpError('EENVELOPE', 'RCPT TO', '554 5.7.1 <anna@target.com>: Relay access denied'),
      () => smtpError('EENVELOPE', 'MAIL FROM', '550 5.7.1 Sender rejected by policy'),
    ];
    for (const make of errors) {
      await expect(
        sendMessage(ctx(s.workspaceA, s.ownerA), {
          mode: 'sequence',
          mailboxId: s.mailboxId,
          to: [{ address: 'anna@target.com' }],
          subject: 'Hello',
          text: 'x',
          providerOverride: new ThrowingProvider(make),
        }),
      ).rejects.toThrow();
    }
    expect(await suppressionsIn(s.workspaceA)).toHaveLength(0);
    const rows = await db.select().from(mailMessages).where(eq(mailMessages.workspaceId, s.workspaceA));
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed']);
    expect((await mailboxRow(s.mailboxId)).status).toBe('active');
  });

  it('a partially accepted send suppresses only the address refused as unknown', async () => {
    const s = await setup();
    class PartialProvider extends MockMailProvider {
      async send(message: OutboundMessage): Promise<SendResult> {
        const result = await super.send(message);
        return {
          ...result,
          rejected: [
            { address: 'gone@target.com', responseCode: 550, response: '550 5.1.1 user unknown' },
            { address: 'busy@target.com', responseCode: 452, response: '452 4.2.2 mailbox full' },
          ],
        };
      }
    }
    const sent = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mode: 'one_to_one',
      mailboxId: s.mailboxId,
      to: [{ address: 'ok@target.com' }, { address: 'gone@target.com' }],
      cc: [{ address: 'busy@target.com' }],
      subject: 'Hello',
      text: 'x',
      providerOverride: new PartialProvider(),
    });
    expect(sent.status).toBe('sent');
    const rows = await suppressionsIn(s.workspaceA);
    expect(rows.map((r) => r.value)).toEqual(['gone@target.com']);
    expect(rows[0]!.sourceRef).toBe(`mail_message:${sent.id}`);
  });
});

// ---- follow-ups -------------------------------------------------------

describe('follow-ups never compose for a suppressed address or a failing mailbox', () => {
  const throwingAi: IAIProvider = {
    id: 'must-not-run',
    model: 'none',
    async generateText() {
      throw new Error('AI must not be called');
    },
    async generateJson() {
      throw new Error('AI must not be called');
    },
    estimateCost() {
      return 0;
    },
    async healthCheck() {
      return { ok: true };
    },
  };

  async function dueFollowUps(s: Setup, to: string) {
    const provider = new MockMailProvider();
    const sent = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mode: 'sequence',
      mailboxId: s.mailboxId,
      to: [{ address: to }],
      subject: 'Hi',
      text: 'x',
      providerOverride: provider,
    });
    const { lead } = await makeLead(s, to);
    await scheduleFollowUps(ctx(s.workspaceA, s.ownerA), {
      threadId: sent.threadId!,
      qualifiedLeadId: lead.id,
    });
    await db
      .update(outreachFollowUps)
      .set({ scheduledFor: new Date(Date.now() - 60_000) })
      .where(eq(outreachFollowUps.workspaceId, s.workspaceA));
    return lead;
  }

  it('a suppressed recipient cancels the schedule before any compose', async () => {
    const s = await setup();
    await dueFollowUps(s, 'anna@target.com');
    await addSuppression(ctx(s.workspaceA, s.ownerA), {
      address: 'anna@target.com',
      reason: 'manual',
      source: 'manual',
    });
    _setAIProviderForTests(throwingAi);
    const r = await processDueFollowUps(ctx(s.workspaceA, s.ownerA));
    expect(r.checked).toBeGreaterThan(0);
    expect(r.failed).toBe(0);
    const rows = await db.select().from(outreachFollowUps).where(eq(outreachFollowUps.workspaceId, s.workspaceA));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).toBe('skipped');
      expect(row.skipReason).toBe('suppressed');
    }
  });

  it('a failing mailbox leaves follow-ups pending without composing', async () => {
    const s = await setup();
    await dueFollowUps(s, 'anna@target.com');
    await db.update(mailboxes).set({ status: 'failing' }).where(eq(mailboxes.id, s.mailboxId));
    _setAIProviderForTests(throwingAi);
    const r = await processDueFollowUps(ctx(s.workspaceA, s.ownerA));
    expect(r.checked).toBeGreaterThan(0);
    expect(r.failed).toBe(0);
    expect(r.sent).toBe(0);
    const rows = await db.select().from(outreachFollowUps).where(eq(outreachFollowUps.workspaceId, s.workspaceA));
    for (const row of rows) expect(row.status).toBe('pending');
  });
});
