// Self-learning loop: outcome reinforcement, reply-outcome learning,
// draft-edit learning, weekly synthesis, and the semantic retrieval path.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ZodSchema } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  _setAIProviderForTests,
  type AIGenInput,
  type AIGenResult,
  type IAIProvider,
} from '@/lib/ai';
import { db } from '@/lib/db/client';
import { learningEvents, learningLessons } from '@/lib/db/schema/learning';
import { notifications } from '@/lib/db/schema/notifications';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { workspaces } from '@/lib/db/schema/workspaces';
import { type WorkspaceContext, makeWorkspaceContext } from '@/lib/services/context';
import {
  createLesson,
  getRelevantLessons,
  reinforceLessons,
} from '@/lib/services/learning';
import {
  isMaterialEdit,
  learnFromDraftEdit,
  learnFromReplyOutcome,
} from '@/lib/services/learning-loop';
import { synthesizeWorkspaceLearningUnattended } from '@/lib/services/learning-synthesis';
import { embedAllLessons } from '@/lib/services/rag';
import { createProductProfile } from '@/lib/services/product-profile';
import { createConnector, createRecipe, startRun } from '@/lib/services/connector-run';
import { reviewItems } from '@/lib/db/schema/review';
import { generateOutreachDraft } from '@/lib/services/outreach';
import { seedUser, seedWorkspace, truncateAll } from './helpers/db';

class StubJson implements IAIProvider {
  public readonly id = 'stub';
  public readonly model = 'stub-1';
  public calls = 0;
  constructor(private readonly verdict: Record<string, unknown>) {}
  async generateText(_i: AIGenInput): Promise<AIGenResult> {
    throw new Error('not used');
  }
  async generateJson<T>(_i: AIGenInput, schema: ZodSchema<T>): Promise<T> {
    this.calls += 1;
    return schema.parse(this.verdict);
  }
  estimateCost(): number {
    return 0;
  }
  async healthCheck() {
    return { ok: true, detail: 'stub' };
  }
}

interface Setup {
  workspaceA: bigint;
  workspaceB: bigint;
  ownerA: string;
  ownerB: string;
}

async function setup(): Promise<Setup> {
  const ownerA = await seedUser({ email: 'loopA@test.local' });
  const ownerB = await seedUser({ email: 'loopB@test.local' });
  const workspaceA = await seedWorkspace({ name: 'Loop A', ownerUserId: ownerA });
  const workspaceB = await seedWorkspace({ name: 'Loop B', ownerUserId: ownerB });
  return { workspaceA, workspaceB, ownerA, ownerB };
}

function ctx(
  workspaceId: bigint,
  userId: string,
  role: WorkspaceContext['role'] = 'owner',
): WorkspaceContext {
  return makeWorkspaceContext({ workspaceId, userId, role });
}

async function lessonRow(id: bigint) {
  const rows = await db
    .select()
    .from(learningLessons)
    .where(eq(learningLessons.id, id));
  return rows[0]!;
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

// ---- reinforceLessons ---------------------------------------------------

describe('reinforceLessons', () => {
  it('up bumps confidence, down cuts it deeper, both clamp', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const a = await createLesson(c, {
      category: 'qualification_positive',
      rule: 'Target manufacturers.',
      confidence: 60,
    });
    const b = await createLesson(c, {
      category: 'qualification_negative',
      rule: 'Skip consultancies.',
      confidence: 6,
    });

    await reinforceLessons(c, [a.id], 'up', 'test');
    expect((await lessonRow(a.id)).confidence).toBe(62);

    await reinforceLessons(c, [b.id], 'down', 'test');
    expect((await lessonRow(b.id)).confidence).toBe(5); // floored, not 3

    // ceiling
    const hi = await createLesson(c, {
      category: 'outreach_style',
      rule: 'Keep it short.',
      confidence: 94,
    });
    await reinforceLessons(c, [hi.id], 'up', 'test');
    expect((await lessonRow(hi.id)).confidence).toBe(95);
  });

  it('is workspace-scoped — foreign ids no-op', async () => {
    const s = await setup();
    const lessonB = await createLesson(ctx(s.workspaceB, s.ownerB), {
      category: 'outreach_style',
      rule: 'B rule.',
      confidence: 50,
    });
    const n = await reinforceLessons(
      ctx(s.workspaceA, s.ownerA),
      [lessonB.id],
      'up',
      'cross-tenant attempt',
    );
    expect(n).toBe(0);
    expect((await lessonRow(lessonB.id)).confidence).toBe(50);
  });
});

// ---- reply outcomes -------------------------------------------------------

describe('learnFromReplyOutcome', () => {
  async function seedDraftWithLessons(s: Setup) {
    const c = ctx(s.workspaceA, s.ownerA);
    const product = await createProductProfile(c, { name: 'P', shortDescription: 'x' });
    const lesson = await createLesson(c, {
      category: 'outreach_style',
      rule: 'Be brief.',
      confidence: 50,
    });
    const conn = await createConnector(c, { templateType: 'mock', name: 'M', config: {} });
    const recipe = await createRecipe(c, {
      connectorId: conn.id,
      name: 'r',
      selectors: { seed: 'loop', count: 1, delayMs: 0 },
    });
    await startRun(c, { connectorId: conn.id, recipeId: recipe.id, wait: true });
    const reviews = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.workspaceId, s.workspaceA));
    const draft = await generateOutreachDraft(c, {
      reviewItemId: reviews[0]!.id,
      productProfileId: product.id,
    });
    await db
      .update(outreachDrafts)
      .set({ matchedLessonIds: [lesson.id] })
      .where(eq(outreachDrafts.id, draft.id));
    return { c, product, lesson, draft };
  }

  it('positive reply records an event and reinforces the draft lessons up', async () => {
    const s = await setup();
    const { c, product, lesson, draft } = await seedDraftWithLessons(s);

    const r = await learnFromReplyOutcome(c, {
      messageId: 123n,
      replyClass: 'interest',
      classifierConfidence: 80,
      productProfileId: product.id,
      precedingDraftId: draft.id,
    });
    expect(r).toEqual({ recorded: true, direction: 'up', reinforcedCount: 1 });
    expect((await lessonRow(lesson.id)).confidence).toBe(52);

    const events = await db
      .select()
      .from(learningEvents)
      .where(
        and(
          eq(learningEvents.workspaceId, s.workspaceA),
          eq(learningEvents.actionType, 'reply_positive'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.productProfileId).toBe(product.id);
  });

  it('negative reply weakens; neutral classes are ignored', async () => {
    const s = await setup();
    const { c, product, lesson, draft } = await seedDraftWithLessons(s);

    const neg = await learnFromReplyOutcome(c, {
      messageId: 124n,
      replyClass: 'negative',
      classifierConfidence: 90,
      productProfileId: product.id,
      precedingDraftId: draft.id,
    });
    expect(neg.direction).toBe('down');
    expect((await lessonRow(lesson.id)).confidence).toBe(47);

    const ooo = await learnFromReplyOutcome(c, {
      messageId: 125n,
      replyClass: 'out_of_office',
      classifierConfidence: 90,
      productProfileId: product.id,
      precedingDraftId: draft.id,
    });
    expect(ooo).toEqual({ recorded: false, direction: null, reinforcedCount: 0 });
  });
});

// ---- draft-edit learning ----------------------------------------------------

describe('isMaterialEdit', () => {
  it('typo fixes are immaterial, rewrites are material', () => {
    const original =
      'Hello John, I noticed your company builds industrial equipment and wanted to reach out about our coating solution.';
    expect(isMaterialEdit(original, original.replace('John', 'Johan'))).toBe(false);
    expect(
      isMaterialEdit(
        original,
        'Hi John — quick question: who handles procurement for coatings at your plant?',
      ),
    ).toBe(true);
  });
});

describe('learnFromDraftEdit', () => {
  const original =
    'Dear Sir or Madam, I hope this email finds you well. Our company has been a leader in protective coatings since 1998 and we offer a wide range of premium solutions for the industrial sector. I would love to schedule a call.';
  const edited =
    'Hi — who at your plant handles coating procurement? One question, thirty seconds.';

  it('creates ONE outreach_style lesson per draft from a material edit', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const product = await createProductProfile(c, { name: 'P', shortDescription: 'x' });
    _setAIProviderForTests(
      new StubJson({
        worthLearning: true,
        rule: 'Open with a single direct question instead of company history.',
        confidence: 80,
      }),
    );

    const first = await learnFromDraftEdit(c, {
      draftId: 999n,
      productProfileId: product.id,
      originalBody: original,
      editedBody: edited,
    });
    expect(first).toEqual({ learned: true, reason: 'lesson_created' });

    const lessons = await db
      .select()
      .from(learningLessons)
      .where(
        and(
          eq(learningLessons.workspaceId, s.workspaceA),
          eq(learningLessons.source, 'draft_edit'),
        ),
      );
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.category).toBe('outreach_style');
    expect(lessons[0]!.productProfileId).toBe(product.id);
    expect(lessons[0]!.confidence).toBe(65); // capped below the AI's 80

    // Same draft again → guard blocks a second lesson.
    const second = await learnFromDraftEdit(c, {
      draftId: 999n,
      productProfileId: product.id,
      originalBody: original,
      editedBody: edited + ' Thanks!',
    });
    expect(second).toEqual({ learned: false, reason: 'already_learned' });
  });

  it('skips immaterial edits without an AI call', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const product = await createProductProfile(c, { name: 'P', shortDescription: 'x' });
    const stub = new StubJson({ worthLearning: true, rule: 'x', confidence: 50 });
    _setAIProviderForTests(stub);

    const r = await learnFromDraftEdit(c, {
      draftId: 1000n,
      productProfileId: product.id,
      originalBody: original,
      editedBody: original.replace('1998', '1999'),
    });
    expect(r).toEqual({ learned: false, reason: 'not_material' });
    expect(stub.calls).toBe(0);
  });

  it('records the guard event but no lesson when the AI says not worth learning', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const product = await createProductProfile(c, { name: 'P', shortDescription: 'x' });
    _setAIProviderForTests(
      new StubJson({ worthLearning: false, rule: '', confidence: 0 }),
    );

    const r = await learnFromDraftEdit(c, {
      draftId: 1001n,
      productProfileId: product.id,
      originalBody: original,
      editedBody: edited,
    });
    expect(r).toEqual({ learned: false, reason: 'not_worth_learning' });

    const lessons = await db
      .select()
      .from(learningLessons)
      .where(eq(learningLessons.workspaceId, s.workspaceA));
    expect(lessons).toHaveLength(0);
    const events = await db
      .select()
      .from(learningEvents)
      .where(eq(learningEvents.entityId, '1001'));
    expect(events).toHaveLength(1);
  });

  it('skips the AI call on an empty wallet', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const product = await createProductProfile(c, { name: 'P', shortDescription: 'x' });
    await db
      .update(workspaces)
      .set({ tokenBalance: 0n })
      .where(eq(workspaces.id, s.workspaceA));
    const stub = new StubJson({ worthLearning: true, rule: 'x', confidence: 50 });
    _setAIProviderForTests(stub);

    const r = await learnFromDraftEdit(c, {
      draftId: 1002n,
      productProfileId: product.id,
      originalBody: original,
      editedBody: edited,
    });
    expect(r).toEqual({ learned: false, reason: 'no_tokens' });
    expect(stub.calls).toBe(0);
  });
});

// ---- weekly synthesis --------------------------------------------------------

describe('synthesizeWorkspaceLearningUnattended', () => {
  async function seedEvents(workspaceId: bigint, n: number) {
    for (let i = 0; i < n; i++) {
      await db.insert(learningEvents).values({
        workspaceId,
        actionType: i % 2 === 0 ? 'qualification_negative' : 'reply_negative',
        originalComment: i % 3 === 0 ? 'these consultancies never buy' : null,
        confidence: 60,
      });
    }
  }

  it('skips below the minimum event count', async () => {
    const s = await setup();
    await seedEvents(s.workspaceA, 5);
    const stub = new StubJson({ proposals: [] });
    _setAIProviderForTests(stub);

    const r = await synthesizeWorkspaceLearningUnattended(s.workspaceA);
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe('insufficient_events');
    expect(stub.calls).toBe(0);
  });

  it('skips on an empty wallet', async () => {
    const s = await setup();
    await seedEvents(s.workspaceA, 15);
    await db
      .update(workspaces)
      .set({ tokenBalance: 0n })
      .where(eq(workspaces.id, s.workspaceA));
    const stub = new StubJson({ proposals: [] });
    _setAIProviderForTests(stub);

    const r = await synthesizeWorkspaceLearningUnattended(s.workspaceA);
    expect(r.skippedReason).toBe('no_tokens');
    expect(stub.calls).toBe(0);
  });

  it('creates lessons from valid proposals, filters junk, notifies', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const product = await createProductProfile(c, { name: 'P', shortDescription: 'x' });
    await createLesson(c, {
      category: 'qualification_negative',
      rule: 'Skip consultancies entirely.',
      confidence: 70,
    });
    await seedEvents(s.workspaceA, 20);

    _setAIProviderForTests(
      new StubJson({
        proposals: [
          {
            category: 'qualification_negative',
            rule: 'Deprioritize pure consulting firms — they never convert.',
            productId: product.id.toString(),
            confidence: 90,
          },
          // exact duplicate of an existing rule → dropped
          {
            category: 'qualification_negative',
            rule: 'Skip consultancies entirely.',
            productId: null,
            confidence: 80,
          },
          // unknown category → dropped
          {
            category: 'not_a_category',
            rule: 'Whatever.',
            productId: null,
            confidence: 50,
          },
        ],
      }),
    );

    const r = await synthesizeWorkspaceLearningUnattended(s.workspaceA);
    expect(r.ran).toBe(true);
    expect(r.proposalsReceived).toBe(3);
    expect(r.lessonsCreated).toBe(1);

    const created = await db
      .select()
      .from(learningLessons)
      .where(
        and(
          eq(learningLessons.workspaceId, s.workspaceA),
          eq(learningLessons.source, 'synthesis'),
        ),
      );
    expect(created).toHaveLength(1);
    expect(created[0]!.productProfileId).toBe(product.id);
    expect(created[0]!.confidence).toBe(55); // capped
    expect(created[0]!.enabled).toBe(true);

    const notes = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, s.workspaceA),
          eq(notifications.kind, 'learning.synthesis'),
        ),
      );
    expect(notes).toHaveLength(1);
  });

  it('an empty proposals array creates nothing and does not notify', async () => {
    const s = await setup();
    await seedEvents(s.workspaceA, 12);
    _setAIProviderForTests(new StubJson({ proposals: [] }));

    const r = await synthesizeWorkspaceLearningUnattended(s.workspaceA);
    expect(r.ran).toBe(true);
    expect(r.lessonsCreated).toBe(0);
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.workspaceId, s.workspaceA));
    expect(notes).toHaveLength(0);
  });
});

// ---- semantic retrieval ------------------------------------------------------

describe('getRelevantLessons semantic rerank', () => {
  it('contextText rescues a low-confidence but directly-relevant lesson', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);

    const targetRule = 'Deprioritize swimming pool installers for facade coatings.';
    const target = await createLesson(c, {
      category: 'qualification_negative',
      rule: targetRule,
      confidence: 30, // confidence order alone would bury it
    });
    for (let i = 0; i < 24; i++) {
      await createLesson(c, {
        category: 'qualification_negative',
        rule: `Generic filler rule number ${i} about unrelated topics entirely.`,
        confidence: 90,
      });
    }
    await embedAllLessons(c);

    const top = await getRelevantLessons(c, {
      taskType: 'classification',
      contextText: targetRule,
      limit: 5,
    });
    expect(top.map((l) => l.id)).toContain(target.id);
  });

  it('without contextText the order stays confidence-first', async () => {
    const s = await setup();
    const c = ctx(s.workspaceA, s.ownerA);
    const low = await createLesson(c, {
      category: 'outreach_style',
      rule: 'Low.',
      confidence: 20,
    });
    const high = await createLesson(c, {
      category: 'outreach_style',
      rule: 'High.',
      confidence: 90,
    });
    const got = await getRelevantLessons(c, { taskType: 'outreach', limit: 1 });
    expect(got[0]!.id).toBe(high.id);
    expect(got.map((l) => l.id)).not.toContain(low.id);
  });
});
