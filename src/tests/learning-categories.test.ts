// KL-01 acceptance 3: the category registry is complete and honest.
//   - every category has a label, polarity and appliesTo;
//   - every appliesTo value of a category has at least one of that
//     category's consumers, and every consumer's file really reads rules
//     for its task (a code marker, so the registry cannot claim a consumer
//     that does not exist);
//   - retrieval categories are derived from it (general_instruction reaches
//     classification and outreach, reply_quality reaches replies — I038);
//   - neither extractor can emit a removed category.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPLIES_TO_LABELS,
  LESSON_APPLIES_TO,
  LESSON_CATEGORIES,
  LESSON_CATEGORY_REGISTRY,
  LESSON_CONSUMERS,
  LESSON_TASK_TYPES,
  MANUAL_LESSON_CATEGORIES,
  REMOVED_LESSON_CATEGORIES,
  categoriesForPolarity,
  categoriesForTaskType,
  isLessonCategory,
  lessonPolarityMark,
  polarityForRule,
  resolveLessonPolarity,
  type LessonConsumerId,
} from '@/lib/services/learning-categories';
import {
  EXTRACTOR_SYSTEM_PROMPT,
  extractLessonHeuristic,
  resolveCategoriesForTask,
} from '@/lib/services/learning';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('category registry', () => {
  it('every category has a label, description, polarity and appliesTo', () => {
    expect(LESSON_CATEGORIES.length).toBeGreaterThan(0);
    for (const c of LESSON_CATEGORIES) {
      const def = LESSON_CATEGORY_REGISTRY[c];
      expect(def.label.trim(), c).not.toBe('');
      expect(def.description.trim(), c).not.toBe('');
      expect(def.polarity.allowed.length, c).toBeGreaterThan(0);
      expect(def.polarity.allowed as readonly number[], c).toContain(def.polarity.default);
      for (const p of def.polarity.allowed) expect([-1, 0, 1], c).toContain(p);
      expect(def.appliesTo.length, c).toBeGreaterThan(0);
      for (const a of def.appliesTo) expect(LESSON_APPLIES_TO, c).toContain(a);
      expect(typeof def.manualCreatable, c).toBe('boolean');
    }
  });

  it('every appliesTo value of a category has at least one consumer of that task', () => {
    for (const c of LESSON_CATEGORIES) {
      const def = LESSON_CATEGORY_REGISTRY[c];
      const consumers = def.consumers.map((id: LessonConsumerId) => LESSON_CONSUMERS[id]);
      for (const consumer of consumers)
        expect(consumer, `${c} names an unknown consumer`).toBeDefined();
      for (const a of def.appliesTo) {
        expect(
          consumers.some((k) => k.appliesTo === a),
          `${c} applies to ${a} but none of its consumers reads ${a}`,
        ).toBe(true);
      }
      // …and no consumer is listed for a task the category does not apply to.
      for (const k of consumers) {
        expect(
          def.appliesTo as readonly string[],
          `${c} lists a ${k.appliesTo} consumer`,
        ).toContain(k.appliesTo);
      }
    }
  });

  it('every appliesTo value is read by some consumer, and has an operator label', () => {
    for (const a of LESSON_APPLIES_TO) {
      expect(
        Object.values(LESSON_CONSUMERS).some((k) => k.appliesTo === a),
        `nothing consumes ${a}`,
      ).toBe(true);
      expect(APPLIES_TO_LABELS[a].trim()).not.toBe('');
    }
  });

  it("every consumer's file really reads rules for its task", () => {
    for (const [id, consumer] of Object.entries(LESSON_CONSUMERS)) {
      const source = readFileSync(path.join(repoRoot, consumer.file), 'utf8');
      expect(
        source.includes(consumer.marker),
        `${id}: ${consumer.file} lacks ${consumer.marker}`,
      ).toBe(true);
    }
  });

  it('every task type maps onto an appliesTo value that some category feeds', () => {
    for (const t of LESSON_TASK_TYPES) {
      expect(categoriesForTaskType(t).length, t).toBeGreaterThan(0);
    }
  });

  it('removed categories are gone from the registry and the manual form', () => {
    for (const removed of REMOVED_LESSON_CATEGORIES) {
      expect(isLessonCategory(removed)).toBe(false);
      expect(MANUAL_LESSON_CATEGORIES as readonly string[]).not.toContain(removed);
    }
  });

  it('engine-feedback categories are not offered on the manual form', () => {
    expect(MANUAL_LESSON_CATEGORIES).not.toContain('false_positive');
    expect(MANUAL_LESSON_CATEGORIES).not.toContain('false_negative');
    expect(MANUAL_LESSON_CATEGORIES).toContain('general_instruction');
  });
});

describe('retrieval categories are derived from the registry (I038)', () => {
  it('general_instruction reaches qualification, outreach and replies', () => {
    expect(resolveCategoriesForTask({ taskType: 'classification' })).toContain(
      'general_instruction',
    );
    expect(resolveCategoriesForTask({ taskType: 'outreach' })).toContain('general_instruction');
    expect(resolveCategoriesForTask({ taskType: 'reply' })).toContain('general_instruction');
  });

  it("reply_quality is read by taskType 'reply' and nowhere else", () => {
    expect(resolveCategoriesForTask({ taskType: 'reply' })).toContain('reply_quality');
    expect(resolveCategoriesForTask({ taskType: 'classification' })).not.toContain('reply_quality');
    expect(resolveCategoriesForTask({ taskType: 'outreach' })).not.toContain('reply_quality');
  });

  it('each task gets exactly the categories whose appliesTo names it', () => {
    expect(new Set(resolveCategoriesForTask({ taskType: 'classification' }))).toEqual(
      new Set([
        'qualification_positive',
        'qualification_negative',
        'sector_preference',
        'contact_role',
        'false_positive',
        'false_negative',
        'general_instruction',
      ]),
    );
    expect(new Set(resolveCategoriesForTask({ taskType: 'outreach' }))).toEqual(
      new Set(['outreach_style', 'product_positioning', 'contact_role', 'general_instruction']),
    );
    expect(new Set(resolveCategoriesForTask({ taskType: 'reply' }))).toEqual(
      new Set(['reply_quality', 'outreach_style', 'general_instruction']),
    );
  });

  it('an explicit category list wins; no task and no category means every category', () => {
    expect(
      resolveCategoriesForTask({ category: 'outreach_style', taskType: 'classification' }),
    ).toEqual(['outreach_style']);
    expect(resolveCategoriesForTask({})).toBeUndefined();
  });
});

describe('polarity', () => {
  it('fixed categories always get theirs, whatever the wording', () => {
    expect(polarityForRule('qualification_positive', 'Avoid nothing, these are great')).toBe(1);
    expect(polarityForRule('qualification_negative', 'Councils')).toBe(-1);
    expect(polarityForRule('outreach_style', 'Never use buzzwords')).toBe(0);
  });

  it('either-way categories read the wording, or take an allowed explicit choice', () => {
    expect(polarityForRule('sector_preference', 'Avoid public-sector schools')).toBe(-1);
    expect(polarityForRule('sector_preference', 'Data-centre builders convert best')).toBe(1);
    expect(polarityForRule('contact_role', 'Office managers', -1)).toBe(-1);
    expect(polarityForRule('general_instruction', 'Write in Polish to Polish prospects')).toBe(0);
    expect(polarityForRule('general_instruction', 'Skip councils for Vetrofluid')).toBe(-1);
    // A disallowed explicit choice falls back instead of being stored.
    expect(resolveLessonPolarity('sector_preference', 0)).toBe(1);
  });

  it('PREFER / AVOID / NOTE marks follow the sign', () => {
    expect(lessonPolarityMark(1)).toBe('PREFER');
    expect(lessonPolarityMark(-1)).toBe('AVOID');
    expect(lessonPolarityMark(0)).toBe('NOTE');
  });

  it('every polarity has categories that can carry it', () => {
    expect(categoriesForPolarity(1)).toContain('qualification_positive');
    expect(categoriesForPolarity(-1)).toContain('qualification_negative');
    expect(categoriesForPolarity(-1)).not.toContain('qualification_positive');
    expect(categoriesForPolarity(0)).toContain('outreach_style');
  });
});

describe('extractors never emit a removed category', () => {
  it('the AI extractor prompt only lists registry categories', () => {
    for (const removed of REMOVED_LESSON_CATEGORIES) {
      expect(EXTRACTOR_SYSTEM_PROMPT).not.toContain(removed);
    }
    for (const c of LESSON_CATEGORIES) expect(EXTRACTOR_SYSTEM_PROMPT).toContain(`- ${c}:`);
  });

  it('the heuristic no longer produces dedupe_hint or connector_quality', () => {
    const formerlyRemoved = [
      'this is a duplicate of a company we already have',
      'same company as the one from yesterday, merge it',
      'the source is noisy and outdated',
      'this directory is low quality',
    ];
    for (const comment of formerlyRemoved) {
      const draft = extractLessonHeuristic(comment);
      if (draft) {
        expect(REMOVED_LESSON_CATEGORIES as readonly string[]).not.toContain(draft.category);
        expect(isLessonCategory(draft.category)).toBe(true);
      }
    }
  });

  it('heuristic drafts carry a polarity consistent with their category', () => {
    const neg = extractLessonHeuristic("don't target councils");
    expect(neg?.category).toBe('qualification_negative');
    expect(neg?.polarity).toBe(-1);
    const sector = extractLessonHeuristic('construction sector buys these');
    expect(sector?.category).toBe('sector_preference');
    expect(sector?.polarity).toBe(1);
    const style = extractLessonHeuristic('the tone is too formal here');
    expect(style?.polarity).toBe(0);
  });
});
