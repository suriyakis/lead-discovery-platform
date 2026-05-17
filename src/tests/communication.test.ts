// Phase 57 — listCommunication + countCommunicationByStatus.
//
// Seeds threads via the mail.sendMessage path (with a mock provider)
// so the rows have realistic shape; then layers on outreach_thread_state
// + qualified_leads + outreach_queue rows manually to drive the status
// derivation. The status filter is the load-bearing logic here.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailMessages } from '@/lib/db/schema/mailing';
import { outreachThreadState, outreachQueue } from '@/lib/db/schema/outreach';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { reviewItems } from '@/lib/db/schema/review';
import { sourceRecords, connectors, connectorRecipes, connectorRuns } from '@/lib/db/schema/connectors';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createMailbox } from '@/lib/services/mailbox';
import { sendMessage } from '@/lib/services/mail';
import { createProductProfile } from '@/lib/services/product-profile';
import {
  countCommunicationByStatus,
  listCommunication,
} from '@/lib/services/communication';
import { MockMailProvider } from '@/lib/mail';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'commA@test.local' });
  const workspaceA = await seedWorkspace({ name: 'comm-a', ownerUserId: ownerA });
  return { workspaceA, ownerA };
}

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

async function makeMailbox(s: Setup) {
  return createMailbox(ctx(s.workspaceA, s.ownerA), {
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
}

/** Seed the chain review_item → source_record → run/recipe/connector
 *  needed for the qualified_leads FK. Returns the review_item id. */
async function makeReviewItem(workspaceId: bigint): Promise<bigint> {
  const [conn] = await db
    .insert(connectors)
    .values({
      workspaceId,
      name: 'mock-conn',
      templateType: 'mock',
      active: true,
    })
    .returning();
  const [recipe] = await db
    .insert(connectorRecipes)
    .values({
      workspaceId,
      connectorId: conn!.id,
      name: 'mock-recipe',
      templateType: 'mock',
    })
    .returning();
  const [run] = await db
    .insert(connectorRuns)
    .values({
      workspaceId,
      connectorId: conn!.id,
      recipeId: recipe!.id,
      status: 'succeeded',
    })
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
    .values({
      workspaceId,
      sourceRecordId: sr!.id,
      state: 'approved',
    })
    .returning();
  return ri!.id;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('listCommunication (P57)', () => {
  it('returns no rows for a workspace with no threads', async () => {
    const s = await setup();
    const rows = await listCommunication(ctx(s.workspaceA, s.ownerA));
    expect(rows).toEqual([]);
  });

  it('lists threads with derived "sent" status when only outbound exists', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    const provider = new MockMailProvider();
    const sent = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'lead@target.com' }],
      subject: 'Hello',
      text: 'pitch',
      providerOverride: provider,
    });
    const rows = await listCommunication(ctx(s.workspaceA, s.ownerA));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.threadId).toBe(sent.threadId);
    expect(rows[0]!.derivedStatus).toBe('sent');
    expect(rows[0]!.hasOutbound).toBe(true);
    expect(rows[0]!.hasInbound).toBe(false);
  });

  it('flips to "replied" when an inbound message arrives on the thread', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    const provider = new MockMailProvider();
    const sent = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'lead@target.com' }],
      subject: 'Hello',
      text: 'pitch',
      providerOverride: provider,
    });
    // Synthesize an inbound on the same thread.
    await db.insert(mailMessages).values({
      workspaceId: s.workspaceA,
      mailboxId: mb.id,
      threadId: sent.threadId!,
      messageId: '<reply-1@target.com>',
      direction: 'inbound',
      status: 'received',
      fromAddress: 'lead@target.com',
      toAddresses: ['sales@nulife.pl'],
      subject: 'Re: Hello',
      bodyText: 'interested!',
      receivedAt: new Date(),
    });
    const rows = await listCommunication(ctx(s.workspaceA, s.ownerA));
    expect(rows[0]!.derivedStatus).toBe('replied');
  });

  it('derives "scheduled" when an outreach_queue row with status=queued has a future scheduledSendAt', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    const provider = new MockMailProvider();
    const sent = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'lead@target.com' }],
      subject: 'Hello',
      text: 'pitch',
      providerOverride: provider,
    });
    const futureTime = new Date(Date.now() + 60 * 60 * 1000);
    await db.insert(outreachQueue).values({
      workspaceId: s.workspaceA,
      mailboxId: mb.id,
      toAddresses: ['lead@target.com'],
      subject: 'Follow-up',
      bodyText: 'pinging',
      // Anchor to a message on the thread via inReplyTo.
      inReplyTo: sent.messageId,
      status: 'queued',
      scheduledSendAt: futureTime,
    });
    const rows = await listCommunication(ctx(s.workspaceA, s.ownerA));
    expect(rows[0]!.derivedStatus).toBe('scheduled');
    expect(rows[0]!.scheduledSendAt).toBeInstanceOf(Date);
  });

  it('derives "error" when a failed queue entry exists, beating sent', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    const provider = new MockMailProvider();
    const sent = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'lead@target.com' }],
      subject: 'Hello',
      text: 'pitch',
      providerOverride: provider,
    });
    await db.insert(outreachQueue).values({
      workspaceId: s.workspaceA,
      mailboxId: mb.id,
      toAddresses: ['lead@target.com'],
      subject: 'broken',
      bodyText: 'x',
      inReplyTo: sent.messageId,
      status: 'failed',
      scheduledSendAt: new Date(Date.now() - 60_000),
      lastError: 'SMTP refused',
    });
    const rows = await listCommunication(ctx(s.workspaceA, s.ownerA));
    expect(rows[0]!.derivedStatus).toBe('error');
    expect(rows[0]!.hasError).toBe(true);
  });

  it('status filter narrows the result set', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    const provider = new MockMailProvider();
    // Thread A: sent only
    await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'a@target.com' }],
      subject: 'A',
      text: 'a',
      providerOverride: provider,
    });
    // Thread B: sent + reply → replied
    const b = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'b@target.com' }],
      subject: 'B',
      text: 'b',
      providerOverride: provider,
    });
    await db.insert(mailMessages).values({
      workspaceId: s.workspaceA,
      mailboxId: mb.id,
      threadId: b.threadId!,
      messageId: '<reply-b@target.com>',
      direction: 'inbound',
      status: 'received',
      fromAddress: 'b@target.com',
      toAddresses: ['sales@nulife.pl'],
      subject: 'Re: B',
      bodyText: 'yes please',
      receivedAt: new Date(),
    });

    const sentOnly = await listCommunication(ctx(s.workspaceA, s.ownerA), {
      status: 'sent',
    });
    const repliedOnly = await listCommunication(ctx(s.workspaceA, s.ownerA), {
      status: 'replied',
    });
    expect(sentOnly).toHaveLength(1);
    expect(sentOnly[0]!.derivedStatus).toBe('sent');
    expect(repliedOnly).toHaveLength(1);
    expect(repliedOnly[0]!.derivedStatus).toBe('replied');
  });

  it('search matches subject + contact email + product name', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    const provider = new MockMailProvider();
    const prod = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Vetrofluid',
    });
    const ri = await makeReviewItem(s.workspaceA);
    const t = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'alice@acme.com' }],
      subject: 'Concrete tender Q3',
      text: 'x',
      providerOverride: provider,
    });
    const [lead] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId: s.workspaceA,
        reviewItemId: ri,
        productProfileId: prod.id,
        state: 'relevant',
        contactName: 'Alice',
        contactEmail: 'alice@acme.com',
      })
      .returning();
    await db.insert(outreachThreadState).values({
      workspaceId: s.workspaceA,
      qualifiedLeadId: lead!.id,
      threadId: t.threadId!,
      stage: 'engagement',
    });

    // Subject match
    const bySubject = await listCommunication(ctx(s.workspaceA, s.ownerA), {
      search: 'tender',
    });
    expect(bySubject.map((r) => r.threadId)).toEqual([t.threadId]);

    // Contact email match
    const byEmail = await listCommunication(ctx(s.workspaceA, s.ownerA), {
      search: 'acme.com',
    });
    expect(byEmail.map((r) => r.threadId)).toEqual([t.threadId]);

    // Product name match
    const byProduct = await listCommunication(ctx(s.workspaceA, s.ownerA), {
      search: 'Vetrofluid',
    });
    expect(byProduct.map((r) => r.threadId)).toEqual([t.threadId]);

    // No match
    const empty = await listCommunication(ctx(s.workspaceA, s.ownerA), {
      search: 'nonexistent-xyz',
    });
    expect(empty).toEqual([]);
  });

  it('productId filter requires the linked lead to match', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    const provider = new MockMailProvider();
    const prod1 = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Product One',
    });
    const prod2 = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
      name: 'Product Two',
    });
    const ri1 = await makeReviewItem(s.workspaceA);
    const ri2 = await makeReviewItem(s.workspaceA);
    const t1 = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'x@target.com' }],
      subject: 'Subj 1',
      text: 'x',
      providerOverride: provider,
    });
    const t2 = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'y@target.com' }],
      subject: 'Subj 2',
      text: 'y',
      providerOverride: provider,
    });
    const [lead1] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId: s.workspaceA,
        reviewItemId: ri1,
        productProfileId: prod1.id,
        state: 'relevant',
      })
      .returning();
    const [lead2] = await db
      .insert(qualifiedLeads)
      .values({
        workspaceId: s.workspaceA,
        reviewItemId: ri2,
        productProfileId: prod2.id,
        state: 'relevant',
      })
      .returning();
    await db.insert(outreachThreadState).values([
      {
        workspaceId: s.workspaceA,
        qualifiedLeadId: lead1!.id,
        threadId: t1.threadId!,
        stage: 'engagement',
      },
      {
        workspaceId: s.workspaceA,
        qualifiedLeadId: lead2!.id,
        threadId: t2.threadId!,
        stage: 'engagement',
      },
    ]);

    const onlyProd1 = await listCommunication(ctx(s.workspaceA, s.ownerA), {
      productId: prod1.id,
    });
    expect(onlyProd1.map((r) => r.threadId)).toEqual([t1.threadId]);
  });
});

describe('countCommunicationByStatus', () => {
  it('partitions by status with the same filters applied (minus status)', async () => {
    const s = await setup();
    const mb = await makeMailbox(s);
    const provider = new MockMailProvider();
    // a: sent only
    await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'a@x.com' }],
      subject: 'A',
      text: 'x',
      providerOverride: provider,
    });
    // b: sent + reply
    const b = await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'b@x.com' }],
      subject: 'B',
      text: 'x',
      providerOverride: provider,
    });
    await db.insert(mailMessages).values({
      workspaceId: s.workspaceA,
      mailboxId: mb.id,
      threadId: b.threadId!,
      messageId: '<r-b@x.com>',
      direction: 'inbound',
      status: 'received',
      fromAddress: 'b@x.com',
      toAddresses: ['sales@nulife.pl'],
      subject: 'Re: B',
      bodyText: 'ok',
      receivedAt: new Date(),
    });

    const counts = await countCommunicationByStatus(ctx(s.workspaceA, s.ownerA));
    expect(counts.all).toBe(2);
    expect(counts.sent).toBe(1);
    expect(counts.replied).toBe(1);
    expect(counts.error).toBe(0);
    expect(counts.scheduled).toBe(0);
  });
});
