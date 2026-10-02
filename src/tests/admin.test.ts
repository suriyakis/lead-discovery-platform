import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { featureFlags } from '@/lib/db/schema/admin';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  listAllUsers,
  listAllWorkspaces,
  listFeatureFlags,
  setFeatureFlag,
} from '@/lib/services/admin';
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
      setFeatureFlag(smuggled(owner), {
        workspaceId: s.workspaceA,
        key: 'crm.hubspot',
        enabled: true,
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
      setFeatureFlag(smuggled(godMode), {
        workspaceId: s.workspaceB,
        key: 'crm.hubspot',
        enabled: true,
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

// ============ feature flags =======================================

describe('feature flags', () => {
  it('upserts on (workspace, key)', async () => {
    const s = await setup();
    const god = platformCtx(s.godUser);
    const a = await setFeatureFlag(god, {
      workspaceId: s.workspaceA,
      key: 'crm.hubspot',
      enabled: false,
    });
    const b = await setFeatureFlag(god, {
      workspaceId: s.workspaceA,
      key: 'crm.hubspot',
      enabled: true,
      config: { plan: 'pro' },
    });
    expect(b.id).toBe(a.id);
    expect(b.enabled).toBe(true);
    expect((b.config as { plan?: string }).plan).toBe('pro');
  });

  it('rejects bad key shape', async () => {
    const s = await setup();
    const god = platformCtx(s.godUser);
    await expect(
      setFeatureFlag(god, {
        workspaceId: s.workspaceA,
        key: 'BadKey-WithDash',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('listFeatureFlags scoped to a workspace', async () => {
    const s = await setup();
    const god = platformCtx(s.godUser);
    await setFeatureFlag(god, {
      workspaceId: s.workspaceA,
      key: 'crm.hubspot',
      enabled: true,
    });
    await setFeatureFlag(god, {
      workspaceId: s.workspaceB,
      key: 'rag.openai',
      enabled: true,
    });
    const inA = await listFeatureFlags(god, s.workspaceA);
    expect(inA.map((f) => f.key)).toEqual(['crm.hubspot']);
    const inB = await listFeatureFlags(god, s.workspaceB);
    expect(inB.map((f) => f.key)).toEqual(['rag.openai']);
    void featureFlags;
  });
});
