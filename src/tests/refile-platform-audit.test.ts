// PC-03 remediation: refile audit rows the old console misfiled (I051).
// Seeds the exact shapes prod can contain and checks the dry run, the
// fingerprint gate, the apply, idempotence and the revert.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog, type NewAuditLogEntry } from '@/lib/db/schema/audit';
import { listAuditEvents } from '@/lib/services/audit';
import { makeWorkspaceContext } from '@/lib/services/context';
import { createSupportThread } from '@/lib/services/support';
import {
  RefileError,
  applyRefile,
  planRefile,
  renderRefileReport,
  revertRefile,
} from '@/lib/remediation/refile-platform-audit';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

type RowKey =
  | 'preauthInA'
  | 'deleteInA'
  | 'billingInA'
  | 'supportReplyInA'
  | 'statusUnknownActorInA'
  | 'profileInHome'
  | 'supportCloseInHome'
  | 'billingInB'
  | 'platformAlready'
  | 'tenantOwnInA'
  | 'leadInA';

interface Fixture {
  superAdmin: string;
  ownerA: string;
  home: bigint;
  tenantA: bigint;
  tenantB: bigint;
  threadB: bigint;
  ids: Record<RowKey, bigint>;
}

async function insertRow(row: NewAuditLogEntry): Promise<bigint> {
  const [r] = await db.insert(auditLog).values(row).returning({ id: auditLog.id });
  return r!.id;
}

async function seed(): Promise<Fixture> {
  const superAdmin = await seedUser({ email: 'root@platform.test', role: 'super_admin' });
  const ownerA = await seedUser({ email: 'owner@tenant-a.test' });
  const ownerB = await seedUser({ email: 'owner@tenant-b.test' });
  const home = await seedWorkspace({ name: 'Home', ownerUserId: superAdmin });
  const tenantA = await seedWorkspace({ name: 'Tenant A', ownerUserId: ownerA });
  const tenantB = await seedWorkspace({ name: 'Tenant B', ownerUserId: ownerB });
  const thread = await createSupportThread(
    makeWorkspaceContext({ workspaceId: tenantB, userId: ownerB, role: 'owner' }),
    { subject: 'Help', body: 'please' },
  );
  // createSupportThread wrote its own (correct) support.thread.create row.
  const ids = {} as Record<RowKey, bigint>;
  // Leaked by god mode into tenant A (the admin is not a member of A).
  ids.preauthInA = await insertRow({
    workspaceId: tenantA,
    userId: superAdmin,
    kind: 'user.preauthorize',
    entityType: 'preauthorized_email',
    entityId: 'pre-1',
    payload: { email: 'jane.doe@tenant-b.test', workspaceId: tenantB.toString(), role: 'member' },
  });
  ids.deleteInA = await insertRow({
    workspaceId: tenantA,
    userId: superAdmin,
    kind: 'user.delete',
    entityType: 'user',
    entityId: 'gone-user',
    payload: { email: 'ex@tenant-b.test', name: 'Ex Employee' },
  });
  ids.billingInA = await insertRow({
    workspaceId: tenantA,
    userId: superAdmin,
    kind: 'admin.set_billing_exempt',
    entityType: 'workspace',
    entityId: tenantB.toString(),
    payload: { exempt: true },
  });
  ids.supportReplyInA = await insertRow({
    workspaceId: tenantA,
    userId: superAdmin,
    kind: 'support.message.admin',
    entityType: 'support_thread',
    entityId: thread.id.toString(),
    payload: { workspaceId: tenantB.toString() },
  });
  ids.statusUnknownActorInA = await insertRow({
    workspaceId: tenantA,
    userId: null,
    kind: 'user.set_account_status',
    entityType: 'user',
    entityId: 'someone',
    payload: { status: 'suspended', reason: 'free text about a person' },
  });
  // Filed into the admin's own home workspace (outside god mode).
  ids.profileInHome = await insertRow({
    workspaceId: home,
    userId: superAdmin,
    kind: 'admin.user.update_profile',
    entityType: 'user',
    entityId: 'someone',
    payload: { name: 'Jane Doe', email: 'jane.doe@tenant-b.test' },
  });
  ids.supportCloseInHome = await insertRow({
    workspaceId: home,
    userId: superAdmin,
    kind: 'support.thread.close',
    entityType: 'support_thread',
    entityId: thread.id.toString(),
    payload: { workspaceId: tenantB.toString() },
  });
  // Already correct — must not move.
  ids.billingInB = await insertRow({
    workspaceId: tenantB,
    userId: superAdmin,
    kind: 'admin.set_billing_exempt',
    entityType: 'workspace',
    entityId: tenantB.toString(),
    payload: { exempt: false },
  });
  ids.platformAlready = await insertRow({
    workspaceId: null,
    userId: superAdmin,
    kind: 'user.set_account_status',
    entityType: 'user',
    entityId: 'someone',
    payload: { status: 'active' },
  });
  // Not a console kind — tenant A's own history stays put.
  ids.tenantOwnInA = await insertRow({
    workspaceId: tenantA,
    userId: ownerA,
    kind: 'user.update_own_profile',
    entityType: 'user',
    entityId: ownerA,
    payload: { newName: 'Owner A' },
  });
  ids.leadInA = await insertRow({
    workspaceId: tenantA,
    userId: superAdmin,
    kind: 'review.approve',
    entityType: 'review_item',
    entityId: '7',
    payload: {},
  });
  return { superAdmin, ownerA, home, tenantA, tenantB, threadB: thread.id, ids };
}

async function row(id: bigint) {
  const [r] = await db.select().from(auditLog).where(eq(auditLog.id, id));
  return r!;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('planRefile (dry run)', () => {
  it('lists exactly the misfiled rows, grouped per workspace, with their destination', async () => {
    const f = await seed();
    const plan = await planRefile(db);

    const byId = new Map(plan.candidates.map((c) => [c.auditId, c]));
    expect([...byId.keys()].sort()).toEqual(
      [
        f.ids.preauthInA,
        f.ids.deleteInA,
        f.ids.billingInA,
        f.ids.supportReplyInA,
        f.ids.statusUnknownActorInA,
        f.ids.profileInHome,
        f.ids.supportCloseInHome,
      ]
        .map(String)
        .sort(),
    );
    expect(byId.get(String(f.ids.preauthInA))).toMatchObject({
      category: 'platform',
      exposure: 'cross_tenant',
      fromWorkspaceId: String(f.tenantA),
      toWorkspaceId: null,
    });
    expect(byId.get(String(f.ids.billingInA))).toMatchObject({
      category: 'billing',
      toWorkspaceId: String(f.tenantB),
    });
    expect(byId.get(String(f.ids.supportReplyInA))).toMatchObject({
      category: 'support',
      toWorkspaceId: String(f.tenantB),
    });
    expect(byId.get(String(f.ids.statusUnknownActorInA))?.exposure).toBe('actor_unknown');
    expect(byId.get(String(f.ids.profileInHome))?.exposure).toBe('own_workspace');

    expect(plan.totals).toEqual({
      rows: 7,
      crossTenant: 4,
      ownWorkspace: 2,
      actorUnknown: 1,
      byCategory: { platform: 4, billing: 1, support: 2 },
    });
    // Sorted by workspace id; home was seeded before tenant A.
    expect(plan.byWorkspace.map((w) => [w.workspaceId, w.rows])).toEqual([
      [String(f.home), 2],
      [String(f.tenantA), 5],
    ]);
    expect(plan.byWorkspace[1]!.byKind).toEqual({
      'admin.set_billing_exempt': 1,
      'support.message.admin': 1,
      'user.delete': 1,
      'user.preauthorize': 1,
      'user.set_account_status': 1,
    });
  });

  it('never puts personal data in the report', async () => {
    const f = await seed();
    const plan = await planRefile(db);
    const text = `${JSON.stringify(plan)}\n${renderRefileReport(plan)}`;
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/Jane|Ex Employee|free text/);
    expect(text).not.toContain(f.superAdmin);
  });

  it('cross-tenant scope keeps only the god-mode leaks', async () => {
    await seed();
    const plan = await planRefile(db, { scope: 'cross-tenant' });
    expect(plan.totals.rows).toBe(4);
    expect(plan.candidates.every((c) => c.exposure === 'cross_tenant')).toBe(true);
  });

  it('the fingerprint is stable and changes when the candidate set changes', async () => {
    const f = await seed();
    const a = await planRefile(db);
    const b = await planRefile(db);
    expect(b.fingerprint).toBe(a.fingerprint);
    await insertRow({
      workspaceId: f.tenantA,
      userId: f.superAdmin,
      kind: 'user.set_password',
      entityType: 'user',
      entityId: 'x',
      payload: { wasSelf: false },
    });
    expect((await planRefile(db)).fingerprint).not.toBe(a.fingerprint);
  });

  it('does not write anything', async () => {
    const f = await seed();
    const before = await db.select().from(auditLog).orderBy(asc(auditLog.id));
    await planRefile(db);
    const after = await db.select().from(auditLog).orderBy(asc(auditLog.id));
    expect(after).toEqual(before);
    void f;
  });
});

describe('applyRefile', () => {
  it('refuses a fingerprint that does not match the current plan, and moves nothing', async () => {
    const f = await seed();
    await expect(applyRefile(db, { expectFingerprint: 'deadbeefdeadbeef' })).rejects.toMatchObject({
      code: 'fingerprint_mismatch',
    });
    expect((await row(f.ids.preauthInA)).workspaceId).toBe(f.tenantA);
  });

  it('moves every candidate, stamps refiledFrom, logs one platform summary, and is idempotent', async () => {
    const f = await seed();
    const plan = await planRefile(db);
    const res = await applyRefile(db, { expectFingerprint: plan.fingerprint, runId: 'run-test-1' });
    expect(res.moved).toBe(7);

    for (const id of [f.ids.preauthInA, f.ids.deleteInA, f.ids.statusUnknownActorInA]) {
      const r = await row(id);
      expect(r.workspaceId).toBeNull();
      expect((r.payload as Record<string, unknown>).refiledFrom).toMatchObject({
        workspaceId: String(f.tenantA),
        runId: 'run-test-1',
      });
    }
    expect((await row(f.ids.profileInHome)).workspaceId).toBeNull();
    expect((await row(f.ids.billingInA)).workspaceId).toBe(f.tenantB);
    expect((await row(f.ids.supportReplyInA)).workspaceId).toBe(f.tenantB);
    expect((await row(f.ids.supportCloseInHome)).workspaceId).toBe(f.tenantB);
    // Original payload kept next to the stamp (reversible, nothing lost).
    expect((await row(f.ids.preauthInA)).payload).toMatchObject({ role: 'member' });

    // Untouched rows.
    expect((await row(f.ids.billingInB)).workspaceId).toBe(f.tenantB);
    expect((await row(f.ids.tenantOwnInA)).workspaceId).toBe(f.tenantA);
    expect((await row(f.ids.leadInA)).workspaceId).toBe(f.tenantA);

    // Tenant A's own audit view now holds only its own history.
    const aTrail = await listAuditEvents({ workspaceId: f.tenantA });
    expect(aTrail.map((r) => r.id).sort()).toEqual([f.ids.tenantOwnInA, f.ids.leadInA].sort());

    const summaries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'admin.audit.refile'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.workspaceId).toBeNull();
    expect(summaries[0]!.payload).toMatchObject({ runId: 'run-test-1', moved: 7 });

    const again = await planRefile(db);
    expect(again.totals.rows).toBe(0);
  });

  it('cross-tenant scope moves only the god-mode rows', async () => {
    const f = await seed();
    const plan = await planRefile(db, { scope: 'cross-tenant' });
    const res = await applyRefile(db, {
      expectFingerprint: plan.fingerprint,
      scope: 'cross-tenant',
    });
    expect(res.moved).toBe(4);
    expect((await row(f.ids.profileInHome)).workspaceId).toBe(f.home);
    expect((await row(f.ids.statusUnknownActorInA)).workspaceId).toBe(f.tenantA);
  });

  it('a fingerprint from one scope cannot apply the other', async () => {
    await seed();
    const narrow = await planRefile(db, { scope: 'cross-tenant' });
    await expect(
      applyRefile(db, { expectFingerprint: narrow.fingerprint, scope: 'all' }),
    ).rejects.toBeInstanceOf(RefileError);
  });
});

describe('revertRefile', () => {
  it('puts every row of a run back and removes the stamp', async () => {
    const f = await seed();
    const before = await db.select().from(auditLog).orderBy(asc(auditLog.id));
    const plan = await planRefile(db);
    const { runId } = await applyRefile(db, { expectFingerprint: plan.fingerprint });

    const res = await revertRefile(db, { runId });
    expect(res).toEqual({ runId, restored: 7, skippedMissingWorkspace: 0 });

    const after = (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter(
      (r) => !r.kind.startsWith('admin.audit.refile'),
    );
    expect(after).toEqual(before);

    const reverts = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'admin.audit.refile_revert'));
    expect(reverts).toHaveLength(1);
    expect(reverts[0]!.workspaceId).toBeNull();
    void f;
  });

  it('leaves rows whose original workspace was deleted at platform scope', async () => {
    const f = await seed();
    const plan = await planRefile(db, { scope: 'cross-tenant' });
    const { runId } = await applyRefile(db, {
      expectFingerprint: plan.fingerprint,
      scope: 'cross-tenant',
    });
    const { workspaces } = await import('@/lib/db/schema/workspaces');
    await db.delete(workspaces).where(eq(workspaces.id, f.tenantA));

    const res = await revertRefile(db, { runId });
    expect(res.restored).toBe(0);
    expect(res.skippedMissingWorkspace).toBe(4);
    const stillPlatform = await db
      .select()
      .from(auditLog)
      .where(isNull(auditLog.workspaceId));
    expect(stillPlatform.some((r) => r.id === f.ids.preauthInA)).toBe(true);
  });
});
