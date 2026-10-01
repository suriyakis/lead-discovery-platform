// Integration tests for how /dashboard picks its workspace and when it
// sends someone into the onboarding wizard (audit I042 + I174,
// deliverables ia:F-05 and PC-04).
//
// The dashboard used to read the user's memberships with no ORDER BY and
// take memberships[0] for the onboarding gate and the "Active workspace"
// card. Anyone whose first row was an unfinished workspace was redirected
// to /onboarding on every visit; a non-admin could never get out of that
// loop. The card could also name a different tenant than the switcher,
// and in god mode the signals came from the super-admin's own workspace.
//
// These tests render the real page for seeded users. getWorkspaceContext()
// stays real, so workspace resolution runs as it does in production.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { sourceRecords } from '@/lib/db/schema/connectors';
import { reviewItems } from '@/lib/db/schema/review';
import {
  workspaceMembers,
  workspaces,
  type Workspace,
  type WorkspaceMemberRole,
} from '@/lib/db/schema/workspaces';
import { makeWorkspaceContext } from '@/lib/services/context';
import { archiveWorkspace } from '@/lib/services/admin';
import { resolveWorkspaceContextForUser } from '@/lib/services/workspace-resolution';
import { listMyWorkspaces, setActiveWorkspace } from '@/lib/services/workspace';
import Dashboard from '@/app/dashboard/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { expectRedirect, renderToHtml } from './helpers/next-render';

type OnboardingStatus = Workspace['onboardingStatus'];

// The page reads the signed-in user through Auth.js; tests drive it with
// a plain session object instead.
const session = vi.hoisted(() => ({
  current: null as null | {
    user: {
      id: string;
      name: string;
      email: string;
      role: 'member' | 'super_admin';
      accountStatus: 'active';
    };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
// The shell (header, switcher, nav badges) is shared chrome with its own
// session plumbing. The switcher's data comes from listMyWorkspaces,
// which these tests call directly.
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

async function signInAs(userId: string): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  session.current = {
    user: {
      id: userId,
      name: u!.name ?? 'Test',
      email: u!.email,
      role: u!.role === 'super_admin' ? 'super_admin' : 'member',
      accountStatus: 'active',
    },
  };
}

async function renderDashboard(): Promise<string> {
  const tree = await Dashboard();
  // Drop React's `<!-- -->` text-node separators so assertions match
  // what the user reads.
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

/** Name on the "Active workspace" card. */
function cardWorkspaceName(html: string): string | null {
  const m = /Active workspace<\/span>.*?<h2 class="profile-card-title">([^<]*)<\/h2>/s.exec(
    html,
  );
  return m?.[1] ?? null;
}

/** Value of the "Pending review" signal card. */
function pendingReviewSignal(html: string): number | null {
  const m =
    /cockpit-card-label">Pending review<\/span><\/div><div class="cockpit-card-value">(\d+)</.exec(
      html,
    );
  return m ? Number(m[1]) : null;
}

/** Give a workspace `n` new review items, so the "Pending review" signal
 *  tells which workspace the cockpit read. */
async function seedPendingReviews(workspaceId: bigint, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const [source] = await db
      .insert(sourceRecords)
      .values({
        workspaceId,
        sourceSystem: 'mock',
        sourceId: `dash-${workspaceId}-${i}`,
        rawData: {},
        normalizedData: {},
        sourceUrl: `https://example.com/${workspaceId}/${i}`,
      })
      .returning();
    await db
      .insert(reviewItems)
      .values({ workspaceId, sourceRecordId: source!.id, state: 'new' });
  }
}

async function setOnboarding(workspaceId: bigint, status: OnboardingStatus): Promise<void> {
  await db
    .update(workspaces)
    .set({ onboardingStatus: status })
    .where(eq(workspaces.id, workspaceId));
}

async function onboardingOf(workspaceId: bigint): Promise<OnboardingStatus> {
  const [ws] = await db
    .select({ s: workspaces.onboardingStatus })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return ws!.s;
}

async function addMember(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceMemberRole,
  createdAt?: Date,
): Promise<void> {
  await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role, ...(createdAt ? { createdAt } : {}) });
}

/** The workspace the header switcher would show as current. */
async function switcherActive(userId: string): Promise<bigint | null> {
  const rows = await listMyWorkspaces(userId, { includeAllForSuperAdmin: true });
  return rows.find((r) => r.isActive)?.workspace.id ?? null;
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('/dashboard onboarding redirect', () => {
  it.each(['pending', 'in_progress'] as const)(
    'a member of a team workspace whose owner never finished onboarding (%s) gets the dashboard',
    async (status) => {
      const owner = await seedUser({ email: 'owner@test.local' });
      const member = await seedUser({ email: 'member@test.local' });
      const team = await seedWorkspace({
        name: 'Team',
        ownerUserId: owner,
        extraMembers: [{ userId: member, role: 'member' }],
      });
      await setOnboarding(team, status);
      await signInAs(member);

      // Renders twice in a row with no redirect: no loop.
      for (let i = 0; i < 2; i += 1) {
        const html = await renderDashboard();
        expect(cardWorkspaceName(html)).toBe('Team');
        // Members cannot run the wizard, so they get no setup link either.
        expect(html).not.toContain('Continue workspace setup');
      }
      // A member's visit does not use up the owner's first-run redirect.
      expect(await onboardingOf(team)).toBe(status);
    },
  );

  it.each(['owner', 'admin'] as const)(
    'an %s of a pending workspace is redirected exactly once',
    async (role) => {
      const owner = await seedUser({ email: 'owner@test.local' });
      const admin = await seedUser({ email: 'admin@test.local' });
      const ws = await seedWorkspace({
        name: 'Fresh',
        ownerUserId: owner,
        extraMembers: [{ userId: admin, role: 'admin' }],
      });
      await setOnboarding(ws, 'pending');
      await signInAs(role === 'owner' ? owner : admin);

      expect(await expectRedirect(() => renderDashboard())).toBe('/onboarding');
      // The redirect itself moved the wizard on, so it cannot repeat.
      expect(await onboardingOf(ws)).toBe('in_progress');

      const html = await renderDashboard();
      expect(cardWorkspaceName(html)).toBe('Fresh');
      // The unfinished wizard stays one click away for an admin.
      expect(html).toContain('href="/onboarding"');
      expect(html).toContain('Continue workspace setup');
      expect(await onboardingOf(ws)).toBe('in_progress');
    },
  );

  it('an unfinished Personal workspace does not bounce a user who switched to a team workspace', async () => {
    const user = await seedUser({ email: 'switcher@test.local' });
    const teamOwner = await seedUser({ email: 'teamowner@test.local' });
    // Personal is the user's oldest membership: the old memberships[0].
    const personal = await seedWorkspace({ name: 'Personal', ownerUserId: user });
    await setOnboarding(personal, 'pending');
    const team = await seedWorkspace({
      name: 'Team',
      ownerUserId: teamOwner,
      extraMembers: [{ userId: user, role: 'member' }],
    });
    await setActiveWorkspace(user, team);
    await signInAs(user);

    const html = await renderDashboard();
    expect(cardWorkspaceName(html)).toBe('Team');
    expect(await onboardingOf(personal)).toBe('pending');
  });

  it('a completed workspace never redirects and shows no setup link', async () => {
    const owner = await seedUser({ email: 'owner@test.local' });
    await seedWorkspace({ name: 'Done', ownerUserId: owner });
    await signInAs(owner);

    const html = await renderDashboard();
    expect(cardWorkspaceName(html)).toBe('Done');
    expect(html).not.toContain('Continue workspace setup');
  });

  it('a user with no workspace gets the no-workspace screen instead of an error', async () => {
    const loner = await seedUser({ email: 'loner@test.local' });
    await signInAs(loner);

    // The screen itself is covered in no-workspace.test.ts (ia:F-07).
    const html = await renderDashboard();
    expect(html).toContain('Create your workspace');
    expect(html).not.toContain('OWNER_EMAIL');
    expect(pendingReviewSignal(html)).toBeNull();
  });
});

describe('/dashboard uses the resolved active workspace', () => {
  it('a user with two memberships sees the card and signals of the active one, not memberships[0]', async () => {
    const user = await seedUser({ email: 'two@test.local' });
    const other = await seedUser({ email: 'other@test.local' });
    const first = await seedWorkspace({ name: 'First', ownerUserId: user });
    const second = await seedWorkspace({
      name: 'Second',
      ownerUserId: other,
      extraMembers: [{ userId: user, role: 'manager' }],
    });
    await seedPendingReviews(first, 1);
    await seedPendingReviews(second, 2);
    await setActiveWorkspace(user, second);
    await signInAs(user);

    const html = await renderDashboard();
    expect(cardWorkspaceName(html)).toBe('Second');
    expect(html).toContain('role-pill-manager');
    expect(html).toContain('member of 2 workspaces');
    expect(pendingReviewSignal(html)).toBe(2);
    expect(await switcherActive(user)).toBe(second);
  });

  // The same three workspaces, joined at fixed times (Zulu first), but
  // inserted in three different physical orders. Postgres returns an
  // unordered SELECT in heap order, so the old memberships[0] followed
  // the insert order. Names are chosen so alphabetical order (which the
  // switcher list uses) puts Zulu last.
  const ORDERS: Array<Array<'Zulu' | 'Alpha' | 'Mike'>> = [
    ['Zulu', 'Alpha', 'Mike'],
    ['Alpha', 'Mike', 'Zulu'],
    ['Mike', 'Zulu', 'Alpha'],
  ];
  it.each(ORDERS)(
    'insert order %s, %s, %s: dashboard, resolver and switcher all pick the oldest membership',
    async (...order) => {
      const user = await seedUser({ email: 'shuffle@test.local' });
      const owner = await seedUser({ email: 'owner@test.local' });
      const joinedAt = {
        Zulu: new Date('2026-01-01T00:00:00Z'),
        Mike: new Date('2026-02-01T00:00:00Z'),
        Alpha: new Date('2026-03-01T00:00:00Z'),
      };
      const reviews = { Zulu: 1, Mike: 2, Alpha: 3 };
      const ids = new Map<string, bigint>();
      for (const name of order) {
        const ws = await seedWorkspace({ name, ownerUserId: owner });
        await addMember(ws, user, 'member', joinedAt[name]);
        await seedPendingReviews(ws, reviews[name]);
        ids.set(name, ws);
      }
      await signInAs(user);

      const resolved = await resolveWorkspaceContextForUser(user, false);
      expect(resolved.workspaceId).toBe(ids.get('Zulu'));

      const html = await renderDashboard();
      expect(cardWorkspaceName(html)).toBe('Zulu');
      expect(pendingReviewSignal(html)).toBe(1);
      expect(await switcherActive(user)).toBe(ids.get('Zulu'));
    },
  );

  it('in god mode the card and the signals belong to the inspected tenant', async () => {
    const admin = await seedUser({ email: 'root@test.local', role: 'super_admin' });
    const tenantOwner = await seedUser({ email: 'tenant@test.local' });
    const home = await seedWorkspace({ name: 'Home', ownerUserId: admin });
    const tenant = await seedWorkspace({ name: 'Tenant', ownerUserId: tenantOwner });
    await seedPendingReviews(home, 1);
    await seedPendingReviews(tenant, 3);
    // The tenant's owner has not run the wizard yet.
    await setOnboarding(tenant, 'pending');
    await setActiveWorkspace(admin, tenant, { allowAnyAsSuperAdmin: true });
    await signInAs(admin);

    const html = await renderDashboard();
    expect(cardWorkspaceName(html)).toBe('Tenant');
    expect(html).toContain('god mode');
    expect(pendingReviewSignal(html)).toBe(3);
    expect(html).not.toContain('Continue workspace setup');
    // Inspecting the tenant neither redirected the super-admin nor used
    // up the owner's first-run redirect.
    expect(await onboardingOf(tenant)).toBe('pending');
    expect(await switcherActive(admin)).toBe(tenant);
  });
});

describe('archived workspaces in the switcher (I174)', () => {
  async function setupArchived() {
    const admin = await seedUser({ email: 'root@test.local', role: 'super_admin' });
    const user = await seedUser({ email: 'user@test.local' });
    const live = await seedWorkspace({ name: 'Live', ownerUserId: user });
    const gone = await seedWorkspace({ name: 'Gone', ownerUserId: user });
    await seedPendingReviews(live, 1);
    await seedPendingReviews(gone, 2);
    await archiveWorkspace(
      makeWorkspaceContext({ workspaceId: gone, userId: admin, role: 'super_admin' }),
      gone,
    );
    return { admin, user, live, gone };
  }

  it('an archived membership is absent from the switcher and setActiveWorkspace on it errors', async () => {
    const s = await setupArchived();

    const rows = await listMyWorkspaces(s.user);
    expect(rows.map((r) => r.workspace.id)).toEqual([s.live]);
    expect(rows[0]?.isActive).toBe(true);

    await expect(setActiveWorkspace(s.user, s.gone)).rejects.toMatchObject({
      code: 'workspace_archived',
    });
    const [u] = await db
      .select({ active: users.activeWorkspaceId })
      .from(users)
      .where(eq(users.id, s.user));
    expect(u?.active).toBeNull();
  });

  it('a pointer left on a since-archived workspace is ignored by the dashboard and the switcher alike', async () => {
    const s = await setupArchived();
    // The pointer was set while the workspace was still live.
    await db.update(users).set({ activeWorkspaceId: s.gone }).where(eq(users.id, s.user));
    await signInAs(s.user);

    const html = await renderDashboard();
    expect(cardWorkspaceName(html)).toBe('Live');
    expect(pendingReviewSignal(html)).toBe(1);
    // The archived membership is not counted either.
    expect(html).not.toContain('member of 2 workspaces');
    expect(await switcherActive(s.user)).toBe(s.live);
  });

  it('super-admins still list their archived memberships and may enter them', async () => {
    const s = await setupArchived();
    await addMember(s.gone, s.admin, 'admin');

    const rows = await listMyWorkspaces(s.admin);
    expect(rows.map((r) => r.workspace.id)).toContain(s.gone);
    await setActiveWorkspace(s.admin, s.gone, { allowAnyAsSuperAdmin: true });
    expect(await switcherActive(s.admin)).toBe(s.gone);
  });
});
