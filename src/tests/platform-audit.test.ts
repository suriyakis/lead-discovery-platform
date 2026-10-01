// PC-03 / I051: super-admin console actions are audit-logged at platform
// scope or against their explicit target — never into the workspace the
// admin's switcher points at.
//
// The scenario is the one the audit found: a super-admin whose
// users.activeWorkspaceId points at tenant A (god mode, not a member)
// works on users and data of tenant B from the console. Before the fix,
// every one of those rows landed in A, and A's own admins read B's
// people's emails, names and suspension reasons on /settings/audit.

import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { users } from '@/lib/db/schema/auth';
import { listAuditEvents } from '@/lib/services/audit';
import {
  AuthRequiredError,
  PlatformAdminRequiredError,
  getPlatformContext,
  requirePlatformAdmin,
} from '@/lib/services/auth-context';
import { makeWorkspaceContext } from '@/lib/services/context';
import {
  adminAddUserToWorkspace,
  listAuditAcrossWorkspaces,
  setBillingExempt,
  setFeatureFlag,
  updateUserProfile,
  updateWorkspaceProfile,
} from '@/lib/services/admin';
import {
  adminReplySupportThread,
  adminSetSupportThreadStatus,
  createSupportThread,
} from '@/lib/services/support';
import { adjustTokens } from '@/lib/services/token-ledger';
import {
  createPasswordUser,
  deleteUserGlobally,
  preauthorizeEmail,
  revokePreauthorize,
  setAccountStatus,
  setUserPassword,
  setUserPlatformRole,
} from '@/lib/services/users';
import { resolveWorkspaceContextForUser } from '@/lib/services/workspace-resolution';
import { PLATFORM_SCOPE_KINDS } from '@/lib/remediation/refile-platform-audit';
import { isNextRedirectError } from '@/lib/server-redirect';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

const mockedAuth = auth as unknown as Mock;

function sessionFor(id: string, role: 'member' | 'super_admin') {
  return {
    user: { id, role, accountStatus: 'active', email: `${id}@session.test`, name: null },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

interface Setup {
  superAdmin: string;
  homeWs: bigint;
  tenantA: bigint;
  tenantB: bigint;
  ownerA: string;
  adminA: string;
  ownerB: string;
  memberB: string;
}

async function setup(): Promise<Setup> {
  const superAdmin = await seedUser({ email: 'root@platform.test', role: 'super_admin' });
  const ownerA = await seedUser({ email: 'owner@tenant-a.test' });
  const adminA = await seedUser({ email: 'admin@tenant-a.test' });
  const ownerB = await seedUser({ email: 'owner@tenant-b.test' });
  const memberB = await seedUser({ email: 'jane.doe@tenant-b.test', name: 'Jane Doe' });
  const homeWs = await seedWorkspace({ name: 'Platform home', ownerUserId: superAdmin });
  const tenantA = await seedWorkspace({
    name: 'Tenant A',
    ownerUserId: ownerA,
    extraMembers: [{ userId: adminA, role: 'admin' }],
  });
  const tenantB = await seedWorkspace({
    name: 'Tenant B',
    ownerUserId: ownerB,
    extraMembers: [{ userId: memberB, role: 'member' }],
  });
  // God mode: the switcher points at tenant A, where the admin is NOT a member.
  await db.update(users).set({ activeWorkspaceId: tenantA }).where(eq(users.id, superAdmin));
  return { superAdmin, homeWs, tenantA, tenantB, ownerA, adminA, ownerB, memberB };
}

beforeEach(async () => {
  await truncateAll();
  mockedAuth.mockReset();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('PlatformContext entry points', () => {
  it('getPlatformContext: signed out -> AuthRequiredError', async () => {
    mockedAuth.mockResolvedValue(null);
    await expect(getPlatformContext()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('getPlatformContext: a workspace owner is not a platform admin', async () => {
    const s = await setup();
    mockedAuth.mockResolvedValue(sessionFor(s.ownerA, 'member'));
    await expect(getPlatformContext()).rejects.toBeInstanceOf(PlatformAdminRequiredError);
  });

  it('getPlatformContext: super-admin gets a context with no workspace in it', async () => {
    const s = await setup();
    mockedAuth.mockResolvedValue(sessionFor(s.superAdmin, 'super_admin'));
    const pctx = await getPlatformContext();
    expect(pctx).toEqual({ scope: 'platform', actorUserId: s.superAdmin });
    expect('workspaceId' in pctx).toBe(false);
  });

  it('requirePlatformAdmin redirects signed-out users to / and members to /dashboard', async () => {
    const s = await setup();
    const redirectTarget = async () => {
      try {
        await requirePlatformAdmin();
      } catch (err) {
        expect(isNextRedirectError(err)).toBe(true);
        return String((err as { digest: string }).digest).split(';')[2];
      }
      throw new Error('expected a redirect');
    };
    mockedAuth.mockResolvedValue(null);
    expect(await redirectTarget()).toBe('/');
    mockedAuth.mockResolvedValue(sessionFor(s.ownerA, 'member'));
    expect(await redirectTarget()).toBe('/dashboard');
  });

  it('requirePlatformAdmin works for a super-admin with no workspace at all', async () => {
    const lone = await seedUser({ email: 'lone-root@platform.test', role: 'super_admin' });
    mockedAuth.mockResolvedValue(sessionFor(lone, 'super_admin'));
    await expect(requirePlatformAdmin()).resolves.toEqual({
      scope: 'platform',
      actorUserId: lone,
    });
  });
});

describe('audit attribution from the console (I051)', () => {
  it('god mode on tenant A + console actions on tenant B: nothing lands in A', async () => {
    const s = await setup();

    // Precondition: this is the god-mode state the old console resolved
    // its WorkspaceContext from — tenant A.
    const godMode = await resolveWorkspaceContextForUser(s.superAdmin, true);
    expect(godMode.workspaceId).toBe(s.tenantA);

    mockedAuth.mockResolvedValue(sessionFor(s.superAdmin, 'super_admin'));
    const pctx = await requirePlatformAdmin();

    // --- platform-level actions on tenant B's people -----------------
    await setAccountStatus(pctx, s.memberB, 'suspended', 'chargeback dispute — Jane Doe');
    await setAccountStatus(pctx, s.memberB, 'active');
    const pre = await preauthorizeEmail(pctx, {
      email: 'new.hire@tenant-b.test',
      workspaceId: s.tenantB,
      role: 'member',
    });
    await revokePreauthorize(pctx, pre.id);
    const temp = await createPasswordUser(pctx, {
      email: 'contractor@tenant-b.test',
      password: 'long-enough-1',
      workspaceId: s.tenantB,
    });
    await setUserPlatformRole(pctx, s.memberB, 'super_admin');
    await setUserPlatformRole(pctx, s.memberB, 'member');
    await setUserPassword(pctx, s.memberB, 'another-pass-1');
    await updateUserProfile(pctx, s.memberB, { name: 'Jane D.' });
    await deleteUserGlobally(pctx, temp.id);

    // --- tenant-level actions on tenant B ------------------------------
    await setBillingExempt(pctx, s.tenantB, true);
    await adjustTokens(pctx, s.tenantB, 250, 'support credit');
    await updateWorkspaceProfile(pctx, s.tenantB, { name: 'Tenant B Ltd' });
    await setFeatureFlag(pctx, { workspaceId: s.tenantB, key: 'crm.hubspot', enabled: true });
    const extra = await seedUser({ email: 'extra@tenant-b.test' });
    await adminAddUserToWorkspace(pctx, extra, s.tenantB, 'viewer');

    // --- support ---------------------------------------------------------
    const thread = await createSupportThread(
      makeWorkspaceContext({ workspaceId: s.tenantB, userId: s.ownerB, role: 'owner' }),
      { subject: 'Import stuck', body: 'Our CSV import hangs.' },
    );
    await adminReplySupportThread(pctx, thread.id, 'Looking into it.');
    await adminSetSupportThreadStatus(pctx, thread.id, 'closed');
    await adminSetSupportThreadStatus(pctx, thread.id, 'open');

    const all = await db.select().from(auditLog);
    expect(all.length).toBeGreaterThan(15);

    // (1) Nothing in the god-mode workspace, nothing in the admin's home.
    expect(all.filter((r) => r.workspaceId === s.tenantA)).toEqual([]);
    expect(all.filter((r) => r.workspaceId === s.homeWs)).toEqual([]);

    // Platform kinds: workspace_id NULL, every one of them.
    const platformKinds = PLATFORM_SCOPE_KINDS as readonly string[];
    const platformRows = all.filter((r) => platformKinds.includes(r.kind));
    expect(platformRows.map((r) => r.kind).sort()).toEqual(
      [
        'admin.user.update_profile',
        'user.create_password_user',
        'user.delete',
        'user.preauthorize',
        'user.revoke_preauthorize',
        'user.set_account_status',
        'user.set_account_status',
        'user.set_password',
        'user.set_platform_role',
        'user.set_platform_role',
      ].sort(),
    );
    for (const r of platformRows) {
      expect(r.workspaceId).toBeNull();
      expect(r.userId).toBe(s.superAdmin);
    }

    // Billing and token rows carry the target workspace.
    const billing = all.filter((r) => r.kind === 'admin.set_billing_exempt');
    expect(billing).toHaveLength(1);
    expect(billing[0]!.workspaceId).toBe(s.tenantB);
    expect(all.find((r) => r.kind === 'tokens.adjust')?.workspaceId).toBe(s.tenantB);

    // Support rows carry the thread's workspace and only the thread id.
    const support = all.filter((r) =>
      ['support.message.admin', 'support.thread.close', 'support.thread.reopen'].includes(r.kind),
    );
    expect(support.map((r) => r.kind).sort()).toEqual(
      ['support.message.admin', 'support.thread.close', 'support.thread.reopen'].sort(),
    );
    for (const r of support) {
      expect(r.workspaceId).toBe(s.tenantB);
      expect(r.userId).toBe(s.superAdmin);
      expect(r.payload).toEqual({ threadId: thread.id.toString() });
    }

    // (3) Tenant A's /settings/audit (listAuditEvents on A) is empty, and
    // tenant B's own trail shows its billing/support history but none of
    // the platform rows — so no third-party email or name in it either.
    expect(await listAuditEvents({ workspaceId: s.tenantA })).toEqual([]);
    const bTrail = await listAuditEvents({ workspaceId: s.tenantB }, { limit: 1000 });
    const bKinds = new Set(bTrail.map((r) => r.kind));
    for (const k of [
      'admin.set_billing_exempt',
      'tokens.adjust',
      'support.message.admin',
      'support.thread.close',
      'support.thread.reopen',
    ]) {
      expect(bKinds.has(k)).toBe(true);
    }
    for (const k of platformKinds) expect(bKinds.has(k)).toBe(false);
    expect(JSON.stringify(bTrail.map((r) => r.payload))).not.toMatch(/@|Jane/);

    // The console's platform filter finds exactly the platform rows.
    const platformView = await listAuditAcrossWorkspaces(pctx, { workspaceId: null, limit: 1000 });
    expect(platformView.every((r) => r.workspaceId === null)).toBe(true);
    expect(platformView.filter((r) => platformKinds.includes(r.kind))).toHaveLength(
      platformRows.length,
    );
  });

  it('a refused delete leaves no "user.delete" row behind', async () => {
    const s = await setup();
    mockedAuth.mockResolvedValue(sessionFor(s.superAdmin, 'super_admin'));
    const pctx = await requirePlatformAdmin();
    // ownerB owns tenant B -> refused with a conflict.
    await expect(deleteUserGlobally(pctx, s.ownerB)).rejects.toMatchObject({ code: 'conflict' });
    const rows = await db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.kind, ['user.delete']));
    expect(rows).toEqual([]);
  });
});
