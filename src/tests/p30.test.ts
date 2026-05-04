import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { sessions, users } from '@/lib/db/schema/auth';
import { workspaceMembers } from '@/lib/db/schema/workspaces';
import {
  type WorkspaceContext,
  makeWorkspaceContext,
} from '@/lib/services/context';
import {
  createPasswordUser,
  deleteUserGlobally,
  setUserPassword,
  verifyUserPassword,
} from '@/lib/services/users';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  ownerA: string;
  superAdmin: string;
  member: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const superAdmin = await seedUser({
    email: 'super@test.local',
    role: 'super_admin',
  });
  const member = await seedUser({ email: 'member@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  return { workspaceA, ownerA, superAdmin, member };
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

// ============ createPasswordUser ====================================

describe('createPasswordUser', () => {
  it('creates an active user with bcrypt-hashed password', async () => {
    const s = await setup();
    const u = await createPasswordUser(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      {
        email: 'new@example.com',
        password: 'sup3rsecret',
        name: 'New User',
      },
    );
    expect(u.email).toBe('new@example.com');
    expect(u.accountStatus).toBe('active');
    expect(u.passwordHash).toBeTruthy();
    expect(u.passwordHash).not.toBe('sup3rsecret');
    expect(u.passwordHash?.startsWith('$2')).toBe(true); // bcrypt prefix
  });

  it('refuses non-super-admin', async () => {
    const s = await setup();
    await expect(
      createPasswordUser(ctx(s.workspaceA, s.ownerA), {
        email: 'x@example.com',
        password: 'secret123',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('refuses duplicate email (case-insensitive)', async () => {
    const s = await setup();
    await expect(
      createPasswordUser(ctx(s.workspaceA, s.superAdmin, 'super_admin'), {
        email: 'OWNERA@test.local',
        password: 'secret123',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses too-short password', async () => {
    const s = await setup();
    await expect(
      createPasswordUser(ctx(s.workspaceA, s.superAdmin, 'super_admin'), {
        email: 'short@example.com',
        password: 'abc',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('optionally adds the user to a workspace at the given role', async () => {
    const s = await setup();
    const u = await createPasswordUser(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      {
        email: 'with-ws@example.com',
        password: 'secret123',
        workspaceId: s.workspaceA,
        workspaceRole: 'admin',
      },
    );
    const memb = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, u.id));
    expect(memb).toHaveLength(1);
    expect(memb[0]?.role).toBe('admin');
  });
});

// ============ verifyUserPassword ====================================

describe('verifyUserPassword', () => {
  it('returns the user on a correct password', async () => {
    const s = await setup();
    await createPasswordUser(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      { email: 'login@example.com', password: 'rightpass1' },
    );
    const u = await verifyUserPassword('login@example.com', 'rightpass1');
    expect(u).not.toBeNull();
    expect(u?.email).toBe('login@example.com');
  });

  it('returns null on wrong password', async () => {
    const s = await setup();
    await createPasswordUser(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      { email: 'wrong@example.com', password: 'rightpass1' },
    );
    expect(
      await verifyUserPassword('wrong@example.com', 'wrongpass'),
    ).toBeNull();
  });

  it('returns null on unknown email', async () => {
    expect(await verifyUserPassword('nope@example.com', 'anything')).toBeNull();
  });

  it('returns null when user has no passwordHash (OAuth-only)', async () => {
    const s = await setup();
    void s;
    expect(
      await verifyUserPassword('ownerA@test.local', 'anything'),
    ).toBeNull();
  });

  it('refuses login when accountStatus is suspended', async () => {
    const s = await setup();
    await createPasswordUser(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      {
        email: 'suspended@example.com',
        password: 'rightpass1',
        accountStatus: 'suspended',
      },
    );
    expect(
      await verifyUserPassword('suspended@example.com', 'rightpass1'),
    ).toBeNull();
  });

  it('case-insensitive email lookup', async () => {
    const s = await setup();
    await createPasswordUser(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      { email: 'casetest@example.com', password: 'rightpass1' },
    );
    expect(
      await verifyUserPassword('CaseTest@Example.com', 'rightpass1'),
    ).not.toBeNull();
  });
});

// ============ setUserPassword =======================================

describe('setUserPassword', () => {
  it('rotates the hash and invalidates existing sessions', async () => {
    const s = await setup();
    const u = await createPasswordUser(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      { email: 'rotate@example.com', password: 'oldpass11' },
    );
    // Plant a session.
    await db.insert(sessions).values({
      sessionToken: 'tok-rotate',
      userId: u.id,
      expires: new Date(Date.now() + 60_000),
    });
    await setUserPassword(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      u.id,
      'newpass123',
    );
    expect(
      await verifyUserPassword('rotate@example.com', 'oldpass11'),
    ).toBeNull();
    expect(
      await verifyUserPassword('rotate@example.com', 'newpass123'),
    ).not.toBeNull();
    const left = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, u.id));
    expect(left).toHaveLength(0);
  });

  it('allows self-reset by non-admin', async () => {
    const s = await setup();
    const u = await createPasswordUser(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      { email: 'self@example.com', password: 'oldpass11' },
    );
    await setUserPassword(
      ctx(s.workspaceA, u.id, 'member'),
      u.id,
      'newpass123',
    );
    expect(
      await verifyUserPassword('self@example.com', 'newpass123'),
    ).not.toBeNull();
  });

  it('refuses to reset another user as non-admin', async () => {
    const s = await setup();
    await expect(
      setUserPassword(ctx(s.workspaceA, s.ownerA), s.member, 'newpass123'),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

// ============ deleteUserGlobally ====================================

describe('deleteUserGlobally', () => {
  it('removes the user and cascades sessions/memberships', async () => {
    const s = await setup();
    await db.insert(sessions).values({
      sessionToken: 'tok-del',
      userId: s.member,
      expires: new Date(Date.now() + 60_000),
    });
    await deleteUserGlobally(
      ctx(s.workspaceA, s.superAdmin, 'super_admin'),
      s.member,
    );
    const left = await db.select().from(users).where(eq(users.id, s.member));
    expect(left).toHaveLength(0);
    const sess = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, s.member));
    expect(sess).toHaveLength(0);
  });

  it('refuses to delete a workspace owner without ownership transfer', async () => {
    const s = await setup();
    await expect(
      deleteUserGlobally(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.ownerA,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses to delete yourself', async () => {
    const s = await setup();
    await expect(
      deleteUserGlobally(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        s.superAdmin,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses to delete another super-admin', async () => {
    const s = await setup();
    const other = await seedUser({
      email: 'other-super@test.local',
      role: 'super_admin',
    });
    await expect(
      deleteUserGlobally(
        ctx(s.workspaceA, s.superAdmin, 'super_admin'),
        other,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses non-super-admin', async () => {
    const s = await setup();
    await expect(
      deleteUserGlobally(ctx(s.workspaceA, s.ownerA), s.member),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
