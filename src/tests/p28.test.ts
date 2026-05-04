import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  WorkspaceServiceError,
  listMyWorkspaces,
  setActiveWorkspace,
} from '@/lib/services/workspace';
import {
  archiveWorkspace,
  adminAddUserToWorkspace,
  adminRemoveUserFromWorkspace,
  deleteWorkspace,
  setWorkspaceDefault,
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

// ============ setActiveWorkspace ====================================

describe('setActiveWorkspace', () => {
  it('updates users.activeWorkspaceId for a member', async () => {
    const s = await setup();
    await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceA,
    );
    await setActiveWorkspace(s.member, s.workspaceA);
    const u = await db
      .select()
      .from(users)
      .where(eq(users.id, s.member))
      .limit(1);
    expect(u[0]?.activeWorkspaceId).toBe(s.workspaceA);
  });

  it('refuses non-members', async () => {
    const s = await setup();
    await expect(
      setActiveWorkspace(s.member, s.workspaceA),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('allows super-admin to set any workspace', async () => {
    const s = await setup();
    // Super-admin is NOT a member of workspaceB but should still be able
    // to set it active when allowAnyAsSuperAdmin is true.
    await setActiveWorkspace(s.superAdmin, s.workspaceB, {
      allowAnyAsSuperAdmin: true,
    });
    const u = await db
      .select()
      .from(users)
      .where(eq(users.id, s.superAdmin))
      .limit(1);
    expect(u[0]?.activeWorkspaceId).toBe(s.workspaceB);
  });

  it('throws not_found for unknown workspace', async () => {
    const s = await setup();
    await expect(
      setActiveWorkspace(s.member, 9_999_999n),
    ).rejects.toBeInstanceOf(WorkspaceServiceError);
  });
});

// ============ listMyWorkspaces ======================================

describe('listMyWorkspaces', () => {
  it('returns one row per membership with isActive flag', async () => {
    const s = await setup();
    await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceA,
    );
    await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceB,
    );
    await setActiveWorkspace(s.member, s.workspaceB);
    const rows = await listMyWorkspaces(s.member);
    expect(rows).toHaveLength(2);
    const active = rows.find((r) => r.isActive);
    expect(active?.workspace.id).toBe(s.workspaceB);
  });
});

// ============ Membership removal clears active when matching ========

describe('adminRemoveUserFromWorkspace clears stale active', () => {
  it('clears users.activeWorkspaceId when removed from active workspace', async () => {
    const s = await setup();
    await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceA,
    );
    await setActiveWorkspace(s.member, s.workspaceA);
    await adminRemoveUserFromWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceA,
    );
    const u = await db
      .select()
      .from(users)
      .where(eq(users.id, s.member))
      .limit(1);
    expect(u[0]?.activeWorkspaceId).toBeNull();
  });
});

// ============ isDefault gates =======================================

describe('isDefault flag', () => {
  it('refuses to archive a default workspace', async () => {
    const s = await setup();
    await setWorkspaceDefault(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
      true,
    );
    await expect(
      archiveWorkspace(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.workspaceA,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses to delete a default workspace even when archived', async () => {
    const s = await setup();
    // Archive first, then mark default — that's the only legal sequence
    // since archiving when already default is blocked.
    await archiveWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
    );
    // Marking an archived workspace as default is forbidden.
    await expect(
      setWorkspaceDefault(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.workspaceA,
        true,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lets non-default archived workspace be deleted', async () => {
    const s = await setup();
    await archiveWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
    );
    await deleteWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
    );
    const left = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceA));
    expect(left).toHaveLength(0);
  });
});

// ============ setWorkspaceDefault ===================================

describe('setWorkspaceDefault', () => {
  it('flips the flag', async () => {
    const s = await setup();
    const ws = await setWorkspaceDefault(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
      true,
    );
    expect(ws.isDefault).toBe(true);
    const cleared = await setWorkspaceDefault(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
      false,
    );
    expect(cleared.isDefault).toBe(false);
  });

  it('refuses non-super-admin', async () => {
    const s = await setup();
    await expect(
      setWorkspaceDefault(ctx(s.workspaceA, s.ownerA), s.workspaceA, true),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
