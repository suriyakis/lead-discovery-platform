import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
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
import { platformCtx, smuggled } from './helpers/platform';

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
      platformCtx(s.superAdmin),
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
      platformCtx(s.superAdmin),
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
      platformCtx(s.superAdmin),
      { kind: 'kind.alpha' },
    );
    expect(filtered.every((e) => e.kind === 'kind.alpha')).toBe(true);
    expect(filtered.length).toBeGreaterThan(0);
  });

  it('rejects non-super-admin', async () => {
    const s = await setup();
    await expect(
      listAuditAcrossWorkspaces(smuggled(ctx(s.workspaceA, s.ownerA))),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

// The since / until filters used to bind a JS Date inside a raw sql``
// template, which postgres.js cannot encode: every /admin/audit request
// with Since or Until set failed (audit finding I050, deliverable PC-01).
describe('listAuditAcrossWorkspaces date window', () => {
  const since = new Date('2026-03-10T10:00:00.000Z');
  const until = new Date('2026-03-10T12:00:00.000Z');

  /** One probe row on each side of each bound, plus one inside (in B). */
  async function seedAroundWindow(s: Setup) {
    const at = async (iso: string, workspaceId = s.workspaceA): Promise<bigint> => {
      const [row] = await db
        .insert(auditLog)
        .values({
          workspaceId,
          userId: s.ownerA,
          kind: 'window.probe',
          payload: {},
          createdAt: new Date(iso),
        })
        .returning();
      return row!.id;
    };
    return {
      beforeSince: await at('2026-03-10T09:59:59.999Z'),
      atSince: await at('2026-03-10T10:00:00.000Z'),
      inside: await at('2026-03-10T11:00:00.000Z', s.workspaceB),
      atUntil: await at('2026-03-10T12:00:00.000Z'),
      afterUntil: await at('2026-03-10T12:00:00.001Z'),
    };
  }

  async function ids(s: Setup, filter: Parameters<typeof listAuditAcrossWorkspaces>[1]) {
    const rows = await listAuditAcrossWorkspaces(platformCtx(s.superAdmin), {
      kind: 'window.probe',
      ...filter,
    });
    return rows.map((r) => r.id);
  }

  it('keeps only rows inside since..until, both bounds inclusive, newest first', async () => {
    const s = await setup();
    const r = await seedAroundWindow(s);
    expect(await ids(s, { since, until })).toEqual([r.atUntil, r.inside, r.atSince]);
  });

  it('since alone drops only the rows before it', async () => {
    const s = await setup();
    const r = await seedAroundWindow(s);
    expect(await ids(s, { since })).toEqual([r.afterUntil, r.atUntil, r.inside, r.atSince]);
  });

  it('until alone drops only the rows after it', async () => {
    const s = await setup();
    const r = await seedAroundWindow(s);
    expect(await ids(s, { until })).toEqual([r.atUntil, r.inside, r.atSince, r.beforeSince]);
  });

  it('combines the window with the workspace filter', async () => {
    const s = await setup();
    const r = await seedAroundWindow(s);
    expect(await ids(s, { since, until, workspaceId: s.workspaceA })).toEqual([
      r.atUntil,
      r.atSince,
    ]);
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
      platformCtx(s.superAdmin),
    );
    const filtered = kinds.filter(
      (k) => k === 'alpha.event' || k === 'zeta.event',
    );
    expect(filtered).toEqual(['alpha.event', 'zeta.event']);
  });

  it('rejects non-super-admin', async () => {
    const s = await setup();
    await expect(
      distinctAuditKindsAcross(smuggled(ctx(s.workspaceA, s.ownerA))),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
