import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  featureFlags,
  impersonationSessions,
} from '@/lib/db/schema/admin';
import { workspaceMembers } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  AdminServiceError,
  activeImpersonationFor,
  endImpersonation,
  listAllUsers,
  listAllWorkspaces,
  listFeatureFlags,
  listImpersonationSessions,
  setFeatureFlag,
  startImpersonation,
} from '@/lib/services/admin';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

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
  const godUser = await seedUser({ email: 'god@test.local' });
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
    await expect(listAllWorkspaces(owner)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(listAllUsers(owner)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(
      setFeatureFlag(owner, {
        workspaceId: s.workspaceA,
        key: 'crm.hubspot',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(
      startImpersonation(owner, {
        targetUserId: s.ownerB,
        targetWorkspaceId: s.workspaceB,
        reason: 'test',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

// ============ workspace overview ==================================

describe('listAllWorkspaces', () => {
  it('returns aggregated metrics across the platform', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    const rows = await listAllWorkspaces(god);
    expect(rows.map((r) => r.workspaceId).sort()).toEqual(
      [s.workspaceA, s.workspaceB].sort(),
    );
    for (const r of rows) {
      expect(r.memberCount).toBeGreaterThanOrEqual(1);
    }
  });
});

// ============ impersonation =======================================

describe('impersonation', () => {
  it('start + end records audit and active state', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    const session = await startImpersonation(god, {
      targetUserId: s.ownerB,
      targetWorkspaceId: s.workspaceB,
      reason: 'Investigating user-reported issue',
    });
    expect(session.endedAt).toBe(null);
    expect(session.actorUserId).toBe(s.godUser);
    expect(session.targetUserId).toBe(s.ownerB);

    const active = await activeImpersonationFor({ userId: s.godUser });
    expect(active?.id).toBe(session.id);

    const ended = await endImpersonation(god, session.id);
    expect(ended.endedAt).toBeInstanceOf(Date);
    expect(ended.endedByUserId).toBe(s.godUser);

    expect(await activeImpersonationFor({ userId: s.godUser })).toBe(null);
  });

  it('starting a second session closes the first by the same actor', async () => {
    const s = await setup();
    const otherTarget = await seedUser({ email: 'other@test.local' });
    await db.insert(workspaceMembers).values({
      workspaceId: s.workspaceA,
      userId: otherTarget,
      role: 'member',
    });
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    const first = await startImpersonation(god, {
      targetUserId: s.ownerB,
      targetWorkspaceId: s.workspaceB,
      reason: 'first',
    });
    const second = await startImpersonation(god, {
      targetUserId: otherTarget,
      targetWorkspaceId: s.workspaceA,
      reason: 'second',
    });
    expect(second.id).not.toBe(first.id);

    // First should now be closed, second active.
    const reloadedFirst = await db
      .select()
      .from(impersonationSessions)
      .where(eq(impersonationSessions.id, first.id));
    expect(reloadedFirst[0]!.endedAt).toBeInstanceOf(Date);
  });

  it('refuses target user not in the target workspace', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    await expect(
      startImpersonation(god, {
        targetUserId: s.ownerA,
        targetWorkspaceId: s.workspaceB,
        reason: 'wrong workspace',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('cannot end the same session twice', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    const session = await startImpersonation(god, {
      targetUserId: s.ownerB,
      targetWorkspaceId: s.workspaceB,
      reason: 'r',
    });
    await endImpersonation(god, session.id);
    await expect(
      endImpersonation(god, session.id),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('listImpersonationSessions returns historic sessions', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
    const session = await startImpersonation(god, {
      targetUserId: s.ownerB,
      targetWorkspaceId: s.workspaceB,
      reason: 'r',
    });
    const all = await listImpersonationSessions(god);
    expect(all.length).toBe(1);
    expect(all[0]!.id).toBe(session.id);

    const onlyActive = await listImpersonationSessions(god, { activeOnly: true });
    expect(onlyActive.length).toBe(1);

    await endImpersonation(god, session.id);
    const onlyActiveAfter = await listImpersonationSessions(god, { activeOnly: true });
    expect(onlyActiveAfter.length).toBe(0);
  });
});

// ============ feature flags =======================================

describe('feature flags', () => {
  it('upserts on (workspace, key)', async () => {
    const s = await setup();
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
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
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
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
    const god = ctx(s.workspaceA, s.godUser, 'super_admin');
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
