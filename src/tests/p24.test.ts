import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  distinctAuditKindsAcross,
  listAuditAcrossWorkspaces,
} from '@/lib/services/admin';
import { recordAuditEvent } from '@/lib/services/audit';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  superAdmin: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const superAdmin = await seedUser({
    email: 'super@test.local',
    role: 'super_admin',
  });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerA });
  return { workspaceA, workspaceB, ownerA, superAdmin };
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

describe('listAuditAcrossWorkspaces', () => {
  it('returns events across all workspaces, newest first', async () => {
    const s = await setup();
    await recordAuditEvent(
      { workspaceId: s.workspaceA, userId: s.ownerA },
      { kind: 'test.thing', entityType: 'thing', entityId: '1' },
    );
    await recordAuditEvent(
      { workspaceId: s.workspaceB, userId: s.ownerA },
      { kind: 'test.thing', entityType: 'thing', entityId: '2' },
    );
    const all = await listAuditAcrossWorkspaces(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
    );
    expect(all.length).toBeGreaterThanOrEqual(2);
    // Newest first.
    const idxA = all.findIndex((e) => e.workspaceId === s.workspaceA);
    const idxB = all.findIndex((e) => e.workspaceId === s.workspaceB);
    expect(idxB).toBeLessThan(idxA);
  });

  it('filters by workspace', async () => {
    const s = await setup();
    await recordAuditEvent(
      { workspaceId: s.workspaceA, userId: s.ownerA },
      { kind: 'test.a' },
    );
    await recordAuditEvent(
      { workspaceId: s.workspaceB, userId: s.ownerA },
      { kind: 'test.b' },
    );
    const onlyA = await listAuditAcrossWorkspaces(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      { workspaceId: s.workspaceA },
    );
    expect(onlyA.every((e) => e.workspaceId === s.workspaceA)).toBe(true);
  });

  it('filters by kind', async () => {
    const s = await setup();
    await recordAuditEvent(
      { workspaceId: s.workspaceA, userId: s.ownerA },
      { kind: 'kind.alpha' },
    );
    await recordAuditEvent(
      { workspaceId: s.workspaceA, userId: s.ownerA },
      { kind: 'kind.beta' },
    );
    const filtered = await listAuditAcrossWorkspaces(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      { kind: 'kind.alpha' },
    );
    expect(filtered.every((e) => e.kind === 'kind.alpha')).toBe(true);
    expect(filtered.length).toBeGreaterThan(0);
  });

  it('rejects non-super-admin', async () => {
    const s = await setup();
    await expect(
      listAuditAcrossWorkspaces(ctx(s.workspaceA, s.ownerA)),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('distinctAuditKindsAcross', () => {
  it('returns unique kinds, sorted', async () => {
    const s = await setup();
    await recordAuditEvent(
      { workspaceId: s.workspaceA, userId: s.ownerA },
      { kind: 'zeta.event' },
    );
    await recordAuditEvent(
      { workspaceId: s.workspaceA, userId: s.ownerA },
      { kind: 'alpha.event' },
    );
    await recordAuditEvent(
      { workspaceId: s.workspaceB, userId: s.ownerA },
      { kind: 'alpha.event' },
    );
    const kinds = await distinctAuditKindsAcross(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
    );
    const filtered = kinds.filter(
      (k) => k === 'alpha.event' || k === 'zeta.event',
    );
    expect(filtered).toEqual(['alpha.event', 'zeta.event']);
  });

  it('rejects non-super-admin', async () => {
    const s = await setup();
    await expect(
      distinctAuditKindsAcross(ctx(s.workspaceA, s.ownerA)),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
