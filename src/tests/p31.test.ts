import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  changeOwnPassword,
  createPasswordUser,
  updateOwnProfile,
  verifyUserPassword,
} from '@/lib/services/users';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
  superAdmin: string;
  pwUserId: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const superAdmin = await seedUser({
    email: 'super@test.local',
    role: 'super_admin',
  });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  // Create a password user.
  const u = await createPasswordUser(
    ctx(workspaceA, superAdmin, 'super_admin'),
    {
      email: 'pwuser@test.local',
      password: 'oldpass11',
      name: 'PW User',
    },
  );
  return { workspaceA, ownerA, superAdmin, pwUserId: u.id };
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

// ============ updateOwnProfile ======================================

describe('updateOwnProfile', () => {
  it('changes the user own name', async () => {
    const s = await setup();
    const u = await updateOwnProfile(ctx(s.workspaceA, s.pwUserId, 'member'), {
      name: 'New Display',
    });
    expect(u.name).toBe('New Display');
  });

  it('clears the name to null when blank', async () => {
    const s = await setup();
    const u = await updateOwnProfile(ctx(s.workspaceA, s.pwUserId, 'member'), {
      name: '   ',
    });
    expect(u.name).toBeNull();
  });
});

// ============ changeOwnPassword =====================================

describe('changeOwnPassword', () => {
  it('rotates the password when old matches', async () => {
    const s = await setup();
    await changeOwnPassword(
      ctx(s.workspaceA, s.pwUserId, 'member'),
      'oldpass11',
      'newpass99',
    );
    expect(
      await verifyUserPassword('pwuser@test.local', 'newpass99'),
    ).not.toBeNull();
    expect(
      await verifyUserPassword('pwuser@test.local', 'oldpass11'),
    ).toBeNull();
  });

  it('refuses when old does not match', async () => {
    const s = await setup();
    await expect(
      changeOwnPassword(
        ctx(s.workspaceA, s.pwUserId, 'member'),
        'wrongold',
        'newpass99',
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses too-short new password', async () => {
    const s = await setup();
    await expect(
      changeOwnPassword(
        ctx(s.workspaceA, s.pwUserId, 'member'),
        'oldpass11',
        'abc',
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('OAuth-only user can set initial password with empty old', async () => {
    const s = await setup();
    // ownerA has no password.
    await changeOwnPassword(
      ctx(s.workspaceA, s.ownerA, 'member'),
      '',
      'firstpass1',
    );
    expect(
      await verifyUserPassword('ownerA@test.local', 'firstpass1'),
    ).not.toBeNull();
    const u = await db
      .select()
      .from(users)
      .where(eq(users.id, s.ownerA))
      .limit(1);
    expect(u[0]?.passwordHash).toBeTruthy();
  });

  it('OAuth-only user cannot supply a non-empty old password', async () => {
    const s = await setup();
    await expect(
      changeOwnPassword(
        ctx(s.workspaceA, s.ownerA, 'member'),
        'something',
        'firstpass1',
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('does NOT invalidate other sessions (session stays alive)', async () => {
    // Implementation note: changeOwnPassword does not delete sessions
    // by design — the user stays signed in. This test asserts that
    // contract by checking sessions table isn't touched (no rows
    // existed for pwuser anyway, but we plant one to be sure).
    const s = await setup();
    const { sessions } = await import('@/lib/db/schema/auth');
    await db.insert(sessions).values({
      sessionToken: 'tok-keep',
      userId: s.pwUserId,
      expires: new Date(Date.now() + 60_000),
    });
    await changeOwnPassword(
      ctx(s.workspaceA, s.pwUserId, 'member'),
      'oldpass11',
      'newpass99',
    );
    const left = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, s.pwUserId));
    expect(left).toHaveLength(1);
  });
});
