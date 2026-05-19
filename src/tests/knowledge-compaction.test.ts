import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { _setAIProviderForTests, type IAIProvider } from '@/lib/ai';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { learningLessons } from '@/lib/db/schema/learning';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import { createLesson } from '@/lib/services/learning';
import {
  KnowledgeCompactionError,
  compactWorkspaceKnowledge,
} from '@/lib/services/knowledge-compaction';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  viewerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const viewerA = await seedUser({ email: 'viewerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({
    name: 'A',
    ownerUserId: ownerA,
    extraMembers: [{ userId: viewerA, role: 'viewer' }],
  });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, viewerA, ownerB };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'],
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

function stubAi(
  decide: (cluster: string) => {
    action: 'merge' | 'keep_all';
    survivorIndex?: number;
    consolidatedRule?: string;
    retireIndices?: number[];
  },
): IAIProvider {
  return {
    id: 'stub-ai',
    model: 'stub-model',
    async generateText() {
      return { text: '', model: 'stub', usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async generateJson(input, schema) {
      return schema.parse(decide(input.prompt));
    },
    estimateCost() {
      return 0;
    },
    async healthCheck() {
      return { ok: true };
    },
  };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  _setAIProviderForTests(null);
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

describe('compactWorkspaceKnowledge', () => {
  it('rejects non-admins', async () => {
    const s = await setup();
    _setAIProviderForTests(stubAi(() => ({ action: 'keep_all' })));
    await expect(
      compactWorkspaceKnowledge(ctx(s.workspaceA, s.viewerA, 'viewer')),
    ).rejects.toBeInstanceOf(KnowledgeCompactionError);
  });

  it('merges a duplicate cluster: survivor updated, others disabled, evidence unioned', async () => {
    const s = await setup();
    // Two near-duplicate lessons in the same (productProfile=null, category).
    const l1 = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'sector_preference',
      rule: 'Avoid public-sector schools.',
      confidence: 70,
    });
    const l2 = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'sector_preference',
      rule: 'Skip schools that are public-sector.',
      confidence: 60,
    });
    // Seed evidence_event_ids manually so we can verify the union.
    await db
      .update(learningLessons)
      .set({ evidenceEventIds: [101n, 102n] })
      .where(eq(learningLessons.id, l1.id));
    await db
      .update(learningLessons)
      .set({ evidenceEventIds: [201n] })
      .where(eq(learningLessons.id, l2.id));

    _setAIProviderForTests(
      stubAi(() => ({
        action: 'merge',
        survivorIndex: 0,
        consolidatedRule: 'Avoid public-sector schools (covers all variants).',
        retireIndices: [1],
      })),
    );

    const summary = await compactWorkspaceKnowledge(
      ctx(s.workspaceA, s.ownerA, 'owner'),
    );
    expect(summary.mergedClusters).toBe(1);
    expect(summary.retiredMergedCount).toBe(1);

    const refreshed = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.workspaceId, s.workspaceA));
    const surv = refreshed.find((r) => r.id === l1.id);
    const ret = refreshed.find((r) => r.id === l2.id);
    expect(surv?.rule).toContain('covers all variants');
    expect(surv?.enabled).toBe(true);
    expect(ret?.enabled).toBe(false); // retired (disabled, not deleted)
    expect(surv?.evidenceEventIds.map((b) => b.toString()).sort()).toEqual(
      ['101', '102', '201'].sort(),
    );
  });

  it('keeps everything when the AI says keep_all', async () => {
    const s = await setup();
    const l1 = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'sector_preference',
      rule: 'Avoid construction in winter.',
      confidence: 70,
    });
    const l2 = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'sector_preference',
      rule: 'Target hospitality in summer.',
      confidence: 70,
    });
    _setAIProviderForTests(stubAi(() => ({ action: 'keep_all' })));

    const summary = await compactWorkspaceKnowledge(
      ctx(s.workspaceA, s.ownerA, 'owner'),
    );
    expect(summary.keptClusters).toBe(1);
    expect(summary.retiredMergedCount).toBe(0);

    const rows = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.workspaceId, s.workspaceA));
    expect(rows.every((r) => r.enabled)).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual([l1.id, l2.id].sort());
  });

  it('does not touch lessons in other workspaces', async () => {
    const s = await setup();
    // Two near-dupes in A, one lone lesson in B with identical wording.
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'sector_preference',
      rule: 'Avoid X.',
      confidence: 70,
    });
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'sector_preference',
      rule: 'Skip X.',
      confidence: 70,
    });
    const bLesson = await createLesson(ctx(s.workspaceB, s.ownerB, 'owner'), {
      category: 'sector_preference',
      rule: 'Avoid X.',
      confidence: 70,
    });
    _setAIProviderForTests(
      stubAi(() => ({
        action: 'merge',
        survivorIndex: 0,
        consolidatedRule: 'Avoid X (merged).',
        retireIndices: [1],
      })),
    );

    await compactWorkspaceKnowledge(ctx(s.workspaceA, s.ownerA, 'owner'));

    const bRows = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.workspaceId, s.workspaceB));
    expect(bRows).toHaveLength(1);
    expect(bRows[0]?.id).toBe(bLesson.id);
    expect(bRows[0]?.enabled).toBe(true);
    expect(bRows[0]?.rule).toBe('Avoid X.'); // untouched
  });

  it('emits a knowledge.compaction.run audit row with the summary', async () => {
    const s = await setup();
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'sector_preference',
      rule: 'a',
      confidence: 70,
    });
    _setAIProviderForTests(stubAi(() => ({ action: 'keep_all' })));

    await compactWorkspaceKnowledge(ctx(s.workspaceA, s.ownerA, 'owner'));

    const runRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'knowledge.compaction.run'));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.workspaceId).toBe(s.workspaceA);
  });

  it('skips singleton clusters', async () => {
    const s = await setup();
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'sector_preference',
      rule: 'lonely',
      confidence: 70,
    });
    let called = false;
    _setAIProviderForTests(
      stubAi(() => {
        called = true;
        return { action: 'keep_all' };
      }),
    );

    const summary = await compactWorkspaceKnowledge(
      ctx(s.workspaceA, s.ownerA, 'owner'),
    );
    expect(called).toBe(false);
    expect(summary.skippedSingletons).toBe(1);
  });
});
