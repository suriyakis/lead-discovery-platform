import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  adminCreateWorkspace,
  archiveWorkspace,
  deleteWorkspace,
} from '@/lib/services/admin';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
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
  return { workspaceA, ownerA, superAdmin };
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

describe('adminCreateWorkspace', () => {
  it('creates workspace + owner member + workspace_settings', async () => {
    const s = await setup();
    const ws = await adminCreateWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      { name: 'New Co', slug: 'new-co', ownerUserId: s.ownerA },
    );
    expect(ws.name).toBe('New Co');
    expect(ws.slug).toBe('new-co');
    expect(ws.status).toBe('active');
    const members = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, ws.id));
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe('owner');
  });

  it('lowercases the slug', async () => {
    const s = await setup();
    const ws = await adminCreateWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      { name: 'X', slug: 'X-CO', ownerUserId: s.ownerA },
    );
    expect(ws.slug).toBe('x-co');
  });

  it('rejects duplicate slug', async () => {
    const s = await setup();
    await adminCreateWorkspace(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      { name: 'A2', slug: 'taken', ownerUserId: s.ownerA },
    );
    await expect(
      adminCreateWorkspace(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        { name: 'B', slug: 'taken', ownerUserId: s.ownerA },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects invalid slug format', async () => {
    const s = await setup();
    await expect(
      adminCreateWorkspace(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        { name: 'X', slug: 'Bad Slug!', ownerUserId: s.ownerA },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects unknown owner', async () => {
    const s = await setup();
    await expect(
      adminCreateWorkspace(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        { name: 'X', slug: 'x', ownerUserId: 'no-such-user' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects non-super-admin', async () => {
    const s = await setup();
    await expect(
      adminCreateWorkspace(ctx(s.workspaceA, s.ownerA), {
        name: 'X',
        slug: 'x',
        ownerUserId: s.ownerA,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('deleteWorkspace', () => {
  it('refuses to delete an active workspace', async () => {
    const s = await setup();
    await expect(
      deleteWorkspace(ctx(s.workspaceA, s.superAdmin, 'super_admin'), s.workspaceA),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('deletes after archive (cascade sweeps members)', async () => {
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
    const members = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, s.workspaceA));
    expect(members).toHaveLength(0);
  });

  it('rejects unknown workspace', async () => {
    const s = await setup();
    await expect(
      deleteWorkspace(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        9_999_999n,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects non-super-admin', async () => {
    const s = await setup();
    await expect(
      deleteWorkspace(ctx(s.workspaceA, s.ownerA), s.workspaceA),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
