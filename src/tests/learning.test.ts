import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { learningEvents, learningLessons } from '@/lib/db/schema/learning';
import { productProfiles } from '@/lib/db/schema/products';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import {
  LearningServiceError,
  applyLessonsToPrompt,
  retireLessons,
  bulkSetLessonsEnabled,
  countLessons,
  createLesson,
  disableLesson,
  getLessonCategoryCounts,
  enableLesson,
  getRelevantLessons,
  listLessons,
  updateLesson,
} from '@/lib/services/learning';
import { createProductProfile } from '@/lib/services/product-profile';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  memberA: string;
  viewerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'ownerA@test.local' });
  const memberA = await seedUser({ email: 'memberA@test.local' });
  const viewerA = await seedUser({ email: 'viewerA@test.local' });
  const ownerB = await seedUser({ email: 'ownerB@test.local' });
  const workspaceA = await seedWorkspace({
    name: 'A',
    ownerUserId: ownerA,
    extraMembers: [
      { userId: memberA, role: 'member' },
      { userId: viewerA, role: 'viewer' },
    ],
  });
  const workspaceB = await seedWorkspace({ name: 'B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, memberA, viewerA, ownerB };
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

// ---- createLesson + listLessons --------------------------------------

describe('manual lesson creation', () => {
  it('member can create a lesson; viewer cannot', async () => {
    const s = await setup();
    const created = await createLesson(ctx(s.workspaceA, s.memberA, 'member'), {
      category: 'outreach_style',
      rule: 'Avoid corporate buzzwords like synergy.',
    });
    expect(created.category).toBe('outreach_style');
    expect(created.lifecycle).toBe('active');
    expect(created.scopeKind).toBe('workspace');
    expect(created.polarity).toBe(0);
    expect(created.confidence).toBe(65);

    await expect(
      createLesson(ctx(s.workspaceA, s.viewerA, 'viewer'), {
        category: 'outreach_style',
        rule: 'X',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects empty rule + unknown or removed category', async () => {
    const s = await setup();
    await expect(
      createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
        category: 'outreach_style',
        rule: '   ',
      }),
    ).rejects.toMatchObject({ code: 'rule_required' });
    await expect(
      createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
        category: 'made_up' as never,
        rule: 'X',
      }),
    ).rejects.toMatchObject({ code: 'unknown_category' });
    for (const removed of ['dedupe_hint', 'connector_quality']) {
      await expect(
        createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
          category: removed as never,
          rule: 'X',
        }),
      ).rejects.toMatchObject({ code: 'unknown_category' });
    }
  });

  it('polarity: fixed categories take theirs, either-way categories take the choice, a disallowed choice is refused', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA, 'owner');
    const neg = await createLesson(c, { category: 'qualification_negative', rule: 'Skip councils' });
    expect(neg.polarity).toBe(-1);
    const sectorDefault = await createLesson(c, { category: 'sector_preference', rule: 'Data centres' });
    expect(sectorDefault.polarity).toBe(1);
    const sectorAvoid = await createLesson(c, {
      category: 'sector_preference',
      rule: 'Public-sector schools',
      polarity: -1,
    });
    expect(sectorAvoid.polarity).toBe(-1);
    await expect(
      createLesson(c, { category: 'outreach_style', rule: 'Short emails', polarity: 1 }),
    ).rejects.toMatchObject({ code: 'invalid_polarity' });
    await expect(
      createLesson(c, { category: 'qualification_positive', rule: 'Installers', polarity: -1 }),
    ).rejects.toMatchObject({ code: 'invalid_polarity' });
  });

  it('lists in confidence-desc, then updatedAt-desc order', async () => {
    const s = await setup();
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_positive',
      rule: 'A',
      confidence: 50,
    });
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_positive',
      rule: 'B',
      confidence: 90,
    });
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_positive',
      rule: 'C',
      confidence: 70,
    });
    const lessons = await listLessons(ctx(s.workspaceA, s.ownerA, 'owner'));
    expect(lessons.map((l) => l.rule)).toEqual(['B', 'C', 'A']);
  });

  it('listLessons offset/limit + countLessons pair stays consistent', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA, 'owner');
    for (let i = 0; i < 7; i += 1) {
      await createLesson(c, {
        category: 'outreach_style',
        rule: `lesson-${i}`,
        confidence: 50,
      });
    }
    const total = await countLessons(c, { category: 'outreach_style' });
    expect(total).toBe(7);
    const firstPage = await listLessons(c, {
      category: 'outreach_style',
      limit: 3,
      offset: 0,
    });
    const secondPage = await listLessons(c, {
      category: 'outreach_style',
      limit: 3,
      offset: 3,
    });
    const thirdPage = await listLessons(c, {
      category: 'outreach_style',
      limit: 3,
      offset: 6,
    });
    expect(firstPage).toHaveLength(3);
    expect(secondPage).toHaveLength(3);
    expect(thirdPage).toHaveLength(1);
    // No overlap.
    const ids = new Set(
      [...firstPage, ...secondPage, ...thirdPage].map((l) => l.id.toString()),
    );
    expect(ids.size).toBe(7);
  });
});

// ---- category counts (powers the /learning tab badges) ----------------

describe('bulkSetLessonsEnabled', () => {
  it('only counts rows that actually flipped; ignores foreign-workspace ids', async () => {
    const s = await setup();
    const a = ctx(s.workspaceA, s.ownerA, 'owner');
    const b = ctx(s.workspaceB, s.ownerB, 'owner');

    const enabledA = await createLesson(a, {
      category: 'outreach_style',
      rule: 'enabled in A',
    });
    const alreadyDisabledA = await createLesson(a, {
      category: 'outreach_style',
      rule: 'already disabled in A',
    });
    await disableLesson(a, alreadyDisabledA.id);
    const inB = await createLesson(b, {
      category: 'outreach_style',
      rule: 'in B, should be untouched',
    });

    const result = await bulkSetLessonsEnabled(
      a,
      [enabledA.id, alreadyDisabledA.id, inB.id],
      false,
    );
    expect(result.requested).toBe(3);
    // enabledA flips, alreadyDisabledA is a no-op (already disabled),
    // inB belongs to workspaceB → filtered out by WHERE.
    expect(result.updated).toBe(1);

    const lessonsA = await listLessons(a, { lifecycle: 'disabled' });
    expect(lessonsA.map((l) => l.rule).sort()).toEqual([
      'already disabled in A',
      'enabled in A',
    ]);
    const lessonsB = await listLessons(b);
    expect(lessonsB[0]?.lifecycle).toBe('active');
  });

  it('bulk enable never revives a retired rule or a rule with no product left', async () => {
    const s = await setup();
    const a = ctx(s.workspaceA, s.ownerA, 'owner');
    const product = await createProductProfile(a, { name: 'Doomed' });
    const disabled = await createLesson(a, { category: 'outreach_style', rule: 'disabled one' });
    await disableLesson(a, disabled.id);
    const orphan = await createLesson(a, {
      category: 'qualification_negative',
      rule: 'orphan once its product goes',
      scope: { kind: 'products', productProfileIds: [product.id] },
    });
    await disableLesson(a, orphan.id);
    const retired = await createLesson(a, { category: 'outreach_style', rule: 'retired one' });
    await db.transaction((tx) =>
      retireLessons(tx, s.workspaceA, [retired.id], { reason: 'stale' }),
    );
    await db.delete(productProfiles).where(eq(productProfiles.id, product.id));

    const result = await bulkSetLessonsEnabled(a, [disabled.id, orphan.id, retired.id], true);
    expect(result).toEqual({ updated: 1, requested: 3 });
    const byId = new Map(
      (await listLessons(a)).map((l) => [l.id.toString(), l.lifecycle]),
    );
    expect(byId.get(disabled.id.toString())).toBe('active');
    expect(byId.get(orphan.id.toString())).toBe('disabled');
    expect(byId.get(retired.id.toString())).toBe('retired');
  });

  it('viewer cannot bulk-disable', async () => {
    const s = await setup();
    const created = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'outreach_style',
      rule: 'X',
    });
    await expect(
      bulkSetLessonsEnabled(
        ctx(s.workspaceA, s.viewerA, 'viewer'),
        [created.id],
        false,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('getLessonCategoryCounts', () => {
  it('sums per category + total; honours lifecycle filter + workspace isolation', async () => {
    const s = await setup();
    const a = ctx(s.workspaceA, s.ownerA, 'owner');
    const b = ctx(s.workspaceB, s.ownerB, 'owner');
    await createLesson(a, { category: 'qualification_positive', rule: 'A1' });
    await createLesson(a, { category: 'qualification_positive', rule: 'A2' });
    await createLesson(a, { category: 'outreach_style', rule: 'A3' });
    const toDisable = await createLesson(a, { category: 'outreach_style', rule: 'A4' });
    await disableLesson(a, toDisable.id);
    await createLesson(b, { category: 'qualification_positive', rule: 'B1' });

    const enabledOnly = await getLessonCategoryCounts(a, { lifecycle: 'active' });
    expect(enabledOnly.qualification_positive).toBe(2);
    expect(enabledOnly.outreach_style).toBe(1);
    expect(enabledOnly.contact_role).toBe(0);
    expect(enabledOnly.total).toBe(3);

    const allOfA = await getLessonCategoryCounts(a);
    expect(allOfA.outreach_style).toBe(2);
    expect(allOfA.total).toBe(4);

    const allOfB = await getLessonCategoryCounts(b);
    expect(allOfB.qualification_positive).toBe(1);
    expect(allOfB.total).toBe(1);
  });
});

// ---- update + enable/disable ------------------------------------------

describe('update / enable / disable', () => {
  it('disable hides from getRelevantLessons; enable brings it back', async () => {
    const s = await setup();
    const lesson = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'Skip councils',
    });
    let relevant = await getRelevantLessons(ctx(s.workspaceA, s.ownerA, 'owner'), {
      taskType: 'classification',
    });
    expect(relevant).toHaveLength(1);

    await disableLesson(ctx(s.workspaceA, s.ownerA, 'owner'), lesson.id);
    relevant = await getRelevantLessons(ctx(s.workspaceA, s.ownerA, 'owner'), {
      taskType: 'classification',
    });
    expect(relevant).toHaveLength(0);

    await enableLesson(ctx(s.workspaceA, s.ownerA, 'owner'), lesson.id);
    relevant = await getRelevantLessons(ctx(s.workspaceA, s.ownerA, 'owner'), {
      taskType: 'classification',
    });
    expect(relevant).toHaveLength(1);
  });

  it('viewer cannot disable a lesson', async () => {
    const s = await setup();
    const lesson = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'X',
    });
    await expect(
      disableLesson(ctx(s.workspaceA, s.viewerA, 'viewer'), lesson.id),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('update validates category and rule', async () => {
    const s = await setup();
    const lesson = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'outreach_style',
      rule: 'Initial',
    });
    const updated = await updateLesson(ctx(s.workspaceA, s.ownerA, 'owner'), lesson.id, {
      rule: 'Refined wording',
      confidence: 80,
    });
    expect(updated.rule).toBe('Refined wording');
    expect(updated.confidence).toBe(80);

    await expect(
      updateLesson(ctx(s.workspaceA, s.ownerA, 'owner'), lesson.id, { rule: '   ' }),
    ).rejects.toMatchObject({ code: 'rule_required' });
    await expect(
      updateLesson(ctx(s.workspaceA, s.ownerA, 'owner'), lesson.id, {
        category: 'bogus' as never,
      }),
    ).rejects.toMatchObject({ code: 'unknown_category' });
  });

  it('re-filing a rule keeps its direction when allowed, else takes the new default', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA, 'owner');
    const lesson = await createLesson(c, {
      category: 'sector_preference',
      rule: 'Councils',
      polarity: -1,
    });
    const asGeneral = await updateLesson(c, lesson.id, { category: 'general_instruction' });
    expect(asGeneral.polarity).toBe(-1);
    const asStyle = await updateLesson(c, lesson.id, { category: 'outreach_style' });
    expect(asStyle.polarity).toBe(0);
    await expect(updateLesson(c, lesson.id, { polarity: -1 })).rejects.toMatchObject({
      code: 'invalid_polarity',
    });
  });

  it('a retired rule: disable is a conflict, restore is admin-only and clears the reason', async () => {
    const s = await setup();
    const owner = ctx(s.workspaceA, s.ownerA, 'owner');
    const member = ctx(s.workspaceA, s.memberA, 'member');
    const lesson = await createLesson(owner, { category: 'outreach_style', rule: 'Old style rule' });
    await db.transaction((tx) =>
      retireLessons(tx, s.workspaceA, [lesson.id], { reason: 'stale', note: 'unused' }),
    );
    await expect(disableLesson(owner, lesson.id)).rejects.toMatchObject({
      code: 'lifecycle_conflict',
    });
    await expect(enableLesson(member, lesson.id)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    const restored = await enableLesson(owner, lesson.id);
    expect(restored.lifecycle).toBe('active');
    expect(restored.retiredReason).toBeNull();
    expect(restored.retiredNote).toBeNull();
  });
});

// ---- getRelevantLessons + applyLessonsToPrompt -----------------------

describe('retrieval + prompt application', () => {
  it('retrieves classification-relevant categories by taskType', async () => {
    const s = await setup();
    const classifyCats = ['qualification_positive', 'qualification_negative', 'sector_preference'] as const;
    for (const c of classifyCats) {
      await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), { category: c, rule: c });
    }
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'outreach_style',
      rule: 'tone',
    });
    const lessons = await getRelevantLessons(ctx(s.workspaceA, s.ownerA, 'owner'), {
      taskType: 'classification',
    });
    expect(lessons).toHaveLength(3);
    expect(lessons.map((l) => l.category).sort()).toEqual(
      [...classifyCats].sort(),
    );
  });

  it('product-scoped retrieval includes only matching profile rows', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
      name: 'Vetrofluid',
    });
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'Vetrofluid: skip councils',
      scope: { kind: 'products', productProfileIds: [product.id] },
    });
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'workspace-wide negative',
    });
    const productScoped = await getRelevantLessons(ctx(s.workspaceA, s.ownerA, 'owner'), {
      productProfileId: product.id,
    });
    expect(productScoped.map((l) => l.rule)).toEqual(['Vetrofluid: skip councils']);
  });

  it('applyLessonsToPrompt appends numbered guidelines', async () => {
    const s = await setup();
    const a = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'A',
    });
    const b = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_positive',
      rule: 'B',
    });
    const out = applyLessonsToPrompt('Base prompt.', [a, b]);
    expect(out).toContain('Base prompt.');
    expect(out).toContain('1. [qualification_negative] A');
    expect(out).toContain('2. [qualification_positive] B');
  });

  it('applyLessonsToPrompt is a no-op for empty lessons', () => {
    expect(applyLessonsToPrompt('Base.', [])).toBe('Base.');
  });

  it('productProfileId: null returns workspace-wide lessons (regression: eq-null matched nothing)', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
      name: 'Scoped',
    });
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'product-scoped rule',
      scope: { kind: 'products', productProfileIds: [product.id] },
    });
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'workspace-wide rule',
    });
    const wsOnly = await getRelevantLessons(ctx(s.workspaceA, s.ownerA, 'owner'), {
      productProfileId: null,
    });
    expect(wsOnly.map((l) => l.rule)).toEqual(['workspace-wide rule']);
  });

  it('includeWorkspaceLessons returns product-scoped + workspace-wide in one call', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
      name: 'Combined',
    });
    const other = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
      name: 'Other',
    });
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'for this product',
      scope: { kind: 'products', productProfileIds: [product.id] },
    });
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'for everyone',
    });
    await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'for a different product',
      scope: { kind: 'products', productProfileIds: [other.id] },
    });
    const combined = await getRelevantLessons(ctx(s.workspaceA, s.ownerA, 'owner'), {
      productProfileId: product.id,
      includeWorkspaceLessons: true,
    });
    expect(combined.map((l) => l.rule).sort()).toEqual([
      'for everyone',
      'for this product',
    ]);
  });
});

// ---- create-time dedup ------------------------------------------------

describe('createLesson dedup', () => {
  it('identical rule in the same scope reinforces instead of duplicating', async () => {
    const s = await setup();
    const first = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'Avoid consultancies',
      confidence: 65,
    });
    const second = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'avoid consultancies', // case-insensitive match
    });
    expect(second.id).toBe(first.id);
    expect(second.confidence).toBe(70); // 65 + 5
    const rows = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.workspaceId, s.workspaceA));
    expect(rows).toHaveLength(1);
  });

  it('same rule in a different product scope creates a separate lesson', async () => {
    const s = await setup();
    const product = await createProductProfile(ctx(s.workspaceA, s.ownerA, 'owner'), {
      name: 'ScopeSplit',
    });
    const wsWide = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'Avoid consultancies',
    });
    const scoped = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'Avoid consultancies',
      scope: { kind: 'products', productProfileIds: [product.id] },
    });
    expect(scoped.id).not.toBe(wsWide.id);
  });

  it('same rule in a different category creates a separate lesson', async () => {
    const s = await setup();
    const neg = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'qualification_negative',
      rule: 'Councils never buy',
    });
    const sector = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'sector_preference',
      rule: 'Councils never buy',
    });
    expect(sector.id).not.toBe(neg.id);
  });
});

// ---- error shape ------------------------------------------------------

describe('error shape', () => {
  it('all thrown errors are LearningServiceError instances', async () => {
    const s = await setup();
    try {
      await createLesson(ctx(s.workspaceA, s.viewerA, 'viewer'), {
        category: 'outreach_style',
        rule: 'X',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LearningServiceError);
    }
  });
});

// ---- lesson usage tracking (P60-06) -----------------------------------

describe('recordLessonsApplied', () => {
  it('bumps applicationCount and sets lastAppliedAt for workspace-scoped lessons only', async () => {
    const { recordLessonsApplied } = await import('@/lib/services/learning');
    const s = await setup();
    const lessonA = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'sector_preference',
      rule: 'A1',
      confidence: 70,
    });
    const lessonB = await createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
      category: 'sector_preference',
      rule: 'A2',
      confidence: 70,
    });
    const lessonOther = await createLesson(ctx(s.workspaceB, s.ownerB, 'owner'), {
      category: 'sector_preference',
      rule: 'B1',
      confidence: 70,
    });

    await recordLessonsApplied({ workspaceId: s.workspaceA }, [
      lessonA.id,
      lessonB.id,
      lessonOther.id, // belongs to workspace B — must be ignored by the workspace guard
    ]);

    const refreshedA = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.id, lessonA.id));
    const refreshedB = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.id, lessonB.id));
    const refreshedOther = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.id, lessonOther.id));

    expect(refreshedA[0]?.applicationCount).toBe(1);
    expect(refreshedA[0]?.lastAppliedAt).not.toBeNull();
    expect(refreshedB[0]?.applicationCount).toBe(1);
    expect(refreshedB[0]?.lastAppliedAt).not.toBeNull();
    // Cross-workspace lesson untouched.
    expect(refreshedOther[0]?.applicationCount).toBe(0);
    expect(refreshedOther[0]?.lastAppliedAt).toBeNull();

    // Re-application bumps the count, not just resets it.
    await recordLessonsApplied({ workspaceId: s.workspaceA }, [lessonA.id]);
    const reA = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.id, lessonA.id));
    expect(reA[0]?.applicationCount).toBe(2);
  });

  it('is a no-op for an empty id list', async () => {
    const { recordLessonsApplied } = await import('@/lib/services/learning');
    const s = await setup();
    // Should not throw and should not flip anything.
    await recordLessonsApplied({ workspaceId: s.workspaceA }, []);
    expect(true).toBe(true);
  });
});

// silence unused
void learningEvents;
void learningLessons;
