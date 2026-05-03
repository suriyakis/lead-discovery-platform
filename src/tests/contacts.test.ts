import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import { mailMessages } from '@/lib/db/schema/mailing';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  ContactServiceError,
  archiveContact,
  attachContact,
  getContactByEmail,
  getContactDetail,
  listContacts,
  mergeContacts,
  updateContact,
  upsertContact,
} from '@/lib/services/contacts';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { createProductProfile } from '@/lib/services/product-profile';
import { ensureQualifiedLead, updateContact as pipelineUpdateContact } from '@/lib/services/pipeline';
import { createMailbox } from '@/lib/services/mailbox';
import { sendMessage, syncInbound } from '@/lib/services/mail';
import { reviewItems } from '@/lib/db/schema/review';
import { MockMailProvider } from '@/lib/mail';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB };
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

// ============ upsert / merge fields ===================================

describe('upsertContact', () => {
  it('inserts a new contact with normalized email + derived domain', async () => {
    const s = await setup();
    const c = await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'Anna.Kowalska@Acme.COM',
      name: 'Anna Kowalska',
      role: 'COO',
    });
    expect(c.email).toBe('anna.kowalska@acme.com');
    expect(c.companyDomain).toBe('acme.com');
    expect(c.name).toBe('Anna Kowalska');
  });

  it('upsert merges sparse fields without clobbering existing values', async () => {
    const s = await setup();
    const a = await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'x@example.com',
      name: 'Alice',
    });
    const b = await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'X@example.com',
      role: 'CTO',
      phone: '+1 555 123',
    });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe('Alice');
    expect(b.role).toBe('CTO');
    expect(b.phone).toBe('+1 555 123');
  });

  it('upsert does NOT overwrite an existing name with a new one', async () => {
    const s = await setup();
    const a = await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'x@example.com',
      name: 'Alice',
    });
    const b = await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'x@example.com',
      name: 'Bob',
    });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe('Alice');
  });

  it('rejects bad email shape', async () => {
    const s = await setup();
    await expect(
      upsertContact(ctx(s.workspaceA, s.ownerA), { email: 'not-an-email' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('viewer-denied', async () => {
    const s = await setup();
    await expect(
      upsertContact(ctx(s.workspaceA, s.ownerA, 'viewer'), {
        email: 'x@example.com',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

// ============ update / archive =======================================

describe('updateContact / archiveContact', () => {
  it('updateContact replaces only the supplied fields', async () => {
    const s = await setup();
    const c = await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'x@example.com',
      name: 'Alice',
      role: 'CTO',
    });
    const updated = await updateContact(ctx(s.workspaceA, s.ownerA), c.id, {
      role: 'CEO',
      tags: ['VIP'],
    });
    expect(updated.name).toBe('Alice');
    expect(updated.role).toBe('CEO');
    expect(updated.tags).toEqual(['vip']);
  });

  it('archive admin-only', async () => {
    const s = await setup();
    const c = await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'x@example.com',
    });
    await expect(
      archiveContact(ctx(s.workspaceA, s.ownerA, 'member'), c.id),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    const archived = await archiveContact(ctx(s.workspaceA, s.ownerA), c.id);
    expect(archived.status).toBe('archived');
  });
});

// ============ list / detail ==========================================

describe('listContacts / getContactDetail', () => {
  it('list filters by company domain and search query', async () => {
    const s = await setup();
    await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'a@acme.com',
      companyName: 'Acme Inc',
    });
    await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'b@acme.com',
      companyName: 'Acme Inc',
    });
    await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'c@beta.com',
      companyName: 'Beta Co',
    });

    const acme = await listContacts(ctx(s.workspaceA, s.ownerA), {
      companyDomain: 'acme.com',
    });
    expect(acme.map((c) => c.email).sort()).toEqual(['a@acme.com', 'b@acme.com']);

    const matchQ = await listContacts(ctx(s.workspaceA, s.ownerA), { q: 'beta' });
    expect(matchQ.map((c) => c.email)).toEqual(['c@beta.com']);
  });

  it('does not leak across workspaces', async () => {
    const s = await setup();
    await upsertContact(ctx(s.workspaceA, s.ownerA), { email: 'a@x.com' });
    const inB = await listContacts(ctx(s.workspaceB, s.ownerB));
    expect(inB).toHaveLength(0);
    const inAByEmail = await getContactByEmail(
      ctx(s.workspaceA, s.ownerA),
      'a@x.com',
    );
    expect(inAByEmail?.email).toBe('a@x.com');
    const crossLook = await getContactByEmail(
      ctx(s.workspaceB, s.ownerB),
      'a@x.com',
    );
    expect(crossLook).toBe(null);
  });

  it('getContactDetail aggregates leads + threads + recent messages', async () => {
    const s = await setup();
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
      selectors: { seed: 'contacts', count: 1 },
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
    // Pipeline updateContact should sync into the contacts table.
    await pipelineUpdateContact(ctx(s.workspaceA, s.ownerA), lead.id, {
      contactName: 'Anna Kowalska',
      contactEmail: 'anna@target.com',
      contactRole: 'COO',
    });

    const contact = await getContactByEmail(
      ctx(s.workspaceA, s.ownerA),
      'anna@target.com',
    );
    expect(contact).not.toBeNull();

    const detail = await getContactDetail(ctx(s.workspaceA, s.ownerA), contact!.id);
    expect(detail.leads.map((l) => l.id)).toEqual([lead.id]);
  });
});

// ============ pipeline + mail wiring =================================

describe('contacts auto-resolved from outbound + inbound mail', () => {
  async function newMailbox(s: Setup) {
    return createMailbox(ctx(s.workspaceA, s.ownerA), {
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
  }

  it('outbound sendMessage creates/links a contact', async () => {
    const s = await setup();
    const mb = await newMailbox(s);
    const provider = new MockMailProvider();
    await sendMessage(ctx(s.workspaceA, s.ownerA), {
      mailboxId: mb.id,
      to: [{ address: 'lead@target.com', name: 'Lead Person' }],
      subject: 'Hi',
      text: 'hi',
      providerOverride: provider,
    });
    const contact = await getContactByEmail(
      ctx(s.workspaceA, s.ownerA),
      'lead@target.com',
    );
    expect(contact).not.toBeNull();
    expect(contact?.name).toBe('Lead Person');
    const messageRows = await db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.workspaceId, s.workspaceA));
    expect(messageRows[0]!.contactId).toBe(contact!.id);
  });

  it('inbound syncInbound creates/links a contact for the sender', async () => {
    const s = await setup();
    const mb = await newMailbox(s);
    const provider = new MockMailProvider();
    provider.enqueueInbound({
      uid: 1,
      messageId: '<m1@target.com>',
      inReplyTo: null,
      references: [],
      from: { address: 'lead@target.com', name: 'Lead Person' },
      to: [{ address: mb.fromAddress }],
      cc: [],
      subject: 'Question',
      textBody: 'we want a quote',
      htmlBody: null,
      receivedAt: new Date(),
      headers: {},
      attachments: [],
    });
    await syncInbound(ctx(s.workspaceA, s.ownerA), mb.id, provider);

    const contact = await getContactByEmail(
      ctx(s.workspaceA, s.ownerA),
      'lead@target.com',
    );
    expect(contact).not.toBeNull();
    const associations = await db
      .select()
      .from(contactAssociations)
      .where(eq(contactAssociations.contactId, contact!.id));
    expect(associations.some((a) => a.entityType === 'mail_thread')).toBe(true);
  });
});

// ============ merge ==================================================

describe('mergeContacts', () => {
  it('re-points associations + mail_messages and archives source', async () => {
    const s = await setup();
    const target = await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'work@acme.com',
      name: 'Anna',
    });
    const source = await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'personal@gmail.com',
      role: 'CEO',
    });
    await attachContact(ctx(s.workspaceA, s.ownerA), source.id, {
      type: 'qualified_lead',
      id: '999',
    });
    const merged = await mergeContacts(
      ctx(s.workspaceA, s.ownerA),
      target.id,
      source.id,
    );
    expect(merged.id).toBe(target.id);
    expect(merged.role).toBe('CEO'); // sparse merge

    const sourceReloaded = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, source.id));
    expect(sourceReloaded[0]!.status).toBe('archived');

    const associations = await db
      .select()
      .from(contactAssociations)
      .where(eq(contactAssociations.contactId, target.id));
    expect(associations.some((a) => a.entityId === '999')).toBe(true);
  });

  it('refuses cross-workspace merge', async () => {
    const s = await setup();
    const a = await upsertContact(ctx(s.workspaceA, s.ownerA), {
      email: 'a@x.com',
    });
    const b = await upsertContact(ctx(s.workspaceB, s.ownerB), {
      email: 'b@x.com',
    });
    await expect(
      mergeContacts(ctx(s.workspaceA, s.ownerA), a.id, b.id),
    ).rejects.toBeInstanceOf(ContactServiceError);
  });
});
