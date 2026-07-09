// Support messaging: customer ↔ platform-admin threads. The critical
// properties are tenant isolation (a workspace can only see its own
// threads; only super-admins see the cross-workspace inbox) and the
// unread-flag handshake between the two sides.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { notifications } from '@/lib/db/schema/notifications';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import {
  SupportServiceError,
  adminGetSupportThread,
  adminListSupportThreads,
  adminReplySupportThread,
  adminSetSupportThreadStatus,
  adminSupportUnreadCount,
  createSupportThread,
  getSupportThread,
  listSupportThreads,
  replyToSupportThread,
  workspaceSupportUnreadCount,
} from '@/lib/services/support';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  viewerA: string;
  ownerB: string;
  admin: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'supA@test.local' });
  const viewerA = await seedUser({ email: 'supViewer@test.local' });
  const ownerB = await seedUser({ email: 'supB@test.local' });
  const admin = await seedUser({ email: 'supAdmin@test.local' });
  const workspaceA = await seedWorkspace({
    name: 'Sup A',
    ownerUserId: ownerA,
    extraMembers: [{ userId: viewerA, role: 'viewer' }],
  });
  const workspaceB = await seedWorkspace({ name: 'Sup B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, viewerA, ownerB, admin };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('customer side', () => {
  it('creates a thread with the first message; viewers may too', async () => {
    const s = await setup();
    const t = await createSupportThread(ctx(s.workspaceA, s.viewerA, 'viewer'), {
      subject: 'Billing question',
      body: 'How do I get an invoice?',
    });
    expect(t.workspaceId).toBe(s.workspaceA);
    expect(t.status).toBe('open');
    expect(t.adminUnread).toBe(true);
    expect(t.customerUnread).toBe(false);

    const { messages } = await getSupportThread(ctx(s.workspaceA, s.ownerA), t.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.senderKind).toBe('customer');
  });

  it('rejects empty subject / body', async () => {
    const s = await setup();
    await expect(
      createSupportThread(ctx(s.workspaceA, s.ownerA), { subject: ' ', body: 'x' }),
    ).rejects.toThrow(SupportServiceError);
    await expect(
      createSupportThread(ctx(s.workspaceA, s.ownerA), { subject: 'x', body: '  ' }),
    ).rejects.toThrow(SupportServiceError);
  });

  it('is workspace-isolated: B cannot read or reply to A threads', async () => {
    const s = await setup();
    const t = await createSupportThread(ctx(s.workspaceA, s.ownerA), {
      subject: 'Private to A',
      body: 'secret',
    });

    expect(await listSupportThreads(ctx(s.workspaceB, s.ownerB))).toHaveLength(0);
    await expect(
      getSupportThread(ctx(s.workspaceB, s.ownerB), t.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      replyToSupportThread(ctx(s.workspaceB, s.ownerB), t.id, 'intrusion'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('customer reply reopens a closed thread and flags the admin side', async () => {
    const s = await setup();
    const t = await createSupportThread(ctx(s.workspaceA, s.ownerA), {
      subject: 'Bug',
      body: 'It broke.',
    });
    const adminCtx = ctx(s.workspaceA, s.admin, 'super_admin');
    await adminGetSupportThread(adminCtx, t.id); // clears adminUnread
    await adminSetSupportThreadStatus(adminCtx, t.id, 'closed');

    await replyToSupportThread(ctx(s.workspaceA, s.ownerA), t.id, 'Still broken!');
    const rows = await listSupportThreads(ctx(s.workspaceA, s.ownerA));
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.adminUnread).toBe(true);
  });
});

describe('admin side', () => {
  it('inbox lists across workspaces, unread first; non-super-admin denied', async () => {
    const s = await setup();
    await createSupportThread(ctx(s.workspaceA, s.ownerA), { subject: 'From A', body: 'a' });
    await createSupportThread(ctx(s.workspaceB, s.ownerB), { subject: 'From B', body: 'b' });

    const adminCtx = ctx(s.workspaceA, s.admin, 'super_admin');
    const inbox = await adminListSupportThreads(adminCtx);
    expect(inbox).toHaveLength(2);
    expect(new Set(inbox.map((t) => t.workspaceName))).toEqual(new Set(['Sup A', 'Sup B']));

    await expect(
      adminListSupportThreads(ctx(s.workspaceA, s.ownerA)),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('admin reply flags customer unread + drops a workspace notification', async () => {
    const s = await setup();
    const t = await createSupportThread(ctx(s.workspaceA, s.ownerA), {
      subject: 'Need help',
      body: 'help',
    });
    const adminCtx = ctx(s.workspaceA, s.admin, 'super_admin');
    await adminReplySupportThread(adminCtx, t.id, 'On it — try clearing the recipe country.');

    const { thread, messages } = await getSupportThread(ctx(s.workspaceA, s.ownerA), t.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.senderKind).toBe('admin');
    // getSupportThread already cleared the flag it set — verify via read path:
    expect(thread.customerUnread).toBe(false);

    const notes = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, s.workspaceA),
          eq(notifications.kind, 'support.reply'),
        ),
      );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.href).toBe(`/support/${t.id}`);
  });

  it('unread counters track the handshake on both sides', async () => {
    const s = await setup();
    const t = await createSupportThread(ctx(s.workspaceA, s.ownerA), {
      subject: 'Counters',
      body: 'ping',
    });
    const adminCtx = ctx(s.workspaceA, s.admin, 'super_admin');

    expect(await adminSupportUnreadCount()).toBe(1);
    await adminGetSupportThread(adminCtx, t.id);
    expect(await adminSupportUnreadCount()).toBe(0);

    await adminReplySupportThread(adminCtx, t.id, 'pong');
    expect(await workspaceSupportUnreadCount(ctx(s.workspaceA, s.ownerA))).toBe(1);
    await getSupportThread(ctx(s.workspaceA, s.ownerA), t.id);
    expect(await workspaceSupportUnreadCount(ctx(s.workspaceA, s.ownerA))).toBe(0);
  });

  it('close and reopen are audit-safe and super-admin-only', async () => {
    const s = await setup();
    const t = await createSupportThread(ctx(s.workspaceA, s.ownerA), {
      subject: 'Close me',
      body: 'x',
    });
    const adminCtx = ctx(s.workspaceA, s.admin, 'super_admin');
    const closed = await adminSetSupportThreadStatus(adminCtx, t.id, 'closed');
    expect(closed.status).toBe('closed');
    const reopened = await adminSetSupportThreadStatus(adminCtx, t.id, 'open');
    expect(reopened.status).toBe('open');

    await expect(
      adminSetSupportThreadStatus(ctx(s.workspaceA, s.ownerA), t.id, 'closed'),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
