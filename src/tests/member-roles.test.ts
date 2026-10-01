// Who may grant, change or remove the 'owner' role (audit I043,
// deliverable ia:F-04).
//
// /settings/members used the users.ts member service, which only checked
// canAdminWorkspace. A workspace admin could therefore add anyone as
// owner, promote a member (or, by hand-crafting a POST, themselves) to
// owner, and demote or remove the real owners as long as one remained.
// workspace.ts carried a second, slightly stricter copy that nothing but
// tests called. Now:
//   - users.ts is the only implementation (workspace.ts lost its copy);
//   - granting 'owner', or re-roling / removing an owner, needs an owner
//     or a super-admin;
//   - nobody changes their own role;
//   - the last owner can be neither demoted nor removed, even when two
//     changes race;
//   - every change writes one audit row, refused ones write none;
//   - the page offers 'owner' only to owners, and the form actions parse
//     their input before reaching the service.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { recordAuditEvent } from '@/lib/services/audit';
import { workspaceMembers, type WorkspaceMemberRole } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  type WorkspaceRole,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  UserServiceError,
  addMember,
  assignableMemberRoles,
  canManageMemberWithRole,
  removeMember,
  setMemberRole,
} from '@/lib/services/users';
import {
  addMemberAction,
  changeMemberRoleAction,
  removeMemberAction,
} from '@/app/settings/members/actions';
import MembersPage from '@/app/settings/members/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect, renderToHtml } from './helpers/next-render';

// Sign in through a plain session object instead of Auth.js;
// getWorkspaceContext() stays real, so role + workspace resolution is
// the production path.
const session = vi.hoisted(() => ({
  current: null as null | {
    user: { id: string; role: 'member' | 'super_admin'; accountStatus: 'active' };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

const ROLES: readonly WorkspaceMemberRole[] = ['owner', 'admin', 'manager', 'member', 'viewer'];

interface Fixture {
  workspaceId: bigint;
  owner: string;
  owner2: string;
  admin: string;
  admin2: string;
  manager: string;
  member: string;
  viewer: string;
  outsider: string;
  superAdmin: string;
}

/** One workspace with two owners, so the last-owner guard stays out of the way. */
async function setup(): Promise<Fixture> {
  const owner = await seedUser({ email: 'owner@test.local' });
  const owner2 = await seedUser({ email: 'owner2@test.local' });
  const admin = await seedUser({ email: 'admin@test.local' });
  const admin2 = await seedUser({ email: 'admin2@test.local' });
  const manager = await seedUser({ email: 'manager@test.local' });
  const member = await seedUser({ email: 'member@test.local' });
  const viewer = await seedUser({ email: 'viewer@test.local' });
  const outsider = await seedUser({ email: 'outsider@test.local' });
  const superAdmin = await seedUser({ email: 'root@test.local', role: 'super_admin' });
  const workspaceId = await seedWorkspace({
    name: 'Members',
    ownerUserId: owner,
    extraMembers: [
      { userId: owner2, role: 'owner' },
      { userId: admin, role: 'admin' },
      { userId: admin2, role: 'admin' },
      { userId: manager, role: 'manager' },
      { userId: member, role: 'member' },
      { userId: viewer, role: 'viewer' },
      // A super-admin's context role is super_admin whatever the row says.
      { userId: superAdmin, role: 'member' },
    ],
  });
  return {
    workspaceId,
    owner,
    owner2,
    admin,
    admin2,
    manager,
    member,
    viewer,
    outsider,
    superAdmin,
  };
}

function ctx(f: Fixture, userId: string, role: WorkspaceRole): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId: f.workspaceId, userId, role });
}

async function roleOf(f: Fixture, userId: string): Promise<WorkspaceMemberRole | null> {
  const rows = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, f.workspaceId), eq(workspaceMembers.userId, userId)),
    );
  return rows[0]?.role ?? null;
}

async function ownerIds(f: Fixture): Promise<string[]> {
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, f.workspaceId), eq(workspaceMembers.role, 'owner')),
    );
  return rows.map((r) => r.userId).sort();
}

async function memberAudit(f: Fixture) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.workspaceId, f.workspaceId))
    .orderBy(asc(auditLog.id));
  return rows
    .filter((r) => r.kind.startsWith('user.') && r.kind.includes('member'))
    .map((r) => ({ kind: r.kind, userId: r.userId, payload: r.payload }));
}

function signInAs(userId: string, platformRole: 'member' | 'super_admin' = 'member'): void {
  session.current = { user: { id: userId, role: platformRole, accountStatus: 'active' } };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function parseTarget(target: string): { path: string; query: Record<string, string> } {
  const url = new URL(target, 'http://app.test');
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

async function renderMembers(): Promise<string> {
  const tree = await MembersPage({ searchParams: Promise.resolve({}) });
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

/** The role options rendered inside the role <select>s. */
function optionValues(html: string): string[] {
  return [...html.matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1]!);
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---------------------------------------------------------------------------

describe('admin cannot touch the owner role', () => {
  it('add-as-owner is permission_denied and adds nobody', async () => {
    const f = await setup();
    await expect(addMember(ctx(f, f.admin, 'admin'), f.outsider, 'owner')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(await roleOf(f, f.outsider)).toBeNull();
  });

  it('promote-to-owner is permission_denied, for another member and for themselves', async () => {
    const f = await setup();
    await expect(setMemberRole(ctx(f, f.admin, 'admin'), f.member, 'owner')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(setMemberRole(ctx(f, f.admin, 'admin'), f.admin, 'owner')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(await roleOf(f, f.member)).toBe('member');
    expect(await roleOf(f, f.admin)).toBe('admin');
  });

  it('demote-owner is permission_denied for every lower role, even with two owners', async () => {
    const f = await setup();
    for (const role of ROLES.filter((r) => r !== 'owner')) {
      await expect(setMemberRole(ctx(f, f.admin, 'admin'), f.owner2, role)).rejects.toMatchObject({
        code: 'permission_denied',
      });
    }
    expect(await ownerIds(f)).toEqual([f.owner, f.owner2].sort());
  });

  it('remove-owner is permission_denied, even with two owners', async () => {
    const f = await setup();
    await expect(removeMember(ctx(f, f.admin, 'admin'), f.owner2)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(await ownerIds(f)).toEqual([f.owner, f.owner2].sort());
  });

  it('refused attempts write no audit rows', async () => {
    const f = await setup();
    const admin = ctx(f, f.admin, 'admin');
    await addMember(admin, f.outsider, 'owner').catch(() => undefined);
    await setMemberRole(admin, f.member, 'owner').catch(() => undefined);
    await setMemberRole(admin, f.owner2, 'admin').catch(() => undefined);
    await removeMember(admin, f.owner2).catch(() => undefined);
    expect(await memberAudit(f)).toEqual([]);
  });

  it('admin still manages every non-owner member', async () => {
    const f = await setup();
    const admin = ctx(f, f.admin, 'admin');
    await addMember(admin, f.outsider, 'admin');
    await setMemberRole(admin, f.admin2, 'viewer');
    await setMemberRole(admin, f.viewer, 'manager');
    await removeMember(admin, f.member);
    expect(await roleOf(f, f.outsider)).toBe('admin');
    expect(await roleOf(f, f.admin2)).toBe('viewer');
    expect(await roleOf(f, f.viewer)).toBe('manager');
    expect(await roleOf(f, f.member)).toBeNull();
  });

  it('managers, members and viewers cannot change membership at all', async () => {
    const f = await setup();
    for (const [userId, role] of [
      [f.manager, 'manager'],
      [f.member, 'member'],
      [f.viewer, 'viewer'],
    ] as const) {
      const c = ctx(f, userId, role);
      await expect(addMember(c, f.outsider, 'member')).rejects.toMatchObject({
        code: 'permission_denied',
      });
      await expect(setMemberRole(c, f.admin2, 'member')).rejects.toMatchObject({
        code: 'permission_denied',
      });
      await expect(removeMember(c, f.admin2)).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });
});

describe('owners and super-admins manage owners', () => {
  it('an owner can add-as-owner, promote, demote and remove an owner; each writes an audit row', async () => {
    const f = await setup();
    const owner = ctx(f, f.owner, 'owner');

    await addMember(owner, f.outsider, 'owner');
    await setMemberRole(owner, f.admin, 'owner');
    await setMemberRole(owner, f.owner2, 'manager');
    await removeMember(owner, f.outsider);

    expect(await roleOf(f, f.outsider)).toBeNull();
    expect(await roleOf(f, f.owner2)).toBe('manager');
    expect(await ownerIds(f)).toEqual([f.owner, f.admin].sort());
    expect(await memberAudit(f)).toEqual([
      {
        kind: 'user.add_member',
        userId: f.owner,
        payload: { targetUserId: f.outsider, role: 'owner' },
      },
      {
        kind: 'user.set_member_role',
        userId: f.owner,
        payload: { targetUserId: f.admin, role: 'owner', prior: 'admin' },
      },
      {
        kind: 'user.set_member_role',
        userId: f.owner,
        payload: { targetUserId: f.owner2, role: 'manager', prior: 'owner' },
      },
      {
        kind: 'user.remove_member',
        userId: f.owner,
        payload: { targetUserId: f.outsider, role: 'owner' },
      },
    ]);
  });

  it('a super-admin can do the same in a workspace they act on', async () => {
    const f = await setup();
    const god = ctx(f, f.superAdmin, 'super_admin');
    await setMemberRole(god, f.member, 'owner');
    await setMemberRole(god, f.owner2, 'admin');
    await removeMember(god, f.member);
    expect(await ownerIds(f)).toEqual([f.owner]);
  });

  it('re-setting the role a member already has changes nothing and audits nothing', async () => {
    const f = await setup();
    const updated = await setMemberRole(ctx(f, f.owner, 'owner'), f.owner2, 'owner');
    expect(updated.role).toBe('owner');
    expect(await memberAudit(f)).toEqual([]);
  });
});

describe('audit rows commit together with the member change', () => {
  it('add, re-role and remove write their audit row on the change transaction, not the pool', async () => {
    const f = await setup();
    const owner = ctx(f, f.owner, 'owner');
    // Every write of a member change goes through its transaction; a
    // db.insert here would be the audit row on a second connection.
    const poolInsert = vi.spyOn(db, 'insert');
    try {
      await addMember(owner, f.outsider, 'member');
      await setMemberRole(owner, f.outsider, 'manager');
      await removeMember(owner, f.outsider);
      expect(poolInsert).not.toHaveBeenCalled();
    } finally {
      poolInsert.mockRestore();
    }
    expect((await memberAudit(f)).map((r) => r.kind)).toEqual([
      'user.add_member',
      'user.set_member_role',
      'user.remove_member',
    ]);
  });

  it('an audit row written on a transaction that rolls back is gone with it', async () => {
    const f = await setup();
    await expect(
      db.transaction(async (tx) => {
        await recordAuditEvent(
          ctx(f, f.owner, 'owner'),
          { kind: 'user.add_member', entityType: 'workspace_member', entityId: 1 },
          tx,
        );
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await memberAudit(f)).toEqual([]);
  });
});

describe('last-owner guard', () => {
  it('the sole owner cannot be demoted or removed, even by a super-admin', async () => {
    const f = await setup();
    await setMemberRole(ctx(f, f.owner, 'owner'), f.owner2, 'admin');
    const god = ctx(f, f.superAdmin, 'super_admin');

    await expect(setMemberRole(god, f.owner, 'admin')).rejects.toMatchObject({
      code: 'conflict',
      message: 'cannot demote the last owner',
    });
    await expect(removeMember(god, f.owner)).rejects.toMatchObject({
      code: 'conflict',
      message: 'cannot remove the last owner',
    });
    expect(await ownerIds(f)).toEqual([f.owner]);
  });

  it('an owner may leave while another owner remains, but not as the last one', async () => {
    const f = await setup();
    await removeMember(ctx(f, f.owner2, 'owner'), f.owner2);
    expect(await ownerIds(f)).toEqual([f.owner]);

    await expect(removeMember(ctx(f, f.owner, 'owner'), f.owner)).rejects.toMatchObject({
      code: 'conflict',
      message: 'cannot remove the last owner',
    });
    expect(await ownerIds(f)).toEqual([f.owner]);
  });

  it('two concurrent removals of the two owners leave exactly one', async () => {
    const f = await setup();
    const god = ctx(f, f.superAdmin, 'super_admin');

    const results = await Promise.allSettled([
      removeMember(god, f.owner),
      removeMember(god, f.owner2),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'conflict' });
    expect(await ownerIds(f)).toHaveLength(1);
  });

  it('two concurrent demotions of the two owners leave exactly one', async () => {
    const f = await setup();
    const god = ctx(f, f.superAdmin, 'super_admin');

    const results = await Promise.allSettled([
      setMemberRole(god, f.owner, 'admin'),
      setMemberRole(god, f.owner2, 'admin'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await ownerIds(f)).toHaveLength(1);
  });
});

describe('self role changes', () => {
  // Every actor, every target role: refused, and the row is unchanged.
  // Non-admins are refused by the admin gate, an admin asking for
  // 'owner' by the owner gate, everyone else by the self check.
  const ACTORS: ReadonlyArray<{
    key: Exclude<keyof Fixture, 'workspaceId'>;
    role: WorkspaceRole;
  }> = [
    { key: 'owner', role: 'owner' },
    { key: 'admin', role: 'admin' },
    { key: 'manager', role: 'manager' },
    { key: 'member', role: 'member' },
    { key: 'viewer', role: 'viewer' },
    { key: 'superAdmin', role: 'super_admin' },
  ];

  for (const actor of ACTORS) {
    it(`role ${actor.role}: cannot change their own role to any role`, async () => {
      const f = await setup();
      const userId = f[actor.key];
      const before = await roleOf(f, userId);
      const c = ctx(f, userId, actor.role);

      for (const target of ROLES) {
        const err = await setMemberRole(c, userId, target).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, `${actor.role} -> ${target}`).toBeInstanceOf(UserServiceError);
        const expected =
          !['owner', 'admin', 'super_admin'].includes(actor.role) ||
          (actor.role === 'admin' && target === 'owner')
            ? 'permission_denied'
            : 'conflict';
        expect((err as UserServiceError).code, `${actor.role} -> ${target}`).toBe(expected);
      }
      expect(await roleOf(f, userId)).toBe(before);
      expect(await memberAudit(f)).toEqual([]);
    });
  }
});

describe('input validation', () => {
  it('an unknown role is invalid_input, never written', async () => {
    const f = await setup();
    const owner = ctx(f, f.owner, 'owner');
    const bogus = 'super_admin' as unknown as WorkspaceMemberRole;
    await expect(setMemberRole(owner, f.member, bogus)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(addMember(owner, f.outsider, bogus)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(await roleOf(f, f.member)).toBe('member');
    expect(await roleOf(f, f.outsider)).toBeNull();
  });
});

describe('role helpers', () => {
  it('assignableMemberRoles offers owner only to owners and super-admins', async () => {
    const f = await setup();
    expect(assignableMemberRoles(ctx(f, f.owner, 'owner'))).toEqual([...ROLES]);
    expect(assignableMemberRoles(ctx(f, f.superAdmin, 'super_admin'))).toEqual([...ROLES]);
    expect(assignableMemberRoles(ctx(f, f.admin, 'admin'))).toEqual([
      'admin',
      'manager',
      'member',
      'viewer',
    ]);
    expect(assignableMemberRoles(ctx(f, f.manager, 'manager'))).toEqual([]);
  });

  it('canManageMemberWithRole keeps owner rows to owners', async () => {
    const f = await setup();
    expect(canManageMemberWithRole(ctx(f, f.admin, 'admin'), 'owner')).toBe(false);
    expect(canManageMemberWithRole(ctx(f, f.admin, 'admin'), 'admin')).toBe(true);
    expect(canManageMemberWithRole(ctx(f, f.owner, 'owner'), 'owner')).toBe(true);
    expect(canManageMemberWithRole(ctx(f, f.manager, 'manager'), 'viewer')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('/settings/members page', () => {
  it('an admin is never offered owner, and gets no controls on owner rows', async () => {
    const f = await setup();
    signInAs(f.admin);

    const html = await renderMembers();

    expect(html).toContain('Workspace members');
    expect(optionValues(html)).not.toContain('owner');
    expect(new Set(optionValues(html))).toEqual(new Set(['admin', 'manager', 'member', 'viewer']));
    expect(html).toContain('Only a workspace owner can grant the owner role.');
    expect(html).toContain('Only an owner can change or remove an owner.');
    // No role or remove form carries an owner's id.
    expect(html).not.toContain(`value="${f.owner}"`);
    expect(html).not.toContain(`value="${f.owner2}"`);
    // Non-owner rows keep their controls.
    expect(html).toContain(`value="${f.member}"`);
  });

  it('an owner is offered owner and controls on the other owner', async () => {
    const f = await setup();
    signInAs(f.owner);

    const html = await renderMembers();

    expect(optionValues(html)).toContain('owner');
    expect(html).not.toContain('Only a workspace owner can grant the owner role.');
    expect(html).toContain(`value="${f.owner2}"`);
    // Their own row stays control-free.
    expect(html).not.toContain(`value="${f.owner}"`);
    expect(html).toContain('this is you');
  });

  it('a manager sees no member management', async () => {
    const f = await setup();
    signInAs(f.manager);

    const html = await renderMembers();

    expect(html).toContain('Workspace admin access required.');
    expect(optionValues(html)).toEqual([]);
  });
});

describe('/settings/members actions', () => {
  it('an admin posting role=owner gets the error back and nothing changes', async () => {
    const f = await setup();
    signInAs(f.admin);

    const add = parseTarget(
      await expectRedirect(() => addMemberAction(form({ userId: f.outsider, role: 'owner' }))),
    );
    const promote = parseTarget(
      await expectRedirect(() => changeMemberRoleAction(form({ userId: f.member, role: 'owner' }))),
    );
    const demote = parseTarget(
      await expectRedirect(() => changeMemberRoleAction(form({ userId: f.owner, role: 'admin' }))),
    );
    const remove = parseTarget(
      await expectRedirect(() => removeMemberAction(form({ userId: f.owner2 }))),
    );

    for (const t of [add, promote, demote, remove]) {
      expect(t.path).toBe('/settings/members');
      expect(t.query.error).toMatch(/only a workspace owner/);
    }
    expect(await roleOf(f, f.outsider)).toBeNull();
    expect(await roleOf(f, f.member)).toBe('member');
    expect(await ownerIds(f)).toEqual([f.owner, f.owner2].sort());
  });

  it('an owner can promote through the action', async () => {
    const f = await setup();
    signInAs(f.owner);

    const t = parseTarget(
      await expectRedirect(() => changeMemberRoleAction(form({ userId: f.member, role: 'owner' }))),
    );

    expect(t).toEqual({ path: '/settings/members', query: { message: 'Role updated' } });
    expect(await roleOf(f, f.member)).toBe('owner');
  });

  it('a self role change through the action is refused', async () => {
    const f = await setup();
    signInAs(f.owner);

    const t = parseTarget(
      await expectRedirect(() => changeMemberRoleAction(form({ userId: f.owner, role: 'viewer' }))),
    );

    expect(t.query.error).toBe('cannot change your own workspace role');
    expect(await roleOf(f, f.owner)).toBe('owner');
  });

  it('rejects a role outside the enum and a missing user id before the service', async () => {
    const f = await setup();
    signInAs(f.owner);

    const badRole = parseTarget(
      await expectRedirect(() =>
        changeMemberRoleAction(form({ userId: f.member, role: 'super_admin' })),
      ),
    );
    const noUser = parseTarget(
      await expectRedirect(() => addMemberAction(form({ userId: '  ', role: 'member' }))),
    );
    const noRole = parseTarget(
      await expectRedirect(() => addMemberAction(form({ userId: f.outsider }))),
    );

    expect(badRole.query.error).toBe('invalid role');
    expect(noUser.query.error).toBe('user id is required');
    expect(noRole.query.error).toBe('invalid role');
    expect(await roleOf(f, f.member)).toBe('member');
    expect(await roleOf(f, f.outsider)).toBeNull();
  });

  it('a successful add and remove report back', async () => {
    const f = await setup();
    signInAs(f.admin);

    const added = parseTarget(
      await expectRedirect(() => addMemberAction(form({ userId: f.outsider, role: 'viewer' }))),
    );
    const removed = parseTarget(
      await expectRedirect(() => removeMemberAction(form({ userId: f.outsider }))),
    );

    expect(added.query).toEqual({ message: 'Member added' });
    expect(removed.query).toEqual({ message: 'Removed' });
    expect(await roleOf(f, f.outsider)).toBeNull();
  });
});
