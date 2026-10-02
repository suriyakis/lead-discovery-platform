// Users without a workspace (audit I117, deliverable ia:F-07).
//
// Before this fix a pre-authorisation that named no workspace activated
// the new user at first sign-in and returned before the Personal
// workspace was provisioned, so they landed active with zero
// memberships. Pre-authorising an existing account activated it but
// added no membership and never consumed the entry. The dashboard then
// showed "No workspace yet … check OWNER_EMAIL in the server config",
// /onboarding and several settings pages bounced to '/', and nothing
// outside /admin could create a workspace.
//
// Covered here:
//   - first sign-in (provisionOnSignIn, the auth.ts signIn event body);
//   - preauthorizeEmail when the account already exists;
//   - createFirstWorkspace and its server action (allowed once);
//   - the no-workspace screen on /dashboard, and /onboarding and the
//     settings pages routing such users to it;
//   - no OWNER_EMAIL left under src/app.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { preauthorizedEmails, users } from '@/lib/db/schema/auth';
import { workspaceMembers, workspaceSettings, workspaces } from '@/lib/db/schema/workspaces';
import { archiveWorkspace } from '@/lib/services/admin';
import type { PlatformContext } from '@/lib/services/platform-context';
import { preauthorizeEmail } from '@/lib/services/users';
import { resolveWorkspaceContextForUser } from '@/lib/services/workspace-resolution';
import {
  createFirstWorkspace,
  getWorkspaceStartState,
  provisionOnSignIn,
  workspaceSlugFor,
} from '@/lib/services/workspace-provisioning';
import { createFirstWorkspaceAction } from '@/lib/workspace-actions';
import TodayPage from '@/app/today/page';
import OnboardingPage from '@/app/onboarding/page';
import AccountSettingsPage from '@/app/settings/account/page';
import WorkspaceAuditPage from '@/app/settings/audit/page';
import BillingPage from '@/app/settings/billing/page';
import CrmSettingsPage from '@/app/settings/crm/page';
import IntegrationsPage from '@/app/settings/integrations/page';
import MembersPage from '@/app/settings/members/page';
import OutreachSettingsPage from '@/app/settings/outreach/page';
import UsagePage from '@/app/settings/usage/page';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';
import { platformCtx } from './helpers/platform';
import { expectRedirect, renderToHtml } from './helpers/next-render';

// Pages and actions read the signed-in user through Auth.js; tests drive
// them with a plain session object instead.
const session = vi.hoisted(() => ({
  current: null as null | {
    user: {
      id: string;
      name: string;
      email: string;
      role: 'member' | 'super_admin';
      accountStatus: 'pending' | 'active' | 'suspended' | 'rejected';
    };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => session.current }));
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
      accountStatus: u!.accountStatus,
    },
  };
}

async function renderDashboard(sp: { error?: string } = {}): Promise<string> {
  // The no-workspace screen moved with the dashboard to Today (DS-05).
  const tree = await TodayPage({ searchParams: Promise.resolve({ view: 'overview', ...sp }) });
  return (await renderToHtml(tree)).replaceAll('<!-- -->', '');
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Workspaces the user owns (workspaces.owner_user_id). */
async function ownedBy(userId: string) {
  return db.select().from(workspaces).where(eq(workspaces.ownerUserId, userId));
}

/** The user's memberships with the workspace each one is in. */
async function membershipsOf(userId: string) {
  return db
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
}

async function userRow(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  return u!;
}

async function entryFor(email: string) {
  const [e] = await db
    .select()
    .from(preauthorizedEmails)
    .where(eq(preauthorizedEmails.email, email));
  return e ?? null;
}

async function auditRows(workspaceId: bigint, kind: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.kind, kind)));
}

/** A super-admin (who also owns a workspace of their own) and the
 *  PlatformContext requirePlatformAdmin() gives them in the console. */
async function seedPlatformAdmin(): Promise<{ id: string; home: bigint; ctx: PlatformContext }> {
  const id = await seedUser({ email: 'root@test.local', role: 'super_admin' });
  const home = await seedWorkspace({ name: 'Platform', ownerUserId: id });
  return { id, home, ctx: platformCtx(id) };
}

/** What the Auth.js adapter leaves behind for a first-time Google user. */
async function newGoogleUser(email: string): Promise<string> {
  return seedUser({ email, accountStatus: 'pending' });
}

beforeEach(async () => {
  await truncateAll();
  session.current = null;
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ============ first sign-in ============================================

describe('first sign-in (provisionOnSignIn)', () => {
  it('a pre-authorisation with no workspace gives a first-time user exactly one owned workspace, pending onboarding', async () => {
    const admin = await seedPlatformAdmin();
    await preauthorizeEmail(admin.ctx, { email: 'New.Person@Example.com' });

    const user = await newGoogleUser('new.person@example.com');
    const outcome = await provisionOnSignIn(
      { id: user, email: 'New.Person@Example.com' },
      { isNewUser: true, ownerEmail: null },
    );

    expect(outcome).toBe('preauthorized');
    expect((await userRow(user)).accountStatus).toBe('active');
    const owned = await ownedBy(user);
    expect(owned).toHaveLength(1);
    const ws = owned[0]!;
    expect(ws.onboardingStatus).toBe('pending');
    expect(ws.status).toBe('active');
    expect(await membershipsOf(user)).toEqual([{ workspaceId: ws.id, role: 'owner' }]);
    const settings = await db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ws.id));
    expect(settings).toHaveLength(1);
    expect((await entryFor('new.person@example.com'))?.consumedAt).toBeInstanceOf(Date);
    const [bootstrap] = await auditRows(ws.id, 'workspace.bootstrap');
    expect(bootstrap?.payload).toMatchObject({
      reason: 'preauthorized_own_workspace',
      preauthorizedBy: admin.id,
    });
    // Every page now resolves a workspace for them.
    expect((await resolveWorkspaceContextForUser(user, false)).workspaceId).toBe(ws.id);
  });

  it('a pre-authorisation naming a workspace adds the user there at the role, and nothing else', async () => {
    const admin = await seedPlatformAdmin();
    const owner = await seedUser({ email: 'owner@test.local' });
    const team = await seedWorkspace({ name: 'Team', ownerUserId: owner });
    await preauthorizeEmail(admin.ctx, { email: 'joiner@test.local', workspaceId: team, role: 'manager' });

    const user = await newGoogleUser('joiner@test.local');
    await provisionOnSignIn({ id: user, email: 'joiner@test.local' }, { isNewUser: true, ownerEmail: null });

    expect((await userRow(user)).accountStatus).toBe('active');
    expect(await membershipsOf(user)).toEqual([{ workspaceId: team, role: 'manager' }]);
    expect(await ownedBy(user)).toHaveLength(0);
    expect((await entryFor('joiner@test.local'))?.consumedAt).toBeInstanceOf(Date);
    const [consumed] = await auditRows(team, 'user.preauthorize_consumed');
    expect(consumed?.userId).toBe(admin.id);
    expect(consumed?.entityId).toBe(user);
  });

  it('a named workspace archived since the pre-authorisation falls back to a workspace of their own', async () => {
    const admin = await seedPlatformAdmin();
    const owner = await seedUser({ email: 'owner@test.local' });
    const team = await seedWorkspace({ name: 'Team', ownerUserId: owner });
    await preauthorizeEmail(admin.ctx, { email: 'late@test.local', workspaceId: team, role: 'member' });
    await archiveWorkspace(admin.ctx, team);

    const user = await newGoogleUser('late@test.local');
    await provisionOnSignIn({ id: user, email: 'late@test.local' }, { isNewUser: true, ownerEmail: null });

    const owned = await ownedBy(user);
    expect(owned).toHaveLength(1);
    expect(await membershipsOf(user)).toEqual([{ workspaceId: owned[0]!.id, role: 'owner' }]);
    const [bootstrap] = await auditRows(owned[0]!.id, 'workspace.bootstrap');
    expect(bootstrap?.payload).toMatchObject({
      reason: 'preauthorized_own_workspace',
      requestedWorkspaceId: team.toString(),
    });
  });

  it('an entry whose admin account is gone is still applied, audited to the user', async () => {
    const owner = await seedUser({ email: 'owner@test.local' });
    const team = await seedWorkspace({ name: 'Team', ownerUserId: owner });
    await db.insert(preauthorizedEmails).values({
      email: 'orphan@test.local',
      workspaceId: team.toString(),
      role: 'member',
      createdBy: 'deleted-admin-id',
    });

    const user = await newGoogleUser('orphan@test.local');
    await provisionOnSignIn({ id: user, email: 'orphan@test.local' }, { isNewUser: true, ownerEmail: null });

    expect(await membershipsOf(user)).toEqual([{ workspaceId: team, role: 'member' }]);
    const [consumed] = await auditRows(team, 'user.preauthorize_consumed');
    expect(consumed?.userId).toBe(user);
  });

  it('a plain self-signup still gets a Personal workspace', async () => {
    const user = await newGoogleUser('walkin@test.local');
    const outcome = await provisionOnSignIn(
      { id: user, email: 'walkin@test.local' },
      { isNewUser: true, ownerEmail: 'boss@test.local' },
    );

    expect(outcome).toBe('self_signup');
    const u = await userRow(user);
    expect(u.accountStatus).toBe('active');
    expect(u.role).toBe('member');
    const owned = await ownedBy(user);
    expect(owned.map((w) => [w.name, w.onboardingStatus])).toEqual([['Personal', 'pending']]);
    expect(owned[0]!.slug).toMatch(/^personal-[0-9a-f]{8}$/);
    const [bootstrap] = await auditRows(owned[0]!.id, 'workspace.bootstrap');
    expect(bootstrap?.payload).toMatchObject({ reason: 'self_signup' });
  });

  it('the OWNER_EMAIL account becomes super-admin with a Personal workspace', async () => {
    const user = await newGoogleUser('boss@test.local');
    const outcome = await provisionOnSignIn(
      { id: user, email: 'Boss@Test.local' },
      { isNewUser: true, ownerEmail: 'boss@test.local' },
    );

    expect(outcome).toBe('owner_bootstrap');
    const u = await userRow(user);
    expect(u.role).toBe('super_admin');
    expect(u.accountStatus).toBe('active');
    expect(await ownedBy(user)).toHaveLength(1);
  });

  it('a returning sign-in records the time and provisions nothing', async () => {
    const user = await seedUser({ email: 'back@test.local' });
    const outcome = await provisionOnSignIn(
      { id: user, email: 'back@test.local' },
      { isNewUser: false, ownerEmail: null },
    );

    expect(outcome).toBe('returning');
    expect((await userRow(user)).lastSignedInAt).toBeInstanceOf(Date);
    expect(await ownedBy(user)).toHaveLength(0);
  });
});

// ============ pre-authorising an existing account ======================

describe('preauthorizeEmail for an account that already exists', () => {
  it('a pending user gets the membership straight away and the entry is consumed', async () => {
    const admin = await seedPlatformAdmin();
    const owner = await seedUser({ email: 'owner@test.local' });
    const team = await seedWorkspace({ name: 'Team', ownerUserId: owner });
    const waiting = await seedUser({ email: 'waiting@test.local', accountStatus: 'pending' });

    const entry = await preauthorizeEmail(admin.ctx, {
      email: 'Waiting@Test.local',
      workspaceId: team,
      role: 'manager',
    });

    expect(entry.consumedAt).toBeInstanceOf(Date);
    expect((await entryFor('waiting@test.local'))?.consumedAt).toBeInstanceOf(Date);
    expect((await userRow(waiting)).accountStatus).toBe('active');
    expect(await membershipsOf(waiting)).toEqual([{ workspaceId: team, role: 'manager' }]);
    const [consumed] = await auditRows(team, 'user.preauthorize_consumed');
    expect(consumed?.userId).toBe(admin.id);
    expect(consumed?.entityId).toBe(waiting);
    // The pre-authorisation itself is a platform event (I051): filed in
    // no workspace, never in the admin's own.
    const preauthRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'user.preauthorize'));
    expect(preauthRows.map((r) => r.workspaceId)).toEqual([null]);
    expect(await auditRows(admin.home, 'user.preauthorize')).toHaveLength(0);
  });

  it("'their own new workspace' gives an existing user without one exactly one owned workspace", async () => {
    const admin = await seedPlatformAdmin();
    const loner = await seedUser({ email: 'loner@test.local' });

    const entry = await preauthorizeEmail(admin.ctx, { email: 'loner@test.local', workspaceId: null });

    expect(entry.consumedAt).toBeInstanceOf(Date);
    expect(entry.role).toBe('owner');
    const owned = await ownedBy(loner);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.onboardingStatus).toBe('pending');
    expect(await membershipsOf(loner)).toEqual([{ workspaceId: owned[0]!.id, role: 'owner' }]);
  });

  it("'their own new workspace' adds nothing for a user who already has a workspace", async () => {
    const admin = await seedPlatformAdmin();
    const owner = await seedUser({ email: 'owner@test.local' });
    const member = await seedUser({ email: 'member@test.local' });
    const team = await seedWorkspace({
      name: 'Team',
      ownerUserId: owner,
      extraMembers: [{ userId: member, role: 'member' }],
    });

    const entry = await preauthorizeEmail(admin.ctx, { email: 'member@test.local' });

    expect(entry.consumedAt).toBeInstanceOf(Date);
    expect(await membershipsOf(member)).toEqual([{ workspaceId: team, role: 'member' }]);
    expect(await ownedBy(member)).toHaveLength(0);
  });

  // Self-service treats an archived workspace as used up (see the
  // createFirstWorkspace tests below); an explicit pre-authorisation by a
  // super-admin is how such a user is unblocked, so it must grant.
  it("'their own new workspace' unblocks a user whose own workspace is archived", async () => {
    const admin = await seedPlatformAdmin();
    const user = await seedUser({ email: 'archived@test.local' });
    const old = await seedWorkspace({ name: 'Old Co', ownerUserId: user });
    await archiveWorkspace(admin.ctx, old);
    expect((await getWorkspaceStartState(user)).canCreate).toBe(false);

    const entry = await preauthorizeEmail(admin.ctx, { email: 'archived@test.local' });

    expect(entry.consumedAt).toBeInstanceOf(Date);
    const fresh = (await ownedBy(user)).filter((w) => w.id !== old);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.status).toBe('active');
    expect(await membershipsOf(user)).toEqual(
      expect.arrayContaining([
        { workspaceId: old, role: 'owner' },
        { workspaceId: fresh[0]!.id, role: 'owner' },
      ]),
    );
    expect((await resolveWorkspaceContextForUser(user, false)).workspaceId).toBe(fresh[0]!.id);
  });

  it("'their own new workspace' unblocks a member whose only team is archived", async () => {
    const admin = await seedPlatformAdmin();
    const owner = await seedUser({ email: 'owner@test.local' });
    const member = await seedUser({ email: 'member@test.local' });
    const team = await seedWorkspace({
      name: 'Team',
      ownerUserId: owner,
      extraMembers: [{ userId: member, role: 'member' }],
    });
    await archiveWorkspace(admin.ctx, team);

    await preauthorizeEmail(admin.ctx, { email: 'member@test.local' });

    const owned = await ownedBy(member);
    expect(owned).toHaveLength(1);
    expect((await resolveWorkspaceContextForUser(member, false)).workspaceId).toBe(owned[0]!.id);
  });

  it('pre-authorising an already-consumed email again works and adds the second workspace', async () => {
    const admin = await seedPlatformAdmin();
    const owner = await seedUser({ email: 'owner@test.local' });
    const a = await seedWorkspace({ name: 'A', ownerUserId: owner });
    const b = await seedWorkspace({ name: 'B', ownerUserId: owner });
    const user = await seedUser({ email: 'twice@test.local' });

    await preauthorizeEmail(admin.ctx, { email: 'twice@test.local', workspaceId: a, role: 'member' });
    await preauthorizeEmail(admin.ctx, { email: 'twice@test.local', workspaceId: b, role: 'viewer' });

    const rows = await membershipsOf(user);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { workspaceId: a, role: 'member' },
        { workspaceId: b, role: 'viewer' },
      ]),
    );
    const entries = await db
      .select()
      .from(preauthorizedEmails)
      .where(eq(preauthorizedEmails.email, 'twice@test.local'));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.workspaceId).toBe(b.toString());
  });

  it('refuses a missing or archived workspace and an unknown role, and writes nothing', async () => {
    const admin = await seedPlatformAdmin();
    const owner = await seedUser({ email: 'owner@test.local' });
    const gone = await seedWorkspace({ name: 'Gone', ownerUserId: owner });
    await archiveWorkspace(admin.ctx, gone);
    const team = await seedWorkspace({ name: 'Team', ownerUserId: owner });

    await expect(
      preauthorizeEmail(admin.ctx, { email: 'x@test.local', workspaceId: 999_999n }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      preauthorizeEmail(admin.ctx, { email: 'x@test.local', workspaceId: gone }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      preauthorizeEmail(admin.ctx, {
        email: 'x@test.local',
        workspaceId: team,
        role: 'emperor' as never,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await entryFor('x@test.local')).toBeNull();
  });
});

// ============ creating a first workspace ===============================

describe('createFirstWorkspace', () => {
  it('a user with zero memberships can create exactly one workspace; a second attempt is denied', async () => {
    const user = await seedUser({ email: 'founder@test.local' });

    const ws = await createFirstWorkspace(user, { name: '  Acme Ltd  ' });
    expect(ws.name).toBe('Acme Ltd');
    expect(ws.slug).toMatch(/^acme-ltd-[0-9a-f]{8}$/);
    expect(ws.ownerUserId).toBe(user);
    expect(ws.onboardingStatus).toBe('pending');
    expect(await membershipsOf(user)).toEqual([{ workspaceId: ws.id, role: 'owner' }]);
    expect((await userRow(user)).activeWorkspaceId).toBe(ws.id);
    const [bootstrap] = await auditRows(ws.id, 'workspace.bootstrap');
    expect(bootstrap?.payload).toMatchObject({ reason: 'self_service_create' });
    expect(bootstrap?.userId).toBe(user);

    await expect(createFirstWorkspace(user, { name: 'Second' })).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(await ownedBy(user)).toHaveLength(1);
  });

  it('two submits at once still create only one workspace', async () => {
    const user = await seedUser({ email: 'double@test.local' });

    const results = await Promise.allSettled([
      createFirstWorkspace(user, { name: 'One' }),
      createFirstWorkspace(user, { name: 'Two' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'permission_denied',
    });
    expect(await ownedBy(user)).toHaveLength(1);
  });

  it('a member of a workspace may not create one', async () => {
    const owner = await seedUser({ email: 'owner@test.local' });
    const member = await seedUser({ email: 'member@test.local' });
    await seedWorkspace({ name: 'Team', ownerUserId: owner, extraMembers: [{ userId: member, role: 'member' }] });

    await expect(createFirstWorkspace(member, { name: 'Mine' })).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(await ownedBy(member)).toHaveLength(0);
  });

  it('a user whose only workspace is archived may not create another, and the screen says why', async () => {
    const admin = await seedPlatformAdmin();
    const user = await seedUser({ email: 'archived@test.local' });
    const old = await seedWorkspace({ name: 'Old Co', ownerUserId: user });
    await archiveWorkspace(admin.ctx, old);

    expect(await getWorkspaceStartState(user)).toEqual({
      canCreate: false,
      blockedBy: 'membership',
      archivedWorkspaces: ['Old Co'],
    });
    await expect(createFirstWorkspace(user, { name: 'New Co' })).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });

  it('refuses an account that is not active, and a blank or overlong name', async () => {
    const pending = await seedUser({ email: 'pending@test.local', accountStatus: 'pending' });
    await expect(createFirstWorkspace(pending, { name: 'Pending Co' })).rejects.toMatchObject({
      code: 'permission_denied',
    });

    const user = await seedUser({ email: 'namer@test.local' });
    await expect(createFirstWorkspace(user, { name: '   ' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(createFirstWorkspace(user, { name: 'x'.repeat(121) })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(await ownedBy(user)).toHaveLength(0);
    expect(await ownedBy(pending)).toHaveLength(0);
  });

  it('slugs are lowercase words plus a random suffix', () => {
    expect(workspaceSlugFor('Łódź Café & Co.')).toMatch(/^odz-cafe-co-[0-9a-f]{8}$/);
    expect(workspaceSlugFor('!!!')).toMatch(/^workspace-[0-9a-f]{8}$/);
    expect(workspaceSlugFor('a'.repeat(100)).length).toBeLessThanOrEqual(49);
  });
});

describe('createFirstWorkspaceAction', () => {
  it('creates the workspace and opens the setup wizard; a second submit comes back with a message', async () => {
    const user = await seedUser({ email: 'founder@test.local' });
    await signInAs(user);

    expect(await expectRedirect(() => createFirstWorkspaceAction(form({ name: 'Acme' })))).toBe(
      '/onboarding',
    );
    expect((await ownedBy(user)).map((w) => w.name)).toEqual(['Acme']);

    const again = await expectRedirect(() => createFirstWorkspaceAction(form({ name: 'Again' })));
    expect(again.startsWith('/today?error=')).toBe(true);
    expect(decodeURIComponent(again.slice('/today?error='.length))).toContain(
      'You already belong to a workspace',
    );
    expect(await ownedBy(user)).toHaveLength(1);
  });

  it('a blank name comes back with a message; signed-out and pending users are sent away', async () => {
    const user = await seedUser({ email: 'blank@test.local' });
    await signInAs(user);
    const blank = await expectRedirect(() => createFirstWorkspaceAction(form({ name: ' ' })));
    expect(decodeURIComponent(blank)).toBe('/today?error=Give your workspace a name.');

    session.current = null;
    expect(await expectRedirect(() => createFirstWorkspaceAction(form({ name: 'X' })))).toBe('/');

    const pending = await seedUser({ email: 'pending@test.local', accountStatus: 'pending' });
    await signInAs(pending);
    expect(await expectRedirect(() => createFirstWorkspaceAction(form({ name: 'X' })))).toBe(
      '/pending',
    );
    expect(await ownedBy(user)).toHaveLength(0);
    expect(await ownedBy(pending)).toHaveLength(0);
  });
});

// ============ the no-workspace screen ==================================

describe('the no-workspace screen on /today', () => {
  it('offers to create a workspace and explains how to be added, with no server-config hint', async () => {
    const user = await seedUser({ email: 'loner@test.local' });
    await signInAs(user);

    const html = await renderDashboard();
    expect(html).toContain('Create your workspace');
    expect(html).toContain('name="name"');
    expect(html).toContain('Ask your admin to invite you');
    expect(html).toContain(`<code>${user}</code>`);
    expect(html).toContain('loner@test.local');
    expect(html).not.toContain('OWNER_EMAIL');
    // No module tiles or platform console link for a regular user.
    expect(html).not.toContain('module-tile');
    expect(html).not.toContain('href="/admin"');
  });

  it('after creating a workspace the user gets the dashboard, via the setup wizard once', async () => {
    const user = await seedUser({ email: 'founder@test.local' });
    await signInAs(user);
    await createFirstWorkspace(user, { name: 'Acme' });

    expect(await expectRedirect(() => renderDashboard())).toBe('/onboarding');
    const html = await renderDashboard();
    expect(html).toContain('Acme');
    expect(html).not.toContain('Create your workspace');
  });

  it('a user whose workspace is archived is told so instead of offered a form', async () => {
    const admin = await seedPlatformAdmin();
    const user = await seedUser({ email: 'archived@test.local' });
    const old = await seedWorkspace({ name: 'Old Co', ownerUserId: user });
    await archiveWorkspace(admin.ctx, old);
    await signInAs(user);

    const html = await renderDashboard();
    expect(html).not.toContain('name="name"');
    expect(html).toContain('Your workspace Old Co is archived.');
    expect(html).toContain('Ask your admin to invite you');
  });

  it('shows a refused submit as a message', async () => {
    const user = await seedUser({ email: 'loner@test.local' });
    await signInAs(user);

    const html = await renderDashboard({ error: 'Give your workspace a name.' });
    expect(html).toContain('role="alert">Give your workspace a name.</p>');
  });

  it('a super-admin without a workspace also gets the platform console link', async () => {
    const root = await seedUser({ email: 'root@test.local', role: 'super_admin' });
    await signInAs(root);

    const html = await renderDashboard();
    expect(html).toContain('Create your workspace');
    expect(html).toContain('href="/admin"');
  });
});

describe('/onboarding and the settings pages send a user without a workspace to the screen', () => {
  const sp = () => Promise.resolve({});
  const PAGES: Array<[string, () => Promise<unknown>]> = [
    ['/onboarding', () => OnboardingPage({ searchParams: sp() })],
    ['/settings/account', () => AccountSettingsPage({ searchParams: sp() })],
    ['/settings/members', () => MembersPage({ searchParams: sp() })],
    ['/settings/billing', () => BillingPage({ searchParams: sp() })],
    ['/settings/outreach', () => OutreachSettingsPage({ searchParams: sp() })],
    ['/settings/audit', () => WorkspaceAuditPage({ searchParams: sp() })],
    ['/settings/crm', () => CrmSettingsPage({ searchParams: sp() })],
    ['/settings/integrations', () => IntegrationsPage({ searchParams: sp() })],
    ['/settings/usage', () => UsagePage({ searchParams: sp() })],
  ];

  it.each(PAGES)('%s redirects to /today', async (_route, render) => {
    const user = await seedUser({ email: 'loner@test.local' });
    await signInAs(user);
    expect(await expectRedirect(render)).toBe('/today');
  });
});

describe('static: no OWNER_EMAIL under src/app', () => {
  it('no page or route mentions the server variable', () => {
    const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (readFileSync(full, 'utf8').includes('OWNER_EMAIL')) {
          offenders.push(path.relative(appDir, full));
        }
      }
    };
    walk(appDir);
    expect(offenders).toEqual([]);
  });
});
