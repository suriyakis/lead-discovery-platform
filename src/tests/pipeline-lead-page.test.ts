// Regression test for the lead detail page (/pipeline/[id]).
//
// The page used to run a dead query that inner-joined
// contact_associations twice under the same alias. Drizzle 0.38 refuses
// to build that ("Alias contact_associations is already used in this
// query"), so every lead page returned HTTP 500 (audit finding X3,
// deliverable flow:F-02). These tests render the real page for a seeded
// lead, including the mail-thread pickers that block was meant to feed.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { db } from '@/lib/db/client';
import { contactAssociations, contacts } from '@/lib/db/schema/contacts';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { mailboxes, mailMessages, mailThreads } from '@/lib/db/schema/mailing';
import { qualifiedLeads } from '@/lib/db/schema/pipeline';
import { productProfiles } from '@/lib/db/schema/products';
import { reviewItems } from '@/lib/db/schema/review';
import { makeWorkspaceContext } from '@/lib/services/context';
import { createCrmConnection } from '@/lib/services/crm';
import PipelineLeadDetail from '@/app/(app)/pipeline/[id]/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect, renderToHtml } from './helpers/next-render';

// The page reads the signed-in user through Auth.js; tests drive it with
// a plain session object instead. getWorkspaceContext() stays real, so
// workspace resolution runs exactly as it does in production.
const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
// The shell (header, sidebar, nav badges) is shared chrome with its own
// session plumbing; it is not what this page test is about.
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

function signInAs(userId: string): void {
  session.current = { user: { id: userId, role: 'member', accountStatus: 'active' } };
}

async function renderLeadPage(id: string): Promise<string> {
  const tree = await PipelineLeadDetail({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve({}),
  });
  // Drop React's `<!-- -->` text-node separators so assertions can match
  // what the user reads ("Thread 7", not "Thread <!-- -->7").
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

/**
 * One qualified lead whose contact is attached to a mail thread with an
 * inbound reply: the shape that exercises the lead page's
 * thread-for-lead lookup and its Conversation section.
 */
async function seedLeadWithThread(workspaceId: bigint) {
  const [product] = await db
    .insert(productProfiles)
    .values({ workspaceId, name: 'Concrete repair kit' })
    .returning();
  const [source] = await db
    .insert(sourceRecords)
    .values({
      workspaceId,
      sourceSystem: 'mock',
      sourceId: `lead-page-${workspaceId}`,
      rawData: {},
      normalizedData: {},
      sourceUrl: 'https://example.com',
    })
    .returning();
  const [review] = await db
    .insert(reviewItems)
    .values({ workspaceId, sourceRecordId: source!.id, state: 'new' })
    .returning();
  const [lead] = await db
    .insert(qualifiedLeads)
    .values({
      workspaceId,
      reviewItemId: review!.id,
      productProfileId: product!.id,
      state: 'relevant',
      relevantAt: new Date(),
      contactName: 'Anna Example',
    })
    .returning();
  const [mailbox] = await db
    .insert(mailboxes)
    .values({
      workspaceId,
      name: 'sales',
      fromAddress: 'sales@nulife.test',
      smtpHost: 'smtp.example.test',
      smtpUser: 'sales@nulife.test',
      smtpPasswordSecretKey: 'mailbox.smtpPassword_fixedfortests',
      imapFolder: 'INBOX',
      status: 'active',
      isDefault: true,
    })
    .returning();
  const [thread] = await db
    .insert(mailThreads)
    .values({
      workspaceId,
      mailboxId: mailbox!.id,
      subject: 'Repair kit pricing',
      externalThreadKey: `subj:repair-kit-${workspaceId}`,
      participants: ['anna@target.test', 'sales@nulife.test'],
    })
    .returning();
  await db.insert(mailMessages).values({
    workspaceId,
    mailboxId: mailbox!.id,
    threadId: thread!.id,
    direction: 'inbound',
    status: 'received',
    messageId: `<reply-${workspaceId}@target.test>`,
    fromAddress: 'anna@target.test',
    toAddresses: ['sales@nulife.test'],
    subject: 'Re: Repair kit pricing',
    bodyText: 'Could you send the spec sheet?',
  });
  const [contact] = await db
    .insert(contacts)
    .values({ workspaceId, email: 'anna@target.test', name: 'Anna', status: 'active' })
    .returning();
  await db.insert(contactAssociations).values([
    {
      workspaceId,
      contactId: contact!.id,
      entityType: 'qualified_lead',
      entityId: lead!.id.toString(),
    },
    {
      workspaceId,
      contactId: contact!.id,
      entityType: 'mail_thread',
      entityId: thread!.id.toString(),
    },
  ]);
  return { lead: lead!, thread: thread! };
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('/pipeline/[id] lead detail page', () => {
  it('renders a seeded lead with its linked thread instead of failing', async () => {
    const ownerA = await seedUser({ email: 'ownerA@test.local' });
    const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
    const { lead, thread } = await seedLeadWithThread(workspaceA);
    // A CRM connection makes the page render the "Push thread as notes"
    // picker, which lists the threads linked to this lead's contact.
    await createCrmConnection(
      makeWorkspaceContext({ workspaceId: workspaceA, userId: ownerA, role: 'owner' }),
      { system: 'csv', name: 'CSV exports' },
    );
    signInAs(ownerA);

    const html = await renderLeadPage(lead.id.toString());

    expect(html).toContain('<h1>Anna Example</h1>');
    expect(html).toContain('Push thread as notes');
    expect(html).toContain(
      `<option value="${thread.id.toString()}">Repair kit pricing</option>`,
    );
    // Conversation section: the thread and its inbound reply.
    expect(html).toContain(`Thread ${thread.id.toString()}`);
    expect(html).toContain('Could you send the spec sheet?');
  });

  it('renders a lead with no contact or threads', async () => {
    const ownerA = await seedUser({ email: 'ownerA@test.local' });
    const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
    const { lead } = await seedLeadWithThread(workspaceA);
    await db.delete(contactAssociations);
    signInAs(ownerA);

    const html = await renderLeadPage(lead.id.toString());

    expect(html).toContain('<h1>Anna Example</h1>');
    expect(html).toContain('No conversation yet');
    expect(html).not.toContain('Push thread as notes');
  });

  it("redirects to /pipeline for another workspace's lead", async () => {
    const ownerA = await seedUser({ email: 'ownerA@test.local' });
    const ownerB = await seedUser({ email: 'ownerB@test.local' });
    const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
    await seedWorkspace({ name: 'B', ownerUserId: ownerB });
    const { lead } = await seedLeadWithThread(workspaceA);
    signInAs(ownerB);

    await expect(expectRedirect(() => renderLeadPage(lead.id.toString()))).resolves.toBe(
      '/pipeline',
    );
  });
});
