// KL-01 rule scope model (I167, I109).
//
// Acceptance 1: tenant A cannot scope a rule to tenant B's product — the
// composite FK rejects it, and the service answers 'Product not found' for
// a foreign id and for a non-existent id alike.
// Acceptance 2: deleting a product removes its scope rows; a rule scoped
// only to it is returned by no retrieval path, workspace-wide ones included.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { MockEmbeddingProvider, _setEmbeddingProviderForTests } from '@/lib/embeddings';
import { db } from '@/lib/db/client';
import { learningLessons, lessonScopes } from '@/lib/db/schema/learning';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import {
  LearningServiceError,
  countLessons,
  createLesson,
  disableLesson,
  enableLesson,
  findNearDuplicateLesson,
  getLessonScopeProducts,
  getRelevantLessons,
  listLessons,
  updateLesson,
} from '@/lib/services/learning';
import { createProductProfile, deleteProductProfile } from '@/lib/services/product-profile';
import { embedAllLessons, retrieveLessons } from '@/lib/services/rag';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  a: WorkspaceContext;
  b: WorkspaceContext;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'scope-a@test.local' });
  const ownerB = await seedUser({ email: 'scope-b@test.local' });
  const wsA = await seedWorkspace({ name: 'A', ownerUserId: ownerA });
  const wsB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return {
    a: makeWorkspaceContext({ workspaceId: wsA, userId: ownerA, role: 'owner' }),
    b: makeWorkspaceContext({ workspaceId: wsB, userId: ownerB, role: 'owner' }),
  };
}

const products = (...ids: bigint[]) => ({ kind: 'products' as const, productProfileIds: ids });

beforeEach(async () => {
  await truncateAll();
  _setEmbeddingProviderForTests(new MockEmbeddingProvider());
});

afterEach(() => {
  _setEmbeddingProviderForTests(null);
});

afterAll(async () => {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
});

async function pgErrorCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    let cur: unknown = err;
    while (cur && typeof cur === 'object') {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === 'string') return code;
      cur = (cur as { cause?: unknown }).cause;
    }
    return 'unknown';
  }
  return undefined;
}

describe('tenant safety of rule scopes (acceptance 1, I167)', () => {
  it('the composite FK refuses a scope row joining A’s rule to B’s product', async () => {
    const { a, b } = await setup();
    const productB = await createProductProfile(b, { name: 'B product' });
    const lessonA = await createLesson(a, {
      category: 'qualification_negative',
      rule: 'Skip councils',
    });

    // Straight to the table, past every service check: Postgres says no.
    expect(
      await pgErrorCode(
        db.insert(lessonScopes).values({
          lessonId: lessonA.id,
          workspaceId: a.workspaceId,
          productProfileId: productB.id,
        }),
      ),
    ).toBe('23503');
    // Claiming B's workspace instead breaks the lesson side of the FK.
    expect(
      await pgErrorCode(
        db.insert(lessonScopes).values({
          lessonId: lessonA.id,
          workspaceId: b.workspaceId,
          productProfileId: productB.id,
        }),
      ),
    ).toBe('23503');
  });

  it("createLesson answers 'Product not found' for a foreign id and a non-existent id alike, and leaves nothing behind", async () => {
    const { a, b } = await setup();
    const productB = await createProductProfile(b, { name: 'B product' });

    const errors: LearningServiceError[] = [];
    for (const id of [productB.id, 987654321n]) {
      try {
        await createLesson(a, {
          category: 'qualification_negative',
          rule: `Skip councils ${id}`,
          scope: products(id),
        });
        expect.unreachable('scope to a product outside the workspace must fail');
      } catch (err) {
        expect(err).toBeInstanceOf(LearningServiceError);
        errors.push(err as LearningServiceError);
      }
    }
    expect(errors.map((e) => [e.code, e.message])).toEqual([
      ['product_not_found', 'Product not found'],
      ['product_not_found', 'Product not found'],
    ]);
    // The rule insert rolled back with the scope row.
    const rows = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.workspaceId, a.workspaceId));
    expect(rows).toHaveLength(0);
  });

  it('updateLesson cannot re-scope to another tenant’s product; the old scope stays', async () => {
    const { a, b } = await setup();
    const productA = await createProductProfile(a, { name: 'A product' });
    const productB = await createProductProfile(b, { name: 'B product' });
    const lesson = await createLesson(a, {
      category: 'qualification_negative',
      rule: 'Skip councils',
      scope: products(productA.id),
    });

    for (const id of [productB.id, 987654321n]) {
      await expect(updateLesson(a, lesson.id, { scope: products(id) })).rejects.toMatchObject({
        code: 'product_not_found',
        message: 'Product not found',
      });
    }
    const scopes = await getLessonScopeProducts(a, [lesson.id]);
    expect(scopes.get(lesson.id.toString())).toEqual([productA.id]);
  });

  it('a products scope with no product is refused (scope_required)', async () => {
    const { a } = await setup();
    await expect(
      createLesson(a, { category: 'qualification_negative', rule: 'X', scope: products() }),
    ).rejects.toMatchObject({ code: 'scope_required' });
  });

  it('B never sees A’s product-scoped rules, even asking with A’s product id', async () => {
    const { a, b } = await setup();
    const productA = await createProductProfile(a, { name: 'A product' });
    await createLesson(a, {
      category: 'qualification_negative',
      rule: 'Skip councils',
      scope: products(productA.id),
    });
    expect(
      await getRelevantLessons(b, { productProfileId: productA.id, includeWorkspaceLessons: true }),
    ).toEqual([]);
    expect(
      await getLessonScopeProducts(
        b,
        (await listLessons(a)).map((l) => l.id),
      ),
    ).toEqual(new Map());
  });
});

describe('multi-product scope', () => {
  it('a rule scoped to two products reaches both and only them', async () => {
    const { a } = await setup();
    const p = await createProductProfile(a, { name: 'P' });
    const q = await createProductProfile(a, { name: 'Q' });
    const r = await createProductProfile(a, { name: 'R' });
    const lesson = await createLesson(a, {
      category: 'qualification_negative',
      rule: 'Skip councils',
      scope: products(q.id, p.id, p.id),
    });
    expect((await getLessonScopeProducts(a, [lesson.id])).get(lesson.id.toString())).toEqual(
      [p.id, q.id].sort((x, y) => (x < y ? -1 : 1)),
    );
    for (const id of [p.id, q.id]) {
      const got = await getRelevantLessons(a, {
        productProfileId: id,
        includeWorkspaceLessons: true,
      });
      expect(got.map((l) => l.id)).toEqual([lesson.id]);
    }
    expect(
      await getRelevantLessons(a, { productProfileId: r.id, includeWorkspaceLessons: true }),
    ).toEqual([]);
  });

  it('dedup matches only the identical scope set', async () => {
    const { a } = await setup();
    const p = await createProductProfile(a, { name: 'P' });
    const q = await createProductProfile(a, { name: 'Q' });
    const pq = await createLesson(a, {
      category: 'qualification_negative',
      rule: 'Skip councils',
      scope: products(p.id, q.id),
    });
    const onlyP = await createLesson(a, {
      category: 'qualification_negative',
      rule: 'Skip councils',
      scope: products(p.id),
    });
    expect(onlyP.id).not.toBe(pq.id);
    const again = await createLesson(a, {
      category: 'qualification_negative',
      rule: 'skip councils',
      scope: products(q.id, p.id),
    });
    expect(again.id).toBe(pq.id);
    expect(again.confidence).toBe(pq.confidence + 5);
  });
});

describe('task routing through the registry (I038)', () => {
  it("Suggest reply's semantic search reads reply_quality, style and general rules only", async () => {
    const { a } = await setup();
    const reply = await createLesson(a, {
      category: 'reply_quality',
      rule: 'Answer document requests in the same thread.',
    });
    const general = await createLesson(a, {
      category: 'general_instruction',
      rule: 'Answer in the language the prospect wrote in.',
    });
    await createLesson(a, { category: 'qualification_negative', rule: 'Answer nothing to councils.' });
    await embedAllLessons(a);

    const got = await retrieveLessons(a, 'Answer document requests in the same thread.', {
      limit: 10,
      taskType: 'reply',
    });
    expect(got.map((r) => r.lesson.id).sort()).toEqual([reply.id, general.id].sort());
  });

  it('a manual general_instruction reaches both qualification and outreach retrieval', async () => {
    const { a } = await setup();
    const rule = await createLesson(a, {
      category: 'general_instruction',
      rule: 'Skip councils for Vetrofluid offers.',
    });
    for (const taskType of ['classification', 'outreach'] as const) {
      const got = await getRelevantLessons(a, { taskType });
      expect(
        got.map((l) => l.id),
        taskType,
      ).toEqual([rule.id]);
    }
  });
});

describe('product deletion (acceptance 2, I109)', () => {
  it('removes the scope rows; a rule scoped only to the product reaches no retrieval path', async () => {
    const { a } = await setup();
    const doomed = await createProductProfile(a, { name: 'Doomed' });
    const kept = await createProductProfile(a, { name: 'Kept' });
    const onlyDoomed = await createLesson(a, {
      category: 'general_instruction',
      rule: 'Doomed rule: never pitch to councils.',
      scope: products(doomed.id),
    });
    const shared = await createLesson(a, {
      category: 'general_instruction',
      rule: 'Shared rule: mention the warranty.',
      scope: products(doomed.id, kept.id),
    });
    const workspaceWide = await createLesson(a, {
      category: 'general_instruction',
      rule: 'Workspace rule: write in the prospect’s language.',
    });
    await embedAllLessons(a);

    await deleteProductProfile(a, doomed.id);

    // The rule is not hard-deleted any more (it used to cascade away).
    const all = await listLessons(a);
    expect(all.map((l) => l.id).sort()).toEqual(
      [onlyDoomed.id, shared.id, workspaceWide.id].sort(),
    );
    // Scope rows of the deleted product are gone; the shared rule keeps the other one.
    const left = await db
      .select()
      .from(lessonScopes)
      .where(eq(lessonScopes.workspaceId, a.workspaceId));
    expect(left.map((r) => [r.lessonId, r.productProfileId])).toEqual([[shared.id, kept.id]]);

    const ids = (rows: { id: bigint }[]) => rows.map((r) => r.id);
    const notDoomed = (got: bigint[]) => expect(got).not.toContain(onlyDoomed.id);

    // getRelevantLessons — every scope mode and task.
    notDoomed(ids(await getRelevantLessons(a, {})));
    notDoomed(ids(await getRelevantLessons(a, { productProfileId: null })));
    notDoomed(ids(await getRelevantLessons(a, { productProfileId: doomed.id })));
    notDoomed(
      ids(
        await getRelevantLessons(a, { productProfileId: doomed.id, includeWorkspaceLessons: true }),
      ),
    );
    notDoomed(
      ids(
        await getRelevantLessons(a, { productProfileId: kept.id, includeWorkspaceLessons: true }),
      ),
    );
    for (const taskType of ['classification', 'outreach', 'reply'] as const) {
      notDoomed(ids(await getRelevantLessons(a, { taskType })));
      notDoomed(
        ids(
          await getRelevantLessons(a, {
            taskType,
            productProfileId: kept.id,
            includeWorkspaceLessons: true,
            // Exercise the semantic rerank path too.
            contextText: 'councils',
            limit: 1,
          }),
        ),
      );
    }
    expect(
      ids(
        await getRelevantLessons(a, { productProfileId: kept.id, includeWorkspaceLessons: true }),
      ).sort(),
    ).toEqual([shared.id, workspaceWide.id].sort());

    // Semantic lesson search (Suggest reply) — unscoped and scoped.
    const sem = await retrieveLessons(a, 'Doomed rule: never pitch to councils.', { limit: 10 });
    notDoomed(sem.map((r) => r.lesson.id));
    expect(sem.length).toBe(2);
    notDoomed(
      (
        await retrieveLessons(a, 'Doomed rule: never pitch to councils.', {
          limit: 10,
          productProfileId: doomed.id,
        })
      ).map((r) => r.lesson.id),
    );

    // Dedup never matches it, so the same text in a live scope is a new rule.
    expect(
      await findNearDuplicateLesson(a, {
        category: 'general_instruction',
        rule: 'Doomed rule: never pitch to councils.',
        scope: { kind: 'workspace' },
      }),
    ).toBeNull();

    // Bulk embedding skips it; the console still lists it as needing a scope.
    expect((await embedAllLessons(a)).embedded).toBe(2);
    expect(ids(await listLessons(a, { needsScope: true }))).toEqual([onlyDoomed.id]);
    expect(await countLessons(a, { inScopeOnly: true })).toBe(2);
  });

  it('a rule with no product left cannot be switched back on until it gets a scope', async () => {
    const { a } = await setup();
    const doomed = await createProductProfile(a, { name: 'Doomed' });
    const lesson = await createLesson(a, {
      category: 'qualification_negative',
      rule: 'Skip councils',
      scope: products(doomed.id),
    });
    await disableLesson(a, lesson.id);
    await deleteProductProfile(a, doomed.id);

    await expect(enableLesson(a, lesson.id)).rejects.toMatchObject({ code: 'scope_required' });

    const kept = await createProductProfile(a, { name: 'Kept' });
    const rescoped = await updateLesson(a, lesson.id, {
      scope: products(kept.id),
      lifecycle: 'active',
    });
    expect(rescoped.lifecycle).toBe('active');
    const got = await getRelevantLessons(a, { productProfileId: kept.id });
    expect(got.map((l) => l.id)).toEqual([lesson.id]);
  });

  it('re-scoping to all products makes it workspace-wide and drops the scope rows', async () => {
    const { a } = await setup();
    const p = await createProductProfile(a, { name: 'P' });
    const lesson = await createLesson(a, {
      category: 'qualification_negative',
      rule: 'Skip councils',
      scope: products(p.id),
    });
    const updated = await updateLesson(a, lesson.id, { scope: { kind: 'workspace' } });
    expect(updated.scopeKind).toBe('workspace');
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(lessonScopes)
      .where(
        and(eq(lessonScopes.workspaceId, a.workspaceId), eq(lessonScopes.lessonId, lesson.id)),
      );
    expect(rows[0]?.n).toBe(0);
    expect((await getRelevantLessons(a, { productProfileId: null })).map((l) => l.id)).toEqual([
      lesson.id,
    ]);
  });
});
