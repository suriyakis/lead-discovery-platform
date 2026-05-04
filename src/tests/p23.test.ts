import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  adminAddUserToWorkspace,
  adminRemoveUserFromWorkspace,
  archiveWorkspace,
  listAllWorkspaces,
  listMembershipsForUser,
  restoreWorkspace,
  updateUserProfile,
  updateWorkspaceProfile,
} from '@/lib/services/admin';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  superAdmin: string;
  member: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const superAdmin = await seedUser({
    email: 'super@test.local',
    role: 'super_admin',
  });
  const member = await seedUser({ email: 'member@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerA });
  return { workspaceA, workspaceB, ownerA, superAdmin, member };
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

// ============ workspace lifecycle ===================================

describe('archiveWorkspace', () => {
  it('marks the workspace archived + audit-logs', async () => {
    const s = await setup();
    const ws = await archiveWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
      'sunset',
    );
    expect(ws.status).toBe('archived');
    expect(ws.archivedAt).not.toBeNull();
    expect(ws.archivedBy).toBe(s.superAdmin);
    expect(ws.archivedReason).toBe('sunset');
  });

  it('rejects non-super-admin', async () => {
    const s = await setup();
    await expect(
      archiveWorkspace(ctx(s.workspaceA, s.ownerA), s.workspaceA),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects double-archive', async () => {
    const s = await setup();
    await archiveWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
    );
    await expect(
      archiveWorkspace(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.workspaceA,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('restoreWorkspace', () => {
  it('restores an archived workspace', async () => {
    const s = await setup();
    await archiveWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
    );
    const ws = await restoreWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
    );
    expect(ws.status).toBe('active');
    expect(ws.archivedAt).toBeNull();
  });

  it('rejects restoring an already-active workspace', async () => {
    const s = await setup();
    await expect(
      restoreWorkspace(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.workspaceA,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('listAllWorkspaces', () => {
  it('hides archived by default, shows them with includeArchived', async () => {
    const s = await setup();
    await archiveWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
    );
    const visible = await listAllWorkspaces(ctx(s.workspaceB, s.superAdmin, 'super_admin'));
    expect(visible.find((w) => w.workspaceId === s.workspaceA)).toBeUndefined();
    expect(visible.find((w) => w.workspaceId === s.workspaceB)).toBeDefined();
    const all = await listAllWorkspaces(
      ctx(s.workspaceB, s.superAdmin, 'super_admin'),
      { includeArchived: true },
    );
    expect(all.find((w) => w.workspaceId === s.workspaceA)?.status).toBe('archived');
  });
});

describe('updateWorkspaceProfile', () => {
  it('updates name + slug', async () => {
    const s = await setup();
    const ws = await updateWorkspaceProfile(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
      { name: 'Renamed', slug: 'renamed-ws' },
    );
    expect(ws.name).toBe('Renamed');
    expect(ws.slug).toBe('renamed-ws');
  });

  it('rejects duplicate slug', async () => {
    const s = await setup();
    const ws = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, s.workspaceB))
      .limit(1);
    await expect(
      updateWorkspaceProfile(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.workspaceA,
        { slug: ws[0]!.slug },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects invalid slug format', async () => {
    const s = await setup();
    await expect(
      updateWorkspaceProfile(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.workspaceA,
        { slug: 'Invalid Slug!' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

// ============ user profile + memberships ============================

describe('updateUserProfile', () => {
  it('updates name + email', async () => {
    const s = await setup();
    const u = await updateUserProfile(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      { name: 'New Name', email: 'new@test.local' },
    );
    expect(u.name).toBe('New Name');
    expect(u.email).toBe('new@test.local');
  });

  it('lowercases email', async () => {
    const s = await setup();
    const u = await updateUserProfile(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      { email: 'MixedCASE@example.com' },
    );
    expect(u.email).toBe('mixedcase@example.com');
  });

  it('rejects email collision', async () => {
    const s = await setup();
    await expect(
      updateUserProfile(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.member,
        { email: 'ownerA@test.local' },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects invalid email', async () => {
    const s = await setup();
    await expect(
      updateUserProfile(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.member,
        { email: 'not-an-email' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects non-super-admin', async () => {
    const s = await setup();
    await expect(
      updateUserProfile(ctx(s.workspaceA, s.ownerA), s.member, { name: 'x' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('adminAddUserToWorkspace', () => {
  it('adds a user to a workspace at the given role', async () => {
    const s = await setup();
    const m = await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceB,
      'admin',
    );
    expect(m.workspaceId).toBe(s.workspaceB);
    expect(m.role).toBe('admin');
  });

  it('allows owner role', async () => {
    const s = await setup();
    const m = await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceB,
      'owner',
    );
    expect(m.role).toBe('owner');
  });

  it('refuses duplicate membership', async () => {
    const s = await setup();
    await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceB,
    );
    await expect(
      adminAddUserToWorkspace(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.member,
        s.workspaceB,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses non-super-admin', async () => {
    const s = await setup();
    await expect(
      adminAddUserToWorkspace(
        ctx(s.workspaceA, s.ownerA),
        s.member,
        s.workspaceB,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('adminRemoveUserFromWorkspace', () => {
  it('removes a non-owner member', async () => {
    const s = await setup();
    await adminAddUserToWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceA,
      'member',
    );
    await adminRemoveUserFromWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
      s.workspaceA,
    );
    const left = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, s.member));
    expect(left).toHaveLength(0);
  });

  it('refuses to remove the last owner', async () => {
    const s = await setup();
    await expect(
      adminRemoveUserFromWorkspace(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.ownerA,
        s.workspaceA,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('listMembershipsForUser', () => {
  it('returns every workspace the user belongs to', async () => {
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
      'admin',
    );
    const memberships = await listMembershipsForUser(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
    );
    expect(memberships).toHaveLength(2);
    const byName = new Map(memberships.map((m) => [m.workspace.name, m.role]));
    expect(byName.get('A')).toBe('member');
    expect(byName.get('B')).toBe('admin');
  });
});

// ============ archived workspace bypasses non-admin auth-context ====

describe('archived workspace gating', () => {
  it('archived workspaces still appear for super-admin in users list', async () => {
    const s = await setup();
    await archiveWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.workspaceA,
    );
    // Super-admin still sees the row.
    const all = await listAllWorkspaces(
      ctx(s.workspaceB, s.superAdmin, 'super_admin'),
      { includeArchived: true },
    );
    const archived = all.find((w) => w.workspaceId === s.workspaceA);
    expect(archived).toBeDefined();
    expect(archived?.status).toBe('archived');

    // But on the users table, the row itself is unchanged.
    const stillThere = await db.select().from(users).where(eq(users.id, s.ownerA));
    expect(stillThere).toHaveLength(1);
  });
});
