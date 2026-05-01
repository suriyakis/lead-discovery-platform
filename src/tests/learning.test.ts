import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { learningEvents, learningLessons } from '@/lib/db/schema/learning';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import {
  LearningServiceError,
  applyLessonsToPrompt,
  createLesson,
  disableLesson,
  enableLesson,
  extractLessonHeuristic,
  getRelevantLessons,
  listLessons,
  recordFeedback,
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

// ---- heuristic extractor -------------------------------------------

describe('extractLessonHeuristic', () => {
  it('returns null for empty / too-short input', () => {
    expect(extractLessonHeuristic(null)).toBeNull();
    expect(extractLessonHeuristic('')).toBeNull();
    expect(extractLessonHeuristic('ok')).toBeNull();
  });

  it('catches qualification negatives', () => {
    expect(extractLessonHeuristic("don't target councils")?.category).toBe(
      'qualification_negative',
    );
    expect(extractLessonHeuristic('avoid retail SMBs entirely')?.category).toBe(
      'qualification_negative',
    );
  });

  it('catches qualification positives', () => {
    expect(extractLessonHeuristic('this is the ideal kind of company')?.category).toBe(
      'qualification_positive',
    );
  });

  it('catches false positive / negative', () => {
    expect(
      extractLessonHeuristic('this is a false positive — wrong sector')?.category,
    ).toBe('false_positive');
  });

  it('catches outreach style', () => {
    expect(extractLessonHeuristic('the tone is too formal here')?.category).toBe(
      'outreach_style',
    );
  });

  it('catches contact role', () => {
    expect(extractLessonHeuristic('we need to reach procurement, not engineering')?.category).toBe(
      'contact_role',
    );
  });

  it('returns null on neutral content', () => {
    expect(extractLessonHeuristic('looks fine I guess')).toBeNull();
  });
});

// ---- recordFeedback ---------------------------------------------------

describe('recordFeedback', () => {
  it('appends a learning_event and writes audit', async () => {
    const s = await setup();
    const { event } = await recordFeedback(ctx(s.workspaceA, s.ownerA, 'owner'), {
      entityType: 'review_item',
      entityId: '1',
      actionType: 'general_instruction',
      originalComment: 'looks fine I guess',
    });
    expect(event.workspaceId).toBe(s.workspaceA);
    expect(event.actionType).toBe('general_instruction');
    expect(event.extractedLessonId).toBeNull();
    const audit = await db.select().from(auditLog).where(eq(auditLog.kind, 'learning.feedback'));
    expect(audit).toHaveLength(1);
  });

  it('extracts a lesson when the comment matches a heuristic', async () => {
    const s = await setup();
    const { event, lesson } = await recordFeedback(ctx(s.workspaceA, s.ownerA, 'owner'), {
      actionType: 'general_instruction',
      originalComment: "don't target councils for this product",
    });
    expect(lesson).not.toBeNull();
    expect(lesson?.category).toBe('qualification_negative');
    expect(lesson?.evidenceEventIds).toEqual([event.id]);
    expect(event.extractedLessonId).toBe(lesson?.id ?? null);
  });

  it('respects workspace isolation on the produced lesson', async () => {
    const s = await setup();
    await recordFeedback(ctx(s.workspaceA, s.ownerA, 'owner'), {
      actionType: 'general_instruction',
      originalComment: "don't target councils",
    });
    const inA = await listLessons(ctx(s.workspaceA, s.ownerA, 'owner'));
    const inB = await listLessons(ctx(s.workspaceB, s.ownerB, 'owner'));
    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(0);
  });
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
    expect(created.enabled).toBe(true);
    expect(created.confidence).toBe(65);

    await expect(
      createLesson(ctx(s.workspaceA, s.viewerA, 'viewer'), {
        category: 'outreach_style',
        rule: 'X',
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects empty rule + unknown category', async () => {
    const s = await setup();
    await expect(
      createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
        category: 'outreach_style',
        rule: '   ',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      createLesson(ctx(s.workspaceA, s.ownerA, 'owner'), {
        category: 'made_up' as never,
        rule: 'X',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
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
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      updateLesson(ctx(s.workspaceA, s.ownerA, 'owner'), lesson.id, {
        category: 'bogus' as never,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
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
      productProfileId: product.id,
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

// silence unused
void learningEvents;
void learningLessons;
