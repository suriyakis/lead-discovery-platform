import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { listAuditEvents } from '@/lib/services/audit';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import {
  ProductProfileServiceError,
  archiveProductProfile,
  createProductProfile,
  getProductProfile,
  listProductProfiles,
  restoreProductProfile,
  updateProductProfile,
} from '@/lib/services/product-profile';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  adminA: string;
  managerA: string;
  memberA: string;
  viewerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const adminA = await seedUser({ email: 'adminA@test.local' });
  const managerA = await seedUser({ email: 'managerA@test.local' });
  const memberA = await seedUser({ email: 'memberA@test.local' });
  const viewerA = await seedUser({ email: 'viewerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({
    name: 'A',
    ownerUserId: ownerA,
    extraMembers: [
      { userId: adminA, role: 'admin' },
      { userId: managerA, role: 'manager' },
      { userId: memberA, role: 'member' },
      { userId: viewerA, role: 'viewer' },
    ],
  });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, adminA, managerA, memberA, viewerA, ownerB };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'],
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- create -----------------------------------------------------------

describe('createProductProfile', () => {
  it('creates with required fields and writes audit event', async () => {
    const s = await setup();
    const profile = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
      name: 'Vetrofluid',
    });
    expect(profile.workspaceId).toBe(s.workspaceA);
    expect(profile.name).toBe('Vetrofluid');
    expect(profile.relevanceThreshold).toBe(50);
    expect(profile.active).toBe(true);
    expect(profile.language).toBe('en');
    expect(profile.includeKeywords).toEqual([]);
    expect(profile.createdBy).toBe(s.ownerA);

    const audit = await listAuditEvents(ctx(s.workspaceA, s.ownerA, 'owner'), {
      kind: 'product_profile.create',
    });
    expect(audit).toHaveLength(1);
    expect((audit[0]?.payload as { name: string }).name).toBe('Vetrofluid');
  });

  it('trims whitespace from name', async () => {
    const s = await setup();
    const profile = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
      name: '  Spaced  ',
    });
    expect(profile.name).toBe('Spaced');
  });

  it('rejects empty name', async () => {
    const s = await setup();
    await expect(
      createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: '   ' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects out-of-range relevanceThreshold', async () => {
    const s = await setup();
    await expect(
      createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
        name: 'X',
        relevanceThreshold: 150,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
        name: 'X',
        relevanceThreshold: -1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('viewer cannot create', async () => {
    const s = await setup();
    await expect(
      createProductProfile(ctx(s.workspaceA, s.viewerA, 'viewer'), { name: 'X' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('member can create', async () => {
    const s = await setup();
    const profile = await createProductProfile(ctx(s.workspaceA, s.memberA, 'member'), {
      name: 'M',
    });
    expect(profile.id).toBeTruthy();
  });

  it('persists array fields without aliasing the input', async () => {
    const s = await setup();
    const sectors = ['construction', 'retail'];
    const profile = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
      name: 'X',
      targetSectors: sectors,
    });
    expect(profile.targetSectors).toEqual(['construction', 'retail']);
    // Mutating the original should not affect what's stored.
    sectors.push('mutation');
    const refetched = await getProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), profile.id);
    expect(refetched.targetSectors).toEqual(['construction', 'retail']);
  });
});

// ---- read / list ------------------------------------------------------

describe('getProductProfile / listProductProfiles', () => {
  it('get returns the profile when scoped correctly', async () => {
    const s = await setup();
    const created = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
      name: 'A1',
    });
    const fetched = await getProductProfile(ctx(s.workspaceA, s.viewerA, 'viewer'), created.id);
    expect(fetched.name).toBe('A1');
  });

  it('get fails with not_found when accessed from a different workspace', async () => {
    const s = await setup();
    const created = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
      name: 'A1',
    });
    await expect(
      getProductProfile(ctx(s.workspaceB, s.ownerB, 'owner'), created.id),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('list is workspace-scoped', async () => {
    const s = await setup();
    await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'A1' });
    await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'A2' });
    await createProductProfile(ctx(s.workspaceB, s.ownerB, 'owner'), { name: 'B1' });

    const a = await listProductProfiles(ctx(s.workspaceA, s.viewerA, 'viewer'));
    const b = await listProductProfiles(ctx(s.workspaceB, s.ownerB, 'owner'));
    expect(a.map((p) => p.name).sort()).toEqual(['A1', 'A2']);
    expect(b.map((p) => p.name)).toEqual(['B1']);
  });

  it('list excludes archived by default; includeArchived=true returns all', async () => {
    const s = await setup();
    const a1 = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'A1' });
    await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'A2' });
    await archiveProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), a1.id);

    const active = await listProductProfiles(ctx(s.workspaceA, s.ownerA, 'owner'));
    expect(active.map((p) => p.name)).toEqual(['A2']);

    const all = await listProductProfiles(ctx(s.workspaceA, s.ownerA, 'owner'), {
      includeArchived: true,
    });
    expect(all.map((p) => p.name).sort()).toEqual(['A1', 'A2']);
  });

  it('list orders by name', async () => {
    const s = await setup();
    await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'Charlie' });
    await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'Alpha' });
    await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'Bravo' });
    const all = await listProductProfiles(ctx(s.workspaceA, s.ownerA, 'owner'));
    expect(all.map((p) => p.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});

// ---- update -----------------------------------------------------------

describe('updateProductProfile', () => {
  it('updates only the provided fields', async () => {
    const s = await setup();
    const created = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
      name: 'X',
      shortDescription: 'old short',
      includeKeywords: ['a', 'b'],
    });
    const updated = await updateProductProfile(
      ctx(s.workspaceA, s.adminA, 'admin'),
      created.id,
      { shortDescription: 'new short' },
    );
    expect(updated.name).toBe('X');
    expect(updated.shortDescription).toBe('new short');
    expect(updated.includeKeywords).toEqual(['a', 'b']);
    expect(updated.updatedBy).toBe(s.adminA);
  });

  it('rejects empty name on update', async () => {
    const s = await setup();
    const c = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'X' });
    await expect(
      updateProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), c.id, { name: '   ' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('viewer cannot update', async () => {
    const s = await setup();
    const c = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'X' });
    await expect(
      updateProductProfile(ctx(s.workspaceA, s.viewerA, 'viewer'), c.id, { name: 'Y' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('cross-workspace update fails with not_found', async () => {
    const s = await setup();
    const c = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'X' });
    await expect(
      updateProductProfile(ctx(s.workspaceB, s.ownerB, 'owner'), c.id, { name: 'Hijack' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('writes a product_profile.update audit event with changedKeys', async () => {
    const s = await setup();
    const c = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'X' });
    await updateProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), c.id, {
      shortDescription: 'updated',
      relevanceThreshold: 70,
    });
    const audit = await listAuditEvents(ctx(s.workspaceA, s.ownerA, 'owner'), {
      kind: 'product_profile.update',
    });
    expect(audit).toHaveLength(1);
    const changedKeys = (audit[0]?.payload as { changedKeys: string[] }).changedKeys;
    expect(changedKeys).toContain('shortDescription');
    expect(changedKeys).toContain('relevanceThreshold');
  });
});

// ---- archive / restore -----------------------------------------------

describe('archive / restore', () => {
  it('admin can archive and restore', async () => {
    const s = await setup();
    const c = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'X' });
    const archived = await archiveProductProfile(ctx(s.workspaceA, s.adminA, 'admin'), c.id);
    expect(archived.active).toBe(false);
    const restored = await restoreProductProfile(ctx(s.workspaceA, s.adminA, 'admin'), c.id);
    expect(restored.active).toBe(true);
  });

  it('manager cannot archive', async () => {
    const s = await setup();
    const c = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'X' });
    await expect(
      archiveProductProfile(ctx(s.workspaceA, s.managerA, 'manager'), c.id),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('member cannot archive', async () => {
    const s = await setup();
    const c = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), { name: 'X' });
    await expect(
      archiveProductProfile(ctx(s.workspaceA, s.memberA, 'member'), c.id),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

// ---- error-shape sanity ----------------------------------------------

describe('error shape', () => {
  it('all thrown errors are ProductProfileServiceError instances', async () => {
    const s = await setup();
    try {
      await createProductProfile(ctx(s.workspaceA, s.viewerA, 'viewer'), { name: 'X' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProductProfileServiceError);
    }
  });
});
