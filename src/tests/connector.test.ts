import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock'; // self-registers the mock connector
import { db } from '@/lib/db/client';
import {
  connectorRunLogs,
  connectorRuns,
  connectors,
  sourceRecords,
} from '@/lib/db/schema/connectors';
import { eq } from 'drizzle-orm';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import {
  ConnectorServiceError,
  createConnector,
  createRecipe,
  getRun,
  listRunLogs,
  listSourceRecords,
  startRun,
} from '@/lib/services/connector-run';
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

// Helper: full happy path — admin creates a mock connector, manager creates
// a recipe with a seed and count, manager starts the run, returns the run.
async function setupRun(
  s: Setup,
  recipeOverrides: Partial<Record<string, unknown>> = {},
) {
  const c = await createConnector(ctx(s.workspaceA, s.ownerA, 'owner'), {
    templateType: 'mock',
    name: 'Mock 1',
    config: {},
  });
  const recipe = await createRecipe(ctx(s.workspaceA, s.ownerA, 'owner'), {
    connectorId: c.id,
    name: 'recipe-1',
    selectors: { seed: 'happy', count: 4, delayMs: 0, ...recipeOverrides },
  });
  return { connector: c, recipe };
}

// ---- happy path -------------------------------------------------------

describe('connector run — happy path', () => {
  it('startRun executes the mock connector and persists records + logs', async () => {
    const s = await setup();
    const { connector, recipe } = await setupRun(s);

    const { run, result } = await startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
      connectorId: connector.id,
      recipeId: recipe.id,
    });

    expect(result.status).toBe('succeeded');
    expect(result.recordCount).toBe(4);
    expect(run.status).toBe('succeeded');
    expect(run.recordCount).toBe(4);
    expect(run.startedAt).not.toBeNull();
    expect(run.completedAt).not.toBeNull();
    expect(run.errorPayload).toBeNull();

    const records = await listSourceRecords(
      ctx(s.workspaceA, s.ownerA, 'owner'),
      run.id,
    );
    expect(records).toHaveLength(4);
    expect(records[0]?.normalizedData).toBeTruthy();

    const logs = await listRunLogs(ctx(s.workspaceA, s.ownerA, 'owner'), run.id);
    // At minimum: starting log + complete log.
    expect(logs.some((l) => l.message.includes('starting'))).toBe(true);
    expect(logs.some((l) => l.message.includes('complete'))).toBe(true);
  });

  it('runs are deterministic for the same seed', async () => {
    const s = await setup();
    const { connector, recipe } = await setupRun(s, { seed: 'fixed-seed' });

    const r1 = await startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
      connectorId: connector.id,
      recipeId: recipe.id,
    });
    const r2records = await listSourceRecords(
      ctx(s.workspaceA, s.ownerA, 'owner'),
      r1.run.id,
    );

    // Same source_ids — second run with the same seed would dedupe.
    // listSourceRecords orders newest-first; sort to assert the set.
    expect(r2records.map((r) => r.sourceId).sort()).toEqual([
      'mock-fixed-seed-0',
      'mock-fixed-seed-1',
      'mock-fixed-seed-2',
      'mock-fixed-seed-3',
    ]);
  });
});

// ---- dedupe -----------------------------------------------------------

describe('source record dedupe', () => {
  it('a second run with the same seed produces 0 new records (existing rows kept)', async () => {
    const s = await setup();
    const { connector, recipe } = await setupRun(s, { seed: 'dedupe-seed' });

    const first = await startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
      connectorId: connector.id,
      recipeId: recipe.id,
    });
    expect(first.result.recordCount).toBe(4);

    const second = await startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
      connectorId: connector.id,
      recipeId: recipe.id,
    });
    expect(second.result.status).toBe('succeeded');
    // Inserts deduped by (workspace, source_system, source_id).
    expect(second.result.recordCount).toBe(0);

    const total = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.workspaceId, s.workspaceA));
    expect(total).toHaveLength(4);
  });

  it('different seeds produce different dedupe keys', async () => {
    const s = await setup();
    const { connector, recipe: r1 } = await setupRun(s, { seed: 'seed-a' });
    const r2 = await createRecipe(ctx(s.workspaceA, s.ownerA, 'owner'), {
      connectorId: connector.id,
      name: 'recipe-2',
      selectors: { seed: 'seed-b', count: 3, delayMs: 0 },
    });
    await startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
      connectorId: connector.id,
      recipeId: r1.id,
    });
    await startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
      connectorId: connector.id,
      recipeId: r2.id,
    });
    const total = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.workspaceId, s.workspaceA));
    expect(total).toHaveLength(7);
  });
});

// ---- failure ----------------------------------------------------------

describe('failure handling', () => {
  it('fatal error event ends the run as failed', async () => {
    const s = await setup();
    const { connector, recipe } = await setupRun(s, {
      seed: 'fail-test',
      count: 5,
      failAfter: 2,
    });

    const { run, result } = await startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
      connectorId: connector.id,
      recipeId: recipe.id,
    });
    expect(result.status).toBe('failed');
    expect(result.recordCount).toBe(2);
    expect(run.status).toBe('failed');
    expect(run.errorPayload).toMatchObject({ message: expect.stringContaining('synthetic') });
  });
});

// ---- workspace isolation ---------------------------------------------

describe('workspace isolation', () => {
  it('cannot see runs from another workspace', async () => {
    const s = await setup();
    const { connector, recipe } = await setupRun(s);
    const { run } = await startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
      connectorId: connector.id,
      recipeId: recipe.id,
    });

    await expect(getRun(ctx(s.workspaceB, s.ownerB, 'owner'), run.id)).rejects.toMatchObject(
      { code: 'not_found' },
    );
  });

  it('source records do not leak across workspaces', async () => {
    const s = await setup();
    const { connector, recipe } = await setupRun(s);
    const { run } = await startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
      connectorId: connector.id,
      recipeId: recipe.id,
    });

    await expect(
      listSourceRecords(ctx(s.workspaceB, s.ownerB, 'owner'), run.id),
    ).rejects.toMatchObject({ code: 'not_found' });

    const recordsA = await listSourceRecords(ctx(s.workspaceA, s.ownerA, 'owner'), run.id);
    expect(recordsA.length).toBeGreaterThan(0);
  });
});

// ---- role gates -------------------------------------------------------

describe('role gates', () => {
  it('viewer cannot create a connector', async () => {
    const s = await setup();
    await expect(
      createConnector(ctx(s.workspaceA, s.viewerA, 'viewer'), {
        templateType: 'mock',
        name: 'X',
        config: {},
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('manager cannot create a connector', async () => {
    const s = await setup();
    await expect(
      createConnector(ctx(s.workspaceA, s.managerA, 'manager'), {
        templateType: 'mock',
        name: 'X',
        config: {},
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('admin can create a connector', async () => {
    const s = await setup();
    const c = await createConnector(ctx(s.workspaceA, s.adminA, 'admin'), {
      templateType: 'mock',
      name: 'X',
      config: {},
    });
    expect(c.id).toBeTruthy();
  });

  it('viewer cannot start a run', async () => {
    const s = await setup();
    const { connector, recipe } = await setupRun(s);
    await expect(
      startRun(ctx(s.workspaceA, s.viewerA, 'viewer'), {
        connectorId: connector.id,
        recipeId: recipe.id,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('member can start a run', async () => {
    const s = await setup();
    const { connector, recipe } = await setupRun(s);
    const { result } = await startRun(ctx(s.workspaceA, s.memberA, 'member'), {
      connectorId: connector.id,
      recipeId: recipe.id,
    });
    expect(result.status).toBe('succeeded');
  });
});

// ---- audit ------------------------------------------------------------

describe('audit + logging', () => {
  it('startRun emits start and complete audit events', async () => {
    const s = await setup();
    const { connector, recipe } = await setupRun(s);
    await startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
      connectorId: connector.id,
      recipeId: recipe.id,
    });
    const events = await db
      .select()
      .from((await import('@/lib/db/schema/audit')).auditLog)
      .where(eq((await import('@/lib/db/schema/audit')).auditLog.workspaceId, s.workspaceA));
    const kinds = events.map((e) => e.kind).sort();
    expect(kinds).toEqual(
      [
        'connector.create',
        'connector_recipe.create',
        'connector_run.complete',
        'connector_run.start',
      ].sort(),
    );
  });

  it('rejects start when connector is inactive', async () => {
    const s = await setup();
    const { connector, recipe } = await setupRun(s);
    // Manually flip active=false.
    await db.update(connectors).set({ active: false }).where(eq(connectors.id, connector.id));
    await expect(
      startRun(ctx(s.workspaceA, s.ownerA, 'owner'), {
        connectorId: connector.id,
        recipeId: recipe.id,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

// ---- error shape ------------------------------------------------------

describe('error shape', () => {
  it('all thrown errors are ConnectorServiceError instances', async () => {
    const s = await setup();
    try {
      await createConnector(ctx(s.workspaceA, s.viewerA, 'viewer'), {
        templateType: 'mock',
        name: 'X',
        config: {},
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorServiceError);
    }
  });
});

// Silence unused-import if any
void connectorRuns;
void connectorRunLogs;
