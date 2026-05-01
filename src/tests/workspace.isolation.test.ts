// Workspace isolation test suite.
//
// The most important test in the codebase. Asserts that:
//   1. tenant-owned reads only return rows from the requested workspace
//   2. tenant-owned writes never affect other workspaces
//   3. role-based authorization gates are enforced
//   4. last-owner protection is enforced
//
// Three workspaces (A, B, C), users seeded with explicit roles. Each test
// truncates all tables and re-seeds via `setupRoleMatrix()`.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type WorkspaceContext,
  WorkspaceContextError,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  WorkspaceServiceError,
  addMember,
  createWorkspace,
  getWorkspace,
  listMembers,
  removeMember,
  setMemberRole,
} from '@/lib/services/workspace';
import { listAuditEvents, recordAuditEvent } from '@/lib/services/audit';
import { recordUsage, summarizeUsage } from '@/lib/services/usage';
import { db } from '@/lib/db/client';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface RoleMatrix {
  workspaceA: bigint;
  workspaceB: bigint;
  workspaceC: bigint;
  // Users in workspace A
  ownerA: string;
  adminA: string;
  managerA: string;
  memberA: string;
  viewerA: string;
  // Users in workspace B
  ownerB: string;
  adminB: string;
  // User in workspace C (sole user — for last-owner tests)
  ownerC: string;
  // Outsider — no membership in any workspace
  outsider: string;
  // Platform super admin
  superAdmin: string;
}

async function setupRoleMatrix(): Promise<RoleMatrix> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const adminA = await seedUser({ email: 'adminA@test.local' });
  const managerA = await seedUser({ email: 'managerA@test.local' });
  const memberA = await seedUser({ email: 'memberA@test.local' });
  const viewerA = await seedUser({ email: 'viewerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const adminB = await seedUser({ email: 'adminB@test.local' });
  const ownerC = await seedUser({ email: 'ownerC@test.local' });
  const outsider = await seedUser({ email: 'outsider@test.local' });
  const superAdmin = await seedUser({ email: 'super@test.local', role: 'super_admin' });

  const workspaceA = await seedWorkspace({
    name: 'Workspace A',
    ownerUserId: ownerA,
    extraMembers: [
      { userId: adminA, role: 'admin' },
      { userId: managerA, role: 'manager' },
      { userId: memberA, role: 'member' },
      { userId: viewerA, role: 'viewer' },
    ],
  });
  const workspaceB = await seedWorkspace({
    name: 'Workspace B',
    ownerUserId: ownerB,
    extraMembers: [{ userId: adminB, role: 'admin' }],
  });
  const workspaceC = await seedWorkspace({
    name: 'Workspace C',
    ownerUserId: ownerC,
  });

  return {
    workspaceA,
    workspaceB,
    workspaceC,
    ownerA,
    adminA,
    managerA,
    memberA,
    viewerA,
    ownerB,
    adminB,
    ownerC,
    outsider,
    superAdmin,
  };
}

function ctx(workspaceId: bigint, userId: string, role: WorkspaceContext['role']): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  // Drizzle's postgres-js client holds a pool; close it so vitest exits cleanly.
  await (
    db.$client as unknown as { end: () => Promise<void> }
  ).end();
});

// ---------- read isolation -----------------------------------------------

describe('read isolation', () => {
  it('getWorkspace returns only the requested workspace', async () => {
    const m = await setupRoleMatrix();
    const wsA = await getWorkspace(ctx(m.workspaceA, m.ownerA, 'owner'));
    const wsB = await getWorkspace(ctx(m.workspaceB, m.ownerB, 'owner'));
    expect(wsA.id).toBe(m.workspaceA);
    expect(wsA.name).toBe('Workspace A');
    expect(wsB.id).toBe(m.workspaceB);
    expect(wsB.name).toBe('Workspace B');
    expect(wsA.id).not.toBe(wsB.id);
  });

  it('getWorkspace returns not_found for nonexistent workspace', async () => {
    const m = await setupRoleMatrix();
    await expect(
      getWorkspace(ctx(99999n, m.ownerA, 'owner')),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('listMembers returns only members of the requested workspace', async () => {
    const m = await setupRoleMatrix();
    const aMembers = await listMembers(ctx(m.workspaceA, m.ownerA, 'owner'));
    const bMembers = await listMembers(ctx(m.workspaceB, m.ownerB, 'owner'));
    const cMembers = await listMembers(ctx(m.workspaceC, m.ownerC, 'owner'));
    expect(aMembers.map((r) => r.user.email).sort()).toEqual(
      [
        'adminA@test.local',
        'managerA@test.local',
        'memberA@test.local',
        'ownerA@test.local',
        'viewerA@test.local',
      ].sort(),
    );
    expect(bMembers.map((r) => r.user.email).sort()).toEqual(
      ['adminB@test.local', 'ownerB@test.local'].sort(),
    );
    expect(cMembers.map((r) => r.user.email)).toEqual(['ownerC@test.local']);
  });

  it('listAuditEvents only sees the requested workspace events', async () => {
    const m = await setupRoleMatrix();
    await recordAuditEvent(
      { workspaceId: m.workspaceA, userId: m.ownerA },
      { kind: 'test.event', payload: { which: 'A' } },
    );
    await recordAuditEvent(
      { workspaceId: m.workspaceB, userId: m.ownerB },
      { kind: 'test.event', payload: { which: 'B' } },
    );
    const aEvents = await listAuditEvents(ctx(m.workspaceA, m.ownerA, 'owner'));
    const bEvents = await listAuditEvents(ctx(m.workspaceB, m.ownerB, 'owner'));
    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(1);
    expect(aEvents[0]?.workspaceId).toBe(m.workspaceA);
    expect(bEvents[0]?.workspaceId).toBe(m.workspaceB);
    expect((aEvents[0]?.payload as { which: string }).which).toBe('A');
    expect((bEvents[0]?.payload as { which: string }).which).toBe('B');
  });

  it('listAuditEvents respects kind filter', async () => {
    const m = await setupRoleMatrix();
    const at = { workspaceId: m.workspaceA, userId: m.ownerA };
    await recordAuditEvent(at, { kind: 'a.create' });
    await recordAuditEvent(at, { kind: 'a.update' });
    await recordAuditEvent(at, { kind: 'b.create' });
    const created = await listAuditEvents(ctx(m.workspaceA, m.ownerA, 'owner'), {
      kind: ['a.create', 'b.create'],
    });
    expect(created.map((e) => e.kind).sort()).toEqual(['a.create', 'b.create']);
  });

  it('summarizeUsage only sums the requested workspace', async () => {
    const m = await setupRoleMatrix();
    await recordUsage(
      { workspaceId: m.workspaceA },
      { kind: 'ai.generate_text', provider: 'mock', units: 100, costEstimateCents: 5 },
    );
    await recordUsage(
      { workspaceId: m.workspaceA },
      { kind: 'ai.generate_text', provider: 'mock', units: 200, costEstimateCents: 10 },
    );
    await recordUsage(
      { workspaceId: m.workspaceB },
      { kind: 'ai.generate_text', provider: 'mock', units: 999, costEstimateCents: 99 },
    );
    const aSummary = await summarizeUsage({ workspaceId: m.workspaceA });
    expect(aSummary).toHaveLength(1);
    expect(aSummary[0]?.totalUnits).toBe(300n);
    expect(aSummary[0]?.totalCostCents).toBe(15);
    expect(aSummary[0]?.eventCount).toBe(2);

    const bSummary = await summarizeUsage({ workspaceId: m.workspaceB });
    expect(bSummary).toHaveLength(1);
    expect(bSummary[0]?.totalUnits).toBe(999n);
  });
});

// ---------- write isolation ----------------------------------------------

describe('write isolation', () => {
  it('createWorkspace creates exactly one workspace + one owner member + settings', async () => {
    const owner = await seedUser({ email: 'fresh@test.local' });
    const { workspace, member } = await createWorkspace({
      name: 'Fresh',
      slug: 'fresh-1',
      ownerUserId: owner,
    });
    expect(workspace.name).toBe('Fresh');
    expect(workspace.ownerUserId).toBe(owner);
    expect(member.role).toBe('owner');
    const members = await listMembers(ctx(workspace.id, owner, 'owner'));
    expect(members).toHaveLength(1);
    expect(members[0]?.user.email).toBe('fresh@test.local');
  });

  it('addMember in workspace A does not show up in workspace B', async () => {
    const m = await setupRoleMatrix();
    await addMember(ctx(m.workspaceA, m.ownerA, 'owner'), {
      userId: m.outsider,
      role: 'member',
    });
    const aMembers = await listMembers(ctx(m.workspaceA, m.ownerA, 'owner'));
    const bMembers = await listMembers(ctx(m.workspaceB, m.ownerB, 'owner'));
    expect(aMembers.map((r) => r.user.email)).toContain('outsider@test.local');
    expect(bMembers.map((r) => r.user.email)).not.toContain('outsider@test.local');
  });

  it('removeMember in workspace A only removes the WS-A row', async () => {
    const m = await setupRoleMatrix();
    // First, also add managerA to workspace B as a member.
    await addMember(ctx(m.workspaceB, m.ownerB, 'owner'), {
      userId: m.managerA,
      role: 'member',
    });

    // Now remove managerA from workspace A only.
    await removeMember(ctx(m.workspaceA, m.ownerA, 'owner'), m.managerA);

    const aEmails = (await listMembers(ctx(m.workspaceA, m.ownerA, 'owner'))).map((r) => r.user.email);
    const bEmails = (await listMembers(ctx(m.workspaceB, m.ownerB, 'owner'))).map((r) => r.user.email);
    expect(aEmails).not.toContain('managerA@test.local');
    expect(bEmails).toContain('managerA@test.local');
  });

  it('setMemberRole only changes the row in the targeted workspace', async () => {
    const m = await setupRoleMatrix();
    await addMember(ctx(m.workspaceB, m.ownerB, 'owner'), {
      userId: m.managerA,
      role: 'member',
    });

    await setMemberRole(ctx(m.workspaceA, m.ownerA, 'owner'), m.managerA, 'admin');

    const aMembers = await listMembers(ctx(m.workspaceA, m.ownerA, 'owner'));
    const bMembers = await listMembers(ctx(m.workspaceB, m.ownerB, 'owner'));
    expect(aMembers.find((r) => r.user.email === 'managerA@test.local')?.member.role).toBe('admin');
    expect(bMembers.find((r) => r.user.email === 'managerA@test.local')?.member.role).toBe('member');
  });
});

// ---------- role-based authorization ------------------------------------

describe('role-based authorization', () => {
  it('viewer cannot add members', async () => {
    const m = await setupRoleMatrix();
    await expect(
      addMember(ctx(m.workspaceA, m.viewerA, 'viewer'), {
        userId: m.outsider,
        role: 'member',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('member cannot add members', async () => {
    const m = await setupRoleMatrix();
    await expect(
      addMember(ctx(m.workspaceA, m.memberA, 'member'), {
        userId: m.outsider,
        role: 'member',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('manager cannot add members', async () => {
    const m = await setupRoleMatrix();
    await expect(
      addMember(ctx(m.workspaceA, m.managerA, 'manager'), {
        userId: m.outsider,
        role: 'member',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('admin can add members', async () => {
    const m = await setupRoleMatrix();
    await addMember(ctx(m.workspaceA, m.adminA, 'admin'), {
      userId: m.outsider,
      role: 'member',
    });
    const members = await listMembers(ctx(m.workspaceA, m.ownerA, 'owner'));
    expect(members.map((r) => r.user.email)).toContain('outsider@test.local');
  });

  it('owner can add members', async () => {
    const m = await setupRoleMatrix();
    await addMember(ctx(m.workspaceA, m.ownerA, 'owner'), {
      userId: m.outsider,
      role: 'manager',
    });
    const members = await listMembers(ctx(m.workspaceA, m.ownerA, 'owner'));
    const added = members.find((r) => r.user.email === 'outsider@test.local');
    expect(added?.member.role).toBe('manager');
  });

  it('addMember rejects role=owner via this path', async () => {
    const m = await setupRoleMatrix();
    await expect(
      addMember(ctx(m.workspaceA, m.ownerA, 'owner'), {
        userId: m.outsider,
        role: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('viewer cannot remove members', async () => {
    const m = await setupRoleMatrix();
    await expect(
      removeMember(ctx(m.workspaceA, m.viewerA, 'viewer'), m.memberA),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('admin can remove a non-owner member', async () => {
    const m = await setupRoleMatrix();
    await removeMember(ctx(m.workspaceA, m.adminA, 'admin'), m.memberA);
    const members = await listMembers(ctx(m.workspaceA, m.ownerA, 'owner'));
    expect(members.map((r) => r.user.email)).not.toContain('memberA@test.local');
  });

  it('admin cannot remove the owner', async () => {
    const m = await setupRoleMatrix();
    await expect(
      removeMember(ctx(m.workspaceA, m.adminA, 'admin'), m.ownerA),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('viewer cannot setMemberRole', async () => {
    const m = await setupRoleMatrix();
    await expect(
      setMemberRole(ctx(m.workspaceA, m.viewerA, 'viewer'), m.memberA, 'manager'),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('admin cannot promote to owner (only owner/super_admin can transfer)', async () => {
    const m = await setupRoleMatrix();
    await expect(
      setMemberRole(ctx(m.workspaceA, m.adminA, 'admin'), m.adminA, 'owner'),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('owner can promote another member to owner', async () => {
    const m = await setupRoleMatrix();
    await setMemberRole(ctx(m.workspaceA, m.ownerA, 'owner'), m.adminA, 'owner');
    const members = await listMembers(ctx(m.workspaceA, m.ownerA, 'owner'));
    const owners = members.filter((r) => r.member.role === 'owner');
    expect(owners).toHaveLength(2);
  });

  it('super_admin can promote to owner across workspaces', async () => {
    const m = await setupRoleMatrix();
    // super_admin acting in WS B promotes ownerB's admin to owner
    await setMemberRole(ctx(m.workspaceB, m.superAdmin, 'super_admin'), m.adminB, 'owner');
    const members = await listMembers(ctx(m.workspaceB, m.ownerB, 'owner'));
    const owners = members.filter((r) => r.member.role === 'owner');
    expect(owners).toHaveLength(2);
  });
});

// ---------- last-owner protection ---------------------------------------

describe('last-owner protection', () => {
  it('cannot remove the only owner of a workspace', async () => {
    const m = await setupRoleMatrix();
    await expect(
      removeMember(ctx(m.workspaceC, m.ownerC, 'owner'), m.ownerC),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('cannot demote the only owner of a workspace', async () => {
    const m = await setupRoleMatrix();
    await expect(
      setMemberRole(ctx(m.workspaceC, m.ownerC, 'owner'), m.ownerC, 'admin'),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('can demote an owner when another owner exists', async () => {
    const m = await setupRoleMatrix();
    await setMemberRole(ctx(m.workspaceA, m.ownerA, 'owner'), m.adminA, 'owner');
    // Now there are two owners. Demoting one must succeed.
    await setMemberRole(ctx(m.workspaceA, m.ownerA, 'owner'), m.adminA, 'admin');
    const members = await listMembers(ctx(m.workspaceA, m.ownerA, 'owner'));
    expect(members.filter((r) => r.member.role === 'owner')).toHaveLength(1);
  });
});

// ---------- WorkspaceContext invariants ---------------------------------

describe('WorkspaceContext invariants', () => {
  it('rejects missing workspaceId at the boundary', () => {
    expect(() =>
      makeWorkspaceContext({ workspaceId: undefined, userId: 'u', role: 'owner' }),
    ).toThrow(WorkspaceContextError);
  });

  it('all service-layer errors are WorkspaceServiceError instances', async () => {
    const m = await setupRoleMatrix();
    try {
      await addMember(ctx(m.workspaceA, m.viewerA, 'viewer'), {
        userId: m.outsider,
        role: 'member',
      });
      expect.unreachable('addMember should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceServiceError);
    }
  });
});
