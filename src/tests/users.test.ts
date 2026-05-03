import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { preauthorizedEmails, users } from '@/lib/db/schema/auth';
import { workspaceMembers } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  UserServiceError,
  addMember,
  listAllUsers,
  listPreauthorizedEmails,
  listWorkspaceMembers,
  preauthorizeEmail,
  removeMember,
  revokePreauthorize,
  setAccountStatus,
  setMemberRole,
} from '@/lib/services/users';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
  godUser: string;
  member1: string;
  member2: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const godUser = await seedUser({ email: 'god@test.local', role: 'super_admin' });
  const member1 = await seedUser({ email: 'member1@test.local' });
  const member2 = await seedUser({ email: 'member2@test.local' });
  const workspaceA = await seedWorkspace({
    name: 'A',
    ownerUserId: ownerA,
    extraMembers: [{ userId: member1, role: 'member' }],
  });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB, godUser, member1, member2 };
}

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role']): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ account status ===========================================

describe('account status (super_admin)', () => {
  it('setAccountStatus suspends a user', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    const updated = await setAccountStatus(god, s.member1, 'suspended', 'too noisy');
    expect(updated.accountStatus).toBe('suspended');
    expect(updated.accountStatusReason).toBe('too noisy');
    expect(updated.accountStatusUpdatedBy).toBe(s.godUser);
  });

  it('cannot suspend yourself', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    await expect(
      setAccountStatus(god, s.godUser, 'suspended'),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('non-super_admin denied', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    await expect(
      setAccountStatus(owner, s.member1, 'suspended'),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('listAllUsers can filter by status', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    await setAccountStatus(god, s.member1, 'suspended');
    const all = await listAllUsers(god);
    expect(all.length).toBeGreaterThanOrEqual(5);
    const suspended = await listAllUsers(god, { status: 'suspended' });
    expect(suspended.map((u) => u.id)).toEqual([s.member1]);
  });
});

// ============ pre-authorize ============================================

describe('pre-authorize', () => {
  it('preauthorizeEmail records the email + workspace + role', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    const entry = await preauthorizeEmail(god, {
      email: 'New.User@Example.com',
      workspaceId: s.workspaceA,
      role: 'manager',
    });
    expect(entry.email).toBe('new.user@example.com');
    expect(entry.workspaceId).toBe(s.workspaceA.toString());
    expect(entry.role).toBe('manager');
    expect(entry.consumedAt).toBe(null);
  });

  it('re-preauthorizing the same email replaces the prior unconsumed entry', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    const a = await preauthorizeEmail(god, {
      email: 'x@example.com',
      workspaceId: s.workspaceA,
      role: 'member',
    });
    const b = await preauthorizeEmail(god, {
      email: 'x@example.com',
      workspaceId: s.workspaceA,
      role: 'admin',
    });
    expect(b.id).not.toBe(a.id);
    const all = await db
      .select()
      .from(preauthorizedEmails)
      .where(eq(preauthorizedEmails.email, 'x@example.com'));
    expect(all).toHaveLength(1);
    expect(all[0]!.role).toBe('admin');
  });

  it('preauthorizing an already-existing user lifts them to active', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    // member2 was seeded as 'active' by default; flip to pending first.
    await db
      .update(users)
      .set({ accountStatus: 'pending' })
      .where(eq(users.id, s.member2));

    await preauthorizeEmail(god, {
      email: 'member2@test.local',
      workspaceId: s.workspaceB,
      role: 'manager',
    });
    const reloaded = await db.select().from(users).where(eq(users.id, s.member2));
    expect(reloaded[0]!.accountStatus).toBe('active');
  });

  it('revokePreauthorize deletes an unconsumed entry', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    const entry = await preauthorizeEmail(god, {
      email: 'tmp@example.com',
    });
    await revokePreauthorize(god, entry.id);
    const list = await listPreauthorizedEmails(god);
    expect(list).toHaveLength(0);
  });

  it('rejects bad email shape', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    await expect(
      preauthorizeEmail(god, { email: 'not-an-email' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('non-super_admin denied', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    await expect(
      preauthorizeEmail(owner, { email: 'x@example.com' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

// ============ workspace membership =====================================

describe('workspace membership (admin)', () => {
  it('listWorkspaceMembers returns workspace-scoped members', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    const list = await listWorkspaceMembers(owner);
    const userIds = list.map((m) => m.user.id).sort();
    expect(userIds).toEqual([s.ownerA, s.member1].sort());
  });

  it('addMember + setMemberRole + removeMember', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    const added = await addMember(owner, s.member2, 'member');
    expect(added.role).toBe('member');
    const promoted = await setMemberRole(owner, s.member2, 'admin');
    expect(promoted.role).toBe('admin');
    await removeMember(owner, s.member2);
    const list = await listWorkspaceMembers(owner);
    expect(list.find((m) => m.user.id === s.member2)).toBeUndefined();
  });

  it('cannot demote the last owner', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    await expect(
      setMemberRole(owner, s.ownerA, 'admin'),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('cannot remove the last owner', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    await expect(removeMember(owner, s.ownerA)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('addMember refuses non-active users', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    await db
      .update(users)
      .set({ accountStatus: 'pending' })
      .where(eq(users.id, s.member2));
    await expect(addMember(owner, s.member2)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('addMember refuses an existing member (idempotency check)', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    await expect(addMember(owner, s.member1)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('non-admin denied', async () => {
    const s = await setup();
    const member = ctx(s.workspaceA, s.member1, 'member');
    await expect(addMember(member, s.member2)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(
      setMemberRole(member, s.member1, 'admin'),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(removeMember(member, s.ownerA)).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });
});

// ============ isolation ================================================

describe('isolation', () => {
  it('listWorkspaceMembers does not leak across workspaces', async () => {
    const s = await setup();
    const ownerA = ctx(s.workspaceA, s.ownerA, 'owner');
    const ownerB = ctx(s.workspaceB, s.ownerB, 'owner');
    const inA = await listWorkspaceMembers(ownerA);
    const inB = await listWorkspaceMembers(ownerB);
    expect(inA.map((m) => m.user.email).sort()).toEqual([
      'member1@test.local',
      'ownerA@test.local',
    ]);
    expect(inB.map((m) => m.user.email)).toEqual(['ownerB@test.local']);
  });

  it('workspaceMembers row + UserServiceError shape', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    try {
      await setMemberRole(owner, 'no-such-user', 'manager');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UserServiceError);
      expect((err as UserServiceError).code).toBe('not_found');
    }
    void workspaceMembers;
  });
});
