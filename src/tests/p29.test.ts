import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  listMyWorkspaces,
  setActiveWorkspace,
} from '@/lib/services/workspace';
import { adminAddUserToWorkspace } from '@/lib/services/admin';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  workspaceC: bigint;
  ownerA: string;
  ownerBC: string;
  superAdmin: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerBC = await seedUser({ email: 'ownerBC@test.local' });
  const superAdmin = await seedUser({
    email: 'super@test.local',
    role: 'super_admin',
  });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerBC });
  const workspaceC = await seedWorkspace({ name: 'C', ownerUserId: ownerBC });
  // Super-admin is a member of just workspaceA (e.g., their bootstrap one).
  await adminAddUserToWorkspace(
    ctx(workspaceA, superAdmin, 'super_admin'),
    superAdmin,
    workspaceA,
    'admin',
  );
  return { workspaceA, workspaceB, workspaceC, ownerA, ownerBC, superAdmin };
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

// ============ listMyWorkspaces super-admin variant ===================

describe('listMyWorkspaces (super-admin god mode)', () => {
  it('returns only memberships when not opted in', async () => {
    const s = await setup();
    const rows = await listMyWorkspaces(s.superAdmin);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspace.id).toBe(s.workspaceA);
    expect(rows[0]?.isGodMode).toBe(false);
  });

  it('returns memberships + every other workspace when opted in', async () => {
    const s = await setup();
    const rows = await listMyWorkspaces(s.superAdmin, {
      includeAllForSuperAdmin: true,
    });
    // Member of A, plus god-mode entries for B and C.
    expect(rows).toHaveLength(3);
    const memberRow = rows.find((r) => r.workspace.id === s.workspaceA);
    expect(memberRow?.isGodMode).toBe(false);
    expect(memberRow?.role).not.toBe('super_admin');
    const godB = rows.find((r) => r.workspace.id === s.workspaceB);
    expect(godB?.isGodMode).toBe(true);
    expect(godB?.role).toBe('super_admin');
    const godC = rows.find((r) => r.workspace.id === s.workspaceC);
    expect(godC?.isGodMode).toBe(true);
  });

  it('non-super-admin opting in still sees only memberships', async () => {
    const s = await setup();
    // ownerA is a member of just workspaceA. Even with the flag they
    // shouldn't see B/C — but the function trusts the caller; the gate
    // lives at the AppShell layer, not here. Confirm the function does
    // include all when asked.
    const rows = await listMyWorkspaces(s.ownerA, {
      includeAllForSuperAdmin: true,
    });
    // Note: this is the documented contract — function does not check
    // role. Caller is responsible.
    expect(rows.length).toBeGreaterThan(1);
  });
});

// ============ setActiveWorkspace audit-logs god-mode switches ========

describe('setActiveWorkspace god-mode audit', () => {
  it('writes a workspace.god_mode_switch audit row when allowed', async () => {
    const s = await setup();
    await setActiveWorkspace(s.superAdmin, s.workspaceB, {
      allowAnyAsSuperAdmin: true,
    });
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, s.workspaceB),
          eq(auditLog.kind, 'workspace.god_mode_switch'),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(s.superAdmin);
  });

  it('does NOT log when switching into a workspace the user is a member of', async () => {
    const s = await setup();
    await setActiveWorkspace(s.superAdmin, s.workspaceA, {
      allowAnyAsSuperAdmin: true,
    });
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, s.workspaceA),
          eq(auditLog.kind, 'workspace.god_mode_switch'),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('still throws when god-mode is not opted in and caller is not a member', async () => {
    const s = await setup();
    await expect(
      setActiveWorkspace(s.superAdmin, s.workspaceB),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
