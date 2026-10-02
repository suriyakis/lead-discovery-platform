// Regression tests for the /mailbox/[id] bulk actions (audit X4,
// deliverable flow:F-02).
//
// The actions used to be inline "use server" functions in page.tsx that
// closed over local helpers; Next could not serialise those closures, so
// the bulk Trash / Spam buttons failed in production with "Functions
// cannot be passed directly to Client Components". They now live in
// src/app/(app)/mailbox/[id]/actions.ts, bound to the mailbox id. These tests
// run those actions against the database the way the page wires them, and
// render the page itself. server-action-closures.test.ts guards the
// closure rule for every page.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailboxes, mailMessages } from '@/lib/db/schema/mailing';
import {
  deleteMailboxMessages,
  restoreMailboxMessages,
  retryMailboxMessages,
  spamMailboxMessages,
  trashMailboxMessages,
  unspamMailboxMessages,
} from '@/app/(app)/mailbox/[id]/actions';
import MailboxDetail from '@/app/(app)/mailbox/[id]/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect, renderToHtml } from './helpers/next-render';

// Tests sign in through a plain session object instead of Auth.js;
// getWorkspaceContext() stays real so role + workspace resolution is the
// production code path.
const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

function signInAs(userId: string): void {
  session.current = { user: { id: userId, role: 'member', accountStatus: 'active' } };
}

function form(fields: { ids?: string[]; folder?: string; q?: string }): FormData {
  const fd = new FormData();
  for (const id of fields.ids ?? []) fd.append('ids', id);
  fd.set('folder', fields.folder ?? 'inbox');
  fd.set('q', fields.q ?? '');
  return fd;
}

/** Decode a redirect target into path + query for readable assertions. */
function parseTarget(target: string): { path: string; query: Record<string, string> } {
  const url = new URL(target, 'http://app.test');
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

async function seedMailbox(workspaceId: bigint) {
  const [mailbox] = await db
    .insert(mailboxes)
    .values({
      workspaceId,
      name: 'sales',
      fromAddress: `sales-${workspaceId}@nulife.test`,
      smtpHost: 'smtp.example.test',
      smtpUser: `sales-${workspaceId}@nulife.test`,
      smtpPasswordSecretKey: 'mailbox.smtpPassword_fixedfortests',
      imapFolder: 'INBOX',
      status: 'active',
      isDefault: true,
    })
    .returning();
  return mailbox!;
}

async function seedInbound(workspaceId: bigint, mailboxId: bigint, subject: string) {
  const [msg] = await db
    .insert(mailMessages)
    .values({
      workspaceId,
      mailboxId,
      direction: 'inbound',
      status: 'received',
      messageId: `<${subject.replace(/\W+/g, '-')}-${workspaceId}@target.test>`,
      fromAddress: 'anna@target.test',
      toAddresses: [`sales-${workspaceId}@nulife.test`],
      subject,
      bodyText: `Body of ${subject}`,
      receivedAt: new Date(),
    })
    .returning();
  return msg!;
}

async function loadMessages(ids: bigint[]) {
  const rows = await db.select().from(mailMessages).where(inArray(mailMessages.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

interface Fixture {
  ownerA: string;
  workspaceA: bigint;
  mailboxId: bigint;
  m1: bigint;
  m2: bigint;
  m3: bigint;
}

async function setup(): Promise<Fixture> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const mailbox = await seedMailbox(workspaceA);
  const m1 = await seedInbound(workspaceA, mailbox.id, 'Pricing question');
  const m2 = await seedInbound(workspaceA, mailbox.id, 'Pricing follow-up');
  const m3 = await seedInbound(workspaceA, mailbox.id, 'Win a free cruise');
  return { ownerA, workspaceA, mailboxId: mailbox.id, m1: m1.id, m2: m2.id, m3: m3.id };
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('/mailbox/[id] bulk actions', () => {
  it('Move to trash moves only the selected messages and returns to the same view', async () => {
    const f = await setup();
    signInAs(f.ownerA);
    const trash = trashMailboxMessages.bind(null, f.mailboxId.toString());

    const target = await expectRedirect(() =>
      trash(form({ ids: [f.m1.toString(), f.m2.toString()], folder: 'inbox', q: 'pricing' })),
    );

    expect(parseTarget(target)).toEqual({
      path: `/mailbox/${f.mailboxId}`,
      query: { folder: 'inbox', q: 'pricing', message: '2 messages moved to trash.' },
    });
    const rows = await loadMessages([f.m1, f.m2, f.m3]);
    expect(rows.get(f.m1)!.trashedAt).toBeInstanceOf(Date);
    expect(rows.get(f.m2)!.trashedAt).toBeInstanceOf(Date);
    expect(rows.get(f.m3)!.trashedAt).toBeNull();
  });

  it('Mark as spam flags the selected message and ignores malformed ids', async () => {
    const f = await setup();
    signInAs(f.ownerA);
    const spam = spamMailboxMessages.bind(null, f.mailboxId.toString());

    const target = await expectRedirect(() =>
      spam(form({ ids: [f.m3.toString(), 'abc', '', '-1', '1.5'] })),
    );

    expect(parseTarget(target).query).toEqual({
      folder: 'inbox',
      message: '1 message flagged as spam.',
    });
    const rows = await loadMessages([f.m1, f.m3]);
    expect(rows.get(f.m3)!.spamAt).toBeInstanceOf(Date);
    expect(rows.get(f.m3)!.spamReason).toBe('manual');
    expect(rows.get(f.m1)!.spamAt).toBeNull();
  });

  it('Not spam and Restore undo spam and trash', async () => {
    const f = await setup();
    signInAs(f.ownerA);
    const mailboxIdArg = f.mailboxId.toString();
    await expectRedirect(() =>
      spamMailboxMessages(mailboxIdArg, form({ ids: [f.m1.toString()] })),
    );
    await expectRedirect(() =>
      trashMailboxMessages(mailboxIdArg, form({ ids: [f.m2.toString()] })),
    );

    const unspamTarget = await expectRedirect(() =>
      unspamMailboxMessages(mailboxIdArg, form({ ids: [f.m1.toString()], folder: 'spam' })),
    );
    const restoreTarget = await expectRedirect(() =>
      restoreMailboxMessages(mailboxIdArg, form({ ids: [f.m2.toString()], folder: 'trash' })),
    );

    expect(parseTarget(unspamTarget).query).toEqual({
      folder: 'spam',
      message: '1 message un-flagged.',
    });
    expect(parseTarget(restoreTarget).query).toEqual({
      folder: 'trash',
      message: '1 message restored.',
    });
    const rows = await loadMessages([f.m1, f.m2]);
    expect(rows.get(f.m1)!.spamAt).toBeNull();
    expect(rows.get(f.m2)!.trashedAt).toBeNull();
  });

  it('Delete permanently removes trashed messages and reports ineligible ones as an error', async () => {
    const f = await setup();
    signInAs(f.ownerA);
    const mailboxIdArg = f.mailboxId.toString();
    await expectRedirect(() =>
      trashMailboxMessages(mailboxIdArg, form({ ids: [f.m1.toString()] })),
    );

    const okTarget = await expectRedirect(() =>
      deleteMailboxMessages(mailboxIdArg, form({ ids: [f.m1.toString()], folder: 'trash' })),
    );
    // m2 was never trashed: the service refuses the whole batch.
    const errTarget = await expectRedirect(() =>
      deleteMailboxMessages(mailboxIdArg, form({ ids: [f.m2.toString()], folder: 'trash' })),
    );

    expect(parseTarget(okTarget).query).toEqual({
      folder: 'trash',
      message: '1 message permanently deleted.',
    });
    expect(parseTarget(errTarget).query.folder).toBe('trash');
    expect(parseTarget(errTarget).query.error).toMatch(/not in trash/);
    const rows = await loadMessages([f.m1, f.m2]);
    expect(rows.has(f.m1)).toBe(false);
    expect(rows.has(f.m2)).toBe(true);
  });

  it('Retry selected reports inbound messages as ineligible without sending', async () => {
    const f = await setup();
    signInAs(f.ownerA);

    const target = await expectRedirect(() =>
      retryMailboxMessages(
        f.mailboxId.toString(),
        form({ ids: [f.m1.toString()], folder: 'errors' }),
      ),
    );

    expect(parseTarget(target).query).toEqual({ folder: 'errors', message: '1 ineligible.' });
  });

  it('cannot touch another workspace’s messages', async () => {
    const f = await setup();
    const ownerB = await seedUser({ email: 'ownerB@test.local' });
    const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
    const mailboxB = await seedMailbox(workspaceB);
    signInAs(ownerB);

    const target = await expectRedirect(() =>
      trashMailboxMessages(mailboxB.id.toString(), form({ ids: [f.m1.toString()] })),
    );

    expect(parseTarget(target).query.message).toBe(
      'No messages moved to trash (nothing was selected or eligible).',
    );
    const rows = await loadMessages([f.m1]);
    expect(rows.get(f.m1)!.trashedAt).toBeNull();
  });

  it('a viewer gets an error flash and nothing moves', async () => {
    const f = await setup();
    const viewer = await seedUser({ email: 'viewer@test.local' });
    const { workspaceMembers } = await import('@/lib/db/schema/workspaces');
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: f.workspaceA, userId: viewer, role: 'viewer' });
    signInAs(viewer);

    const target = await expectRedirect(() =>
      trashMailboxMessages(f.mailboxId.toString(), form({ ids: [f.m1.toString()] })),
    );

    const parsed = parseTarget(target);
    expect(parsed.path).toBe(`/mailbox/${f.mailboxId}`);
    expect(parsed.query.error).toBeTruthy();
    expect(parsed.query.message).toBeUndefined();
    const rows = await loadMessages([f.m1]);
    expect(rows.get(f.m1)!.trashedAt).toBeNull();
  });

  it('rejects a tampered mailbox id and falls back to an inbox view for an unknown folder', async () => {
    const f = await setup();
    signInAs(f.ownerA);

    await expect(
      expectRedirect(() =>
        trashMailboxMessages('../settings', form({ ids: [f.m1.toString()] })),
      ),
    ).resolves.toBe('/mailbox');
    const target = await expectRedirect(() =>
      trashMailboxMessages(
        f.mailboxId.toString(),
        form({ ids: [f.m1.toString()], folder: 'javascript:alert(1)' }),
      ),
    );

    expect(parseTarget(target).query.folder).toBe('inbox');
    // Only the second (valid) call moved the message.
    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, f.m1));
    expect(row!.trashedAt).toBeInstanceOf(Date);
  });
});

describe('/mailbox/[id] page', () => {
  async function renderMailbox(mailboxId: bigint, folder: string): Promise<string> {
    const tree = await MailboxDetail({
      params: Promise.resolve({ id: mailboxId.toString() }),
      searchParams: Promise.resolve({ folder }),
    });
    return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
  }

  it('renders the inbox with its messages and the bulk buttons', async () => {
    const f = await setup();
    signInAs(f.ownerA);

    const html = await renderMailbox(f.mailboxId, 'inbox');

    expect(html).toContain('Pricing question');
    expect(html).toContain(`value="${f.m1.toString()}"`);
    expect(html).toContain('Move to trash');
    expect(html).toContain('Mark as spam');
  });

  it('renders the trash folder with Restore and Delete permanently', async () => {
    const f = await setup();
    signInAs(f.ownerA);
    await expectRedirect(() =>
      trashMailboxMessages(f.mailboxId.toString(), form({ ids: [f.m1.toString()] })),
    );

    const html = await renderMailbox(f.mailboxId, 'trash');

    expect(html).toContain('Pricing question');
    expect(html).toContain('Restore');
    expect(html).toContain('Delete permanently');
    expect(html).not.toContain('Move to trash');
  });
});
