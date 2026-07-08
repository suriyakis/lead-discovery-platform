// Notification feed tests: visibility (workspace-wide vs targeted),
// unread dedupe, read transitions, workspace isolation, and the
// producer hooks (assignment, mention, low tokens).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock';
import { db } from '@/lib/db/client';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  notify,
  unreadNotificationCount,
} from '@/lib/services/notifications';
import { creditTokens, debitTokens } from '@/lib/services/token-ledger';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  memberA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'notif-ownerA@test.local' });
  const memberA = await seedUser({ email: 'notif-memberA@test.local' });
  const ownerB = await seedUser({ email: 'notif-ownerB@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, memberA, ownerB };
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

describe('notification feed', () => {
  it('workspace-wide rows are visible to every member; targeted rows only to the target', async () => {
    const s = await setup();
    await notify(s.workspaceA, { kind: 'lead.replied', title: 'broadcast' });
    await notify(s.workspaceA, {
      kind: 'mention',
      title: 'targeted',
      userId: s.memberA,
    });

    const forOwner = await listNotifications(ctx(s.workspaceA, s.ownerA));
    expect(forOwner.map((n) => n.title)).toEqual(['broadcast']);

    const forMember = await listNotifications(ctx(s.workspaceA, s.memberA));
    expect(forMember.map((n) => n.title).sort()).toEqual(['broadcast', 'targeted']);
  });

  it('dedupeKey drops duplicates while unread, allows again after read', async () => {
    const s = await setup();
    const first = await notify(s.workspaceA, {
      kind: 'tokens.low',
      title: 'low',
      dedupeKey: 'tokens.low',
    });
    const duplicate = await notify(s.workspaceA, {
      kind: 'tokens.low',
      title: 'low again',
      dedupeKey: 'tokens.low',
    });
    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();

    await markAllNotificationsRead(ctx(s.workspaceA, s.ownerA));
    const after = await notify(s.workspaceA, {
      kind: 'tokens.low',
      title: 'low after read',
      dedupeKey: 'tokens.low',
    });
    expect(after).not.toBeNull();
  });

  it('unread count + markNotificationsRead scoping', async () => {
    const s = await setup();
    const a = await notify(s.workspaceA, { kind: 'x', title: 'one' });
    await notify(s.workspaceA, { kind: 'x', title: 'two' });
    expect(await unreadNotificationCount(ctx(s.workspaceA, s.ownerA))).toBe(2);

    const marked = await markNotificationsRead(ctx(s.workspaceA, s.ownerA), [a!.id]);
    expect(marked).toBe(1);
    expect(await unreadNotificationCount(ctx(s.workspaceA, s.ownerA))).toBe(1);
  });

  it('never leaks across workspaces', async () => {
    const s = await setup();
    await notify(s.workspaceA, { kind: 'x', title: 'A only' });
    const inB = await listNotifications(ctx(s.workspaceB, s.ownerB));
    expect(inB).toHaveLength(0);
    // Marking in B touches nothing in A.
    expect(await markAllNotificationsRead(ctx(s.workspaceB, s.ownerB))).toBe(0);
    expect(await unreadNotificationCount(ctx(s.workspaceA, s.ownerA))).toBe(1);
  });

  it('low-token debits produce a deduped tokens.low notification', async () => {
    const s = await setup();
    // Welcome balance 500 → debit to 60 (below the 100 threshold).
    await debitTokens(s.workspaceA, { tokens: 440, reason: 'ai.generate' });
    let unread = await listNotifications(ctx(s.workspaceA, s.ownerA), {
      unreadOnly: true,
    });
    expect(unread.some((n) => n.kind === 'tokens.low')).toBe(true);

    // Another debit while unread does NOT double-notify.
    await debitTokens(s.workspaceA, { tokens: 10, reason: 'ai.generate' });
    unread = await listNotifications(ctx(s.workspaceA, s.ownerA), {
      unreadOnly: true,
    });
    expect(unread.filter((n) => n.kind === 'tokens.low')).toHaveLength(1);

    // Top-up + read → threshold crossing can notify again later.
    await creditTokens(s.workspaceA, {
      tokens: 1000,
      kind: 'purchase',
      reason: 'pack_s',
    });
    await markAllNotificationsRead(ctx(s.workspaceA, s.ownerA));
    await debitTokens(s.workspaceA, { tokens: 1005, reason: 'ai.generate' });
    unread = await listNotifications(ctx(s.workspaceA, s.ownerA), {
      unreadOnly: true,
    });
    expect(unread.filter((n) => n.kind === 'tokens.low')).toHaveLength(1);
  });
});
