import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaceMembers } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  adminAddUserToWorkspace,
  adminSetMemberRole,
  moveUserBetweenWorkspaces,
} from '@/lib/services/admin';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
  superAdmin: string;
  member: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const superAdmin = await seedUser({
    email: 'super@test.local',
    role: 'super_admin',
  });
  const member = await seedUser({ email: 'member@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB, superAdmin, member };
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

// ============ adminSetMemberRole =====================================

describe('adminSetMemberRole', () => {
  it('promotes member to admin', async () => {
    const s = await setup();
    await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceA,
      'member',
    );
    const m = await adminSetMemberRole(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
      s.member,
      'admin',
    );
    expect(m.role).toBe('admin');
  });

  it('promotes to owner (super-admin can transfer)', async () => {
    const s = await setup();
    await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceA,
      'member',
    );
    const m = await adminSetMemberRole(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
      s.member,
      'owner',
    );
    expect(m.role).toBe('owner');
  });

  it('refuses to demote the last owner', async () => {
    const s = await setup();
    await expect(
      adminSetMemberRole(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.workspaceA,
        s.ownerA,
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses non-super-admin', async () => {
    const s = await setup();
    await expect(
      adminSetMemberRole(
        ctx(s.workspaceA, s.ownerA),
        s.workspaceA,
        s.ownerA,
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects unknown member', async () => {
    const s = await setup();
    await expect(
      adminSetMemberRole(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.workspaceA,
        s.member,
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ============ moveUserBetweenWorkspaces ==============================

describe('moveUserBetweenWorkspaces', () => {
  it('removes from source + adds to destination atomically', async () => {
    const s = await setup();
    await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceA,
      'member',
    );
    await moveUserBetweenWorkspaces(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceA,
      s.workspaceB,
      'admin',
    );
    const inA = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, s.member),
          eq(workspaceMembers.workspaceId, s.workspaceA),
        ),
      );
    const inB = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, s.member),
          eq(workspaceMembers.workspaceId, s.workspaceB),
        ),
      );
    expect(inA).toHaveLength(0);
    expect(inB).toHaveLength(1);
    expect(inB[0]?.role).toBe('admin');
  });

  it('refuses moving the last owner out of source', async () => {
    const s = await setup();
    await expect(
      moveUserBetweenWorkspaces(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.ownerA,
        s.workspaceA,
        s.workspaceB,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses if user is already a member of destination', async () => {
    const s = await setup();
    await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceA,
      'member',
    );
    await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceB,
      'member',
    );
    await expect(
      moveUserBetweenWorkspaces(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.member,
        s.workspaceA,
        s.workspaceB,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses identical source + destination', async () => {
    const s = await setup();
    await expect(
      moveUserBetweenWorkspaces(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.ownerA,
        s.workspaceA,
        s.workspaceA,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects non-super-admin', async () => {
    const s = await setup();
    await expect(
      moveUserBetweenWorkspaces(
        ctx(s.workspaceA, s.ownerA),
        s.member,
        s.workspaceA,
        s.workspaceB,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
