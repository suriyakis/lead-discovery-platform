import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { crmSyncLog } from '@/lib/db/schema/crm';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import { ensureQualifiedLead, updateContact } from '@/lib/services/pipeline';
import { createMailbox } from '@/lib/services/mailbox';
import { sendMessage, syncInbound } from '@/lib/services/mail';
import {
  createCrmConnection,
  pushDeal,
  pushLeadToCrm,
  pushThreadAsNotes,
} from '@/lib/services/crm';
import { reviewItems } from '@/lib/db/schema/review';
import { mailThreads } from '@/lib/db/schema/mailing';
import {
  type CrmDealPayload,
  type CrmNotePayload,
  type ICRMConnector,
  type SyncResult,
} from '@/lib/crm';
import { MockMailProvider, type InboundMessage } from '@/lib/mail';
import { LocalFileStorage, _setStorageForTests } from '@/lib/storage';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

let storageRoot: string;

beforeEach(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'lead-crm-p18-'));
  _setStorageForTests(new LocalFileStorage(storageRoot));
  await truncateAll();
});

afterAll(async () => {
  _setStorageForTests(null);
  await rm(storageRoot, { recursive: true, force: true });
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

async function seedScenario(s: Setup) {
  // 1) one product, one connector run, one qualified_lead with contact email.
  const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), {
    name: 'P',
  });
  const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
    templateType: 'mock',
    name: 'Mock',
    config: {},
  });
  const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
    connectorId: c.id,
    name: 'r',
    selectors: { seed: 'p18', count: 1 },
  });
  await startRun(ctx(s.workspaceA, s.ownerA), {
    connectorId: c.id,
    recipeId: r.id,
    wait: true,
  });
  const reviews = await db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.workspaceId, s.workspaceA));
  const lead = await ensureQualifiedLead(
    ctx(s.workspaceA, s.ownerA),
    reviews[0]!.id,
    product.id,
  );
  await updateContact(ctx(s.workspaceA, s.ownerA), lead.id, {
    contactName: 'Anna Kowalska',
    contactEmail: 'anna@target.com',
  });
  // 2) mailbox + sent + received messages
  const mb = await createMailbox(ctx(s.workspaceA, s.ownerA), {
    name: 'sales',
    fromAddress: 'sales@nulife.pl',
    smtpHost: 'smtp.example.com',
    smtpUser: 'sales@nulife.pl',
    smtpPassword: 'pw',
    imap: {
      host: 'imap.example.com',
      user: 'sales@nulife.pl',
      password: 'pw',
    },
  });
  const provider = new MockMailProvider();
  await sendMessage(ctx(s.workspaceA, s.ownerA), {
    mailboxId: mb.id,
    to: [{ address: 'anna@target.com', name: 'Anna Kowalska' }],
    subject: 'Hi Anna',
    text: 'first message',
    providerOverride: provider,
  });
  const inbound: InboundMessage = {
    uid: 1,
    messageId: '<reply1@target.com>',
    inReplyTo: null,
    references: [],
    from: { address: 'anna@target.com', name: 'Anna Kowalska' },
    to: [{ address: mb.fromAddress }],
    cc: [],
    subject: 'Re: Hi Anna',
    textBody: 'tell me more',
    htmlBody: null,
    receivedAt: new Date(),
    headers: {},
    attachments: [],
  };
  provider.enqueueInbound(inbound);
  await syncInbound(ctx(s.workspaceA, s.ownerA), mb.id, provider);

  // 3) CRM connection + a successful contact push so notes/deals can find the externalId.
  const conn = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
    system: 'hubspot',
    name: 'HS',
    credential: 'pat-test',
  });
  const fakeContactPusher: ICRMConnector = {
    id: 'mock',
    async push() {
      return {
        outcome: 'succeeded',
        externalId: 'hs-contact-1',
        payload: {},
        response: {},
      };
    },
    async testConnection() {
      return { ok: true };
    },
  };
  await pushLeadToCrm(ctx(s.workspaceA, s.ownerA), {
    connectionId: conn.id,
    leadId: lead.id,
    connectorOverride: fakeContactPusher,
  });

  return { lead, conn, mb };
}

// ============ pushThreadAsNotes ====================================

describe('pushThreadAsNotes', () => {
  it('pushes every message as a note + dedups on second run', async () => {
    const s = await setup();
    const { conn } = await seedScenario(s);
    const threads = await db
      .select()
      .from(mailThreads)
      .where(eq(mailThreads.workspaceId, s.workspaceA));
    const threadId = threads[0]!.id;

    const noteCalls: CrmNotePayload[] = [];
    const noteFake: ICRMConnector = {
      id: 'mock',
      async push() {
        return { outcome: 'succeeded', payload: {}, response: {} };
      },
      async pushNote(input): Promise<SyncResult> {
        noteCalls.push(input);
        return {
          outcome: 'succeeded',
          externalId: `note-${noteCalls.length}`,
          payload: {},
          response: {},
        };
      },
      async testConnection() {
        return { ok: true };
      },
    };

    const r1 = await pushThreadAsNotes(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
      threadId,
      connectorOverride: noteFake,
    });
    expect(r1.inserted).toBe(2); // outbound + inbound
    expect(r1.failed).toBe(0);
    expect(noteCalls).toHaveLength(2);

    // Re-run — both already pushed, should skip both.
    const r2 = await pushThreadAsNotes(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
      threadId,
      connectorOverride: noteFake,
    });
    expect(r2.inserted).toBe(0);
    expect(r2.skipped).toBe(2);

    // crm_sync_log should have 2 note rows.
    const noteLogs = await db
      .select()
      .from(crmSyncLog)
      .where(eq(crmSyncLog.kind, 'note'));
    expect(noteLogs).toHaveLength(2);
    expect(noteLogs.every((l) => l.outcome === 'succeeded')).toBe(true);
  });

  it('refuses when contact externalId is missing', async () => {
    // Bare scenario without the contact push — should throw conflict.
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA), { name: 'P' });
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'mock',
      name: 'Mock',
      config: {},
    });
    const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      name: 'r',
      selectors: { seed: 'p18-2', count: 1 },
    });
    await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      recipeId: r.id,
      wait: true,
    });
    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    const lead = await ensureQualifiedLead(
      ctx(s.workspaceA, s.ownerA),
      reviews[0]!.id,
      product.id,
    );
    await updateContact(ctx(s.workspaceA, s.ownerA), lead.id, {
      contactName: 'X',
      contactEmail: 'x@target.com',
    });

    const mb = await createMailbox(ctx(s.workspaceA, s.ownerA), {
      name: 'sales',
      fromAddress: 'sales@nulife.pl',
      smtpHost: 'smtp.example.com',
      smtpUser: 'sales@nulife.pl',
      smtpPassword: 'pw',
      imap: {
        host: 'imap.example.com',
        user: 'sales@nulife.pl',
        password: 'pw',
      },
    });
    await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'x@target.com' }],
      subject: 'a',
      text: 'a',
      providerOverride: new MockMailProvider(),
    });
    const threads = await db
      .select()
      .from(mailThreads)
      .where(eq(mailThreads.workspaceId, s.workspaceA));

    const conn = await createCrmConnection(ctx(s.workspaceA, s.ownerA), {
      system: 'hubspot',
      name: 'HS',
      credential: 'pat-test',
    });

    await expect(
      pushThreadAsNotes(ctx(s.workspaceA, s.ownerA), {
        connectionId: conn.id,
        threadId: threads[0]!.id,
        connectorOverride: {
          id: 'm',
          async push() {
            return { outcome: 'succeeded', payload: {}, response: {} };
          },
          async pushNote() {
            return { outcome: 'succeeded', payload: {}, response: {} };
          },
          async testConnection() {
            return { ok: true };
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

// ============ pushDeal =============================================

describe('pushDeal', () => {
  it('creates a deal sync log linked to the contact externalId', async () => {
    const s = await setup();
    const { lead, conn } = await seedScenario(s);

    const dealCalls: CrmDealPayload[] = [];
    const dealFake: ICRMConnector = {
      id: 'mock',
      async push() {
        return { outcome: 'succeeded', payload: {}, response: {} };
      },
      async pushDeal(input): Promise<SyncResult> {
        dealCalls.push(input);
        return {
          outcome: 'succeeded',
          externalId: 'hs-deal-1',
          payload: {},
          response: {},
        };
      },
      async testConnection() {
        return { ok: true };
      },
    };

    const r = await pushDeal(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
      leadId: lead.id,
      connectorOverride: dealFake,
    });
    expect(r.entry.outcome).toBe('succeeded');
    expect(r.entry.kind).toBe('deal');
    expect(r.entry.externalId).toBe('hs-deal-1');
    expect(dealCalls[0]?.contactExternalId).toBe('hs-contact-1');
  });

  it('rejects when the adapter does not support deals', async () => {
    const s = await setup();
    const { lead, conn } = await seedScenario(s);
    const noDeal: ICRMConnector = {
      id: 'mock',
      async push() {
        return { outcome: 'succeeded', payload: {}, response: {} };
      },
      async testConnection() {
        return { ok: true };
      },
    };
    await expect(
      pushDeal(ctx(s.workspaceA, s.ownerA), {
        connectionId: conn.id,
        leadId: lead.id,
        connectorOverride: noDeal,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('reuses a prior deal externalId on subsequent push (update path)', async () => {
    const s = await setup();
    const { lead, conn } = await seedScenario(s);
    let observedPrev: string | null = null;
    const observer: ICRMConnector = {
      id: 'mock',
      async push() {
        return { outcome: 'succeeded', payload: {}, response: {} };
      },
      async pushDeal(_input, prev): Promise<SyncResult> {
        observedPrev = prev;
        return {
          outcome: 'succeeded',
          externalId: prev ?? 'hs-deal-fresh',
          payload: {},
          response: {},
        };
      },
      async testConnection() {
        return { ok: true };
      },
    };
    await pushDeal(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
      leadId: lead.id,
      connectorOverride: observer,
    });
    expect(observedPrev).toBe(null);
    await pushDeal(ctx(s.workspaceA, s.ownerA), {
      connectionId: conn.id,
      leadId: lead.id,
      connectorOverride: observer,
    });
    expect(observedPrev).toBe('hs-deal-fresh');
  });
});
