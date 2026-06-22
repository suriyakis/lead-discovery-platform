import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@/lib/connectors/mock'; // also self-imports internet-search via the side-effect chain
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { connectorRunLogs, sourceRecords } from '@/lib/db/schema/connectors';
import { usageLog } from '@/lib/db/schema/audit';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import {
  createConnector,
  createRecipe,
  startRun,
} from '@/lib/services/connector-run';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

/** Tags translateText output with the target code parsed from the system
 *  prompt (e.g. "[HE] ...") so query translation is observable. */
const taggingAi: IAIProvider = {
  id: 'stub',
  model: 'stub-model',
  async generateText() {
    throw new Error('generateText not used here');
  },
  async generateJson(input) {
    const m = (input.system ?? '').match(/natural .+ \(([a-z]{2})\)/);
    const tgt = m?.[1] ?? 'en';
    return { translatedText: `[${tgt.toUpperCase()}] ${input.prompt}` } as never;
  },
  estimateCost() {
    return 0;
  },
  async healthCheck() {
    return { ok: true };
  },
};

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB };
}

function ctx(workspaceId: bigint, userId: string): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role: 'owner' });
}

async function makeIsRun(
  s: Setup,
  recipeOverrides: Record<string, unknown>,
) {
  const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
    templateType: 'internet_search',
    name: 'IS',
    config: {},
  });
  const r = await createRecipe(ctx(s.workspaceA, s.ownerA), {
    connectorId: c.id,
    name: 'r1',
    selectors: recipeOverrides,
  });
  return { connector: c, recipe: r };
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  _setAIProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

// ---- happy path -------------------------------------------------------

describe('internet_search connector — happy path', () => {
  it('runs queries via the mock search provider and produces source records', async () => {
    const s = await setup();
    const { connector, recipe } = await makeIsRun(s, {
      searchQueries: ['acoustic glass', 'fire-rated facade'],
      maxResults: 3,
    });
    const { run, result } = await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: connector.id,
      recipeId: recipe.id,
        wait: true,
      });
    expect(result!.status).toBe('succeeded');
    // 2 queries × 3 results each = 6 records.
    expect(result!.recordCount).toBe(6);
    expect(run.recordCount).toBe(6);

    const recs = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.workspaceId, s.workspaceA));
    expect(recs).toHaveLength(6);
    // Verify normalized shape.
    expect(recs[0]?.normalizedData).toMatchObject({
      url: expect.any(String),
      title: expect.any(String),
      domain: expect.any(String),
      query: expect.any(String),
      rank: expect.any(Number),
    });
  });

  it('emits a usage_log entry per query, marked keySource=mock', async () => {
    const s = await setup();
    const { connector, recipe } = await makeIsRun(s, {
      searchQueries: ['q1', 'q2', 'q3'],
      maxResults: 2,
    });
    await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: connector.id,
      recipeId: recipe.id,
        wait: true,
      });
    const usage = await db
      .select()
      .from(usageLog)
      .where(eq(usageLog.workspaceId, s.workspaceA));
    expect(usage).toHaveLength(3);
    for (const row of usage) {
      expect(row.kind).toBe('search.query');
      expect(row.provider).toBe('mock');
      expect((row.payload as { keySource: string }).keySource).toBe('mock');
    }
  });

  it('logs a starting + complete message', async () => {
    const s = await setup();
    const { connector, recipe } = await makeIsRun(s, {
      searchQueries: ['q'],
      maxResults: 1,
    });
    const { run } = await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: connector.id,
      recipeId: recipe.id,
        wait: true,
      });
    const logs = await db
      .select()
      .from(connectorRunLogs)
      .where(eq(connectorRunLogs.runId, run.id));
    const messages = logs.map((l) => l.message);
    expect(messages.some((m) => m.includes('starting'))).toBe(true);
    expect(messages.some((m) => m.includes('complete'))).toBe(true);
  });
});

// ---- query translation (Flow A for discovery, save-time) -------------
//
// Translation happens when the recipe is SAVED (createRecipe/updateRecipe),
// storing selectors.searchQueriesIssued; the connector then issues those.
// We assert the save-time behaviour directly (no startRun) so these cases
// don't spin up the autopilot after-crawl hook.

describe('internet_search recipe — query translation (save-time)', () => {
  async function makeRecipe(s: Setup, selectors: Record<string, unknown>) {
    const c = await createConnector(ctx(s.workspaceA, s.ownerA), {
      templateType: 'internet_search',
      name: 'IS',
      config: {},
    });
    return createRecipe(ctx(s.workspaceA, s.ownerA), {
      connectorId: c.id,
      name: 'r1',
      selectors,
    });
  }

  it('stores queries translated into the search language as searchQueriesIssued', async () => {
    const s = await setup();
    // Workspace native defaults to English; recipe targets Hebrew.
    _setAIProviderForTests(taggingAi);
    const recipe = await makeRecipe(s, {
      searchQueries: ['concrete waterproofing'],
      language: 'he',
      maxResults: 2,
    });
    const sel = recipe.selectors as {
      searchQueries: string[];
      searchQueriesIssued?: string[];
    };
    // Issued queries are Hebrew; the operator's native queries are preserved.
    expect(sel.searchQueriesIssued?.[0]).toContain('[HE]');
    expect(sel.searchQueries[0]).toBe('concrete waterproofing');
  });

  it('stores no issued queries when the search language equals the native language', async () => {
    const s = await setup();
    _setAIProviderForTests(taggingAi);
    const recipe = await makeRecipe(s, {
      searchQueries: ['concrete waterproofing'],
      language: 'en', // == workspace native → no translation
      maxResults: 1,
    });
    const sel = recipe.selectors as { searchQueriesIssued?: string[] };
    expect(sel.searchQueriesIssued).toBeUndefined();
  });

  it('stores no issued queries when no search language is set', async () => {
    const s = await setup();
    _setAIProviderForTests(taggingAi);
    const recipe = await makeRecipe(s, {
      searchQueries: ['concrete waterproofing'],
      maxResults: 1,
    });
    const sel = recipe.selectors as { searchQueriesIssued?: string[] };
    expect(sel.searchQueriesIssued).toBeUndefined();
  });
});

// ---- recipe validation -----------------------------------------------

describe('internet_search connector — recipe validation', () => {
  it('fails the run when searchQueries is missing', async () => {
    const s = await setup();
    const { connector, recipe } = await makeIsRun(s, { foo: 'bar' });
    const { result } = await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: connector.id,
      recipeId: recipe.id,
        wait: true,
      });
    expect(result!.status).toBe('failed');
    expect(result!.error?.message).toContain('searchQueries');
  });

  it('fails when searchQueries is empty array', async () => {
    const s = await setup();
    const { connector, recipe } = await makeIsRun(s, { searchQueries: [] });
    const { result } = await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: connector.id,
      recipeId: recipe.id,
        wait: true,
      });
    expect(result!.status).toBe('failed');
  });
});

// ---- workspace isolation ---------------------------------------------

describe('internet_search connector — isolation', () => {
  it('source records and usage are scoped to workspace A only', async () => {
    const s = await setup();
    const { connector, recipe } = await makeIsRun(s, {
      searchQueries: ['x'],
      maxResults: 2,
    });
    await startRun(ctx(s.workspaceA, s.ownerA), {
      connectorId: connector.id,
      recipeId: recipe.id,
        wait: true,
      });

    const recsB = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.workspaceId, s.workspaceB));
    const usageB = await db
      .select()
      .from(usageLog)
      .where(eq(usageLog.workspaceId, s.workspaceB));
    expect(recsB).toHaveLength(0);
    expect(usageB).toHaveLength(0);
  });
});
