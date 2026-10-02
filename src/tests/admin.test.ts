import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import { listAllUsers, listAllWorkspaces } from '@/lib/services/admin';
import { placePlatformHold } from '@/lib/services/holds';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { platformCtx, smuggled } from './helpers/platform';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
  godUser: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const godUser = await seedUser({ email: 'god@test.local', role: 'super_admin' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB, godUser };
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

// ============ super_admin gate ====================================

describe('super-admin gating', () => {
  it('rejects non super_admin actors on every admin operation', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    await expect(listAllWorkspaces(smuggled(owner))).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(listAllUsers(smuggled(owner))).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(
      placePlatformHold(smuggled(owner), s.workspaceA, {
        scope: 'capabilities',
        capabilities: ['crm_sync'],
        reason: 'not a platform context',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects a god-mode WorkspaceContext even with role super_admin (I051)', async () => {
    // The old console passed exactly this: a super-admin context pointing
    // at whichever tenant the switcher was on. Platform services must not
    // accept it — they need a PlatformContext, which has no workspace.
    const s = await setup();
    const godMode = ctx(s.workspaceA, s.godUser, 'super_admin');
    await expect(listAllWorkspaces(smuggled(godMode))).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(
      placePlatformHold(smuggled(godMode), s.workspaceB, {
        scope: 'capabilities',
        capabilities: ['crm_sync'],
        reason: 'not a platform context',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

// ============ workspace overview ==================================

describe('listAllWorkspaces', () => {
  it('returns aggregated metrics across the platform', async () => {
    const s = await setup();
    const god = platformCtx(s.godUser);
    const rows = await listAllWorkspaces(god);
    expect(rows.map((r) => r.workspaceId).sort()).toEqual(
      [s.workspaceA, s.workspaceB].sort(),
    );
    for (const r of rows) {
      expect(r.memberCount).toBeGreaterThanOrEqual(1);
    }
  });
});

// ============ impersonation (removed — I047) ======================

describe('impersonation', () => {
  it('the admin service no longer offers the no-op impersonation path', async () => {
    // startImpersonation recorded a session and an audit event but never
    // changed the acting identity. The control and its service path were
    // removed; impersonation_sessions stays in the schema as history.
    const mod = await import('@/lib/services/admin');
    expect(Object.keys(mod).filter((k) => /impersonat/i.test(k))).toEqual([]);
  });
});

// ============ feature flags (replaced by holds — PC-06) ============

describe('feature flags', () => {
  it('the admin service no longer writes or lists the never-read flags (I048)', async () => {
    // Holds replace them (services/holds.ts); the legacy rows are imported
    // as pending_review holds (src/tests/holds-pc06.test.ts).
    const mod = await import('@/lib/services/admin');
    expect(Object.keys(mod).filter((k) => /featureflag/i.test(k))).toEqual([]);
  });
});
