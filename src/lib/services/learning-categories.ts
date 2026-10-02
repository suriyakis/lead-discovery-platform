// Learning-rule category registry (KL-01).
//
// The ONE place that says, for every lesson category:
//   - how an operator sees it (label + one-line description),
//   - which way it pushes a fit verdict (polarity: PREFER +1, AVOID -1,
//     neutral 0 — some categories are fixed, some let the rule choose),
//   - which tasks read it (appliesTo: qualification / outreach / replies),
//   - whether the manual form offers it (manualCreatable),
//   - which code actually consumes it (consumers).
//
// Retrieval (resolveCategoriesForTask), both extractors, the synthesis
// prompt, the /learning forms and the qualification prompt's PREFER/AVOID
// marks all derive from here. Before this registry a lesson could live in
// a category no prompt ever read (I038: manual lessons defaulted to
// general_instruction, which neither qualification nor outreach fetched;
// dedupe_hint and connector_quality had no consumer at all). The registry
// test (src/tests/learning-categories.test.ts) fails when a category has
// no polarity/appliesTo/label or an appliesTo value has no consumer, and
// checks every consumer's file really reads rules for its task.
//
// Pure module: no DB, no I/O — safe to import from pages and tests.

export const LESSON_APPLIES_TO = ['qualification', 'outreach', 'replies'] as const;
export type LessonAppliesTo = (typeof LESSON_APPLIES_TO)[number];

export const APPLIES_TO_LABELS: Record<LessonAppliesTo, string> = {
  qualification: 'Qualification',
  outreach: 'Outreach drafts',
  replies: 'Reply suggestions',
};

/** Task names the retrieval callers pass (getRelevantLessons taskType,
 *  retrieveLessons taskType). Each maps to exactly one appliesTo value. */
export const LESSON_TASK_TYPES = ['classification', 'outreach', 'reply'] as const;
export type LessonTaskType = (typeof LESSON_TASK_TYPES)[number];

export const APPLIES_TO_BY_TASK_TYPE: Record<LessonTaskType, LessonAppliesTo> = {
  classification: 'qualification',
  outreach: 'outreach',
  reply: 'replies',
};

/** +1 = PREFER (pushes toward a fit), -1 = AVOID (pushes against),
 *  0 = neutral guidance (style, positioning, reply handling). */
export type LessonPolarity = -1 | 0 | 1;
export const LESSON_POLARITIES: readonly LessonPolarity[] = [1, -1, 0];

// ---- consumers --------------------------------------------------------

export interface LessonConsumer {
  appliesTo: LessonAppliesTo;
  description: string;
  /** Repo-relative file where the consumer retrieves or applies rules. */
  file: string;
  /** Code that `file` must contain — the registry test's proof that the
   *  consumer really reads rules for its task. */
  marker: string;
}

export const LESSON_CONSUMERS = {
  'qualification.ai_prompt': {
    appliesTo: 'qualification',
    description:
      'AI qualifier: up to 10 rules in the PRIOR LESSONS block, each marked PREFER / AVOID / NOTE from its polarity.',
    file: 'src/lib/services/qualification.ts',
    marker: "taskType: 'classification'",
  },
  'qualification.rules_fallback': {
    appliesTo: 'qualification',
    description:
      'Rules fallback (only when the AI call fails): a matching PREFER rule raises the score, an AVOID rule lowers it.',
    file: 'src/lib/services/qualification-engine.ts',
    marker: 'lesson.polarity',
  },
  'outreach.ai_draft': {
    appliesTo: 'outreach',
    description: 'Outreach draft composer: rules listed as workspace guidelines in the prompt.',
    file: 'src/lib/services/outreach.ts',
    marker: "taskType: 'outreach'",
  },
  'replies.suggest_reply': {
    appliesTo: 'replies',
    description: 'Suggest reply: the rules nearest to the inbound message, listed in the prompt.',
    file: 'src/lib/services/reply-assistant.ts',
    marker: "taskType: 'reply'",
  },
} as const satisfies Record<string, LessonConsumer>;

export type LessonConsumerId = keyof typeof LESSON_CONSUMERS;

// ---- categories -------------------------------------------------------

export interface LessonCategoryDefinition {
  /** Operator-facing name. */
  label: string;
  /** One sentence the manual form shows as the category legend. */
  description: string;
  /** Allowed polarities; a single entry means the category fixes it. */
  polarity: { allowed: readonly LessonPolarity[]; default: LessonPolarity };
  appliesTo: readonly LessonAppliesTo[];
  /** Offered on /learning/new. Engine-feedback categories (the AI got a
   *  record wrong) come from review decisions, not from the form. */
  manualCreatable: boolean;
  consumers: readonly LessonConsumerId[];
}

const QUALIFICATION_CONSUMERS = [
  'qualification.ai_prompt',
  'qualification.rules_fallback',
] as const satisfies readonly LessonConsumerId[];

export const LESSON_CATEGORY_REGISTRY = {
  qualification_positive: {
    label: 'Good fit signal',
    description: 'Records like this should be approved.',
    polarity: { allowed: [1], default: 1 },
    appliesTo: ['qualification'],
    manualCreatable: true,
    consumers: QUALIFICATION_CONSUMERS,
  },
  qualification_negative: {
    label: 'Poor fit signal',
    description: 'Records like this should be rejected.',
    polarity: { allowed: [-1], default: -1 },
    appliesTo: ['qualification'],
    manualCreatable: true,
    consumers: QUALIFICATION_CONSUMERS,
  },
  sector_preference: {
    label: 'Sector preference',
    description: 'A sector or industry to prefer or to avoid.',
    polarity: { allowed: [1, -1], default: 1 },
    appliesTo: ['qualification'],
    manualCreatable: true,
    consumers: QUALIFICATION_CONSUMERS,
  },
  contact_role: {
    label: 'Contact role',
    description: 'Which roles to prefer or avoid, when qualifying and when writing to them.',
    polarity: { allowed: [1, -1], default: 1 },
    appliesTo: ['qualification', 'outreach'],
    manualCreatable: true,
    consumers: [...QUALIFICATION_CONSUMERS, 'outreach.ai_draft'],
  },
  false_positive: {
    label: 'Wrongly approved',
    description: 'The AI called records like this a fit, and they are not.',
    polarity: { allowed: [-1], default: -1 },
    appliesTo: ['qualification'],
    manualCreatable: false,
    consumers: QUALIFICATION_CONSUMERS,
  },
  false_negative: {
    label: 'Wrongly rejected',
    description: 'The AI dismissed records like this, and they are a fit.',
    polarity: { allowed: [1], default: 1 },
    appliesTo: ['qualification'],
    manualCreatable: false,
    consumers: QUALIFICATION_CONSUMERS,
  },
  outreach_style: {
    label: 'Writing style',
    description: 'How emails should read: tone, length, structure.',
    polarity: { allowed: [0], default: 0 },
    appliesTo: ['outreach', 'replies'],
    manualCreatable: true,
    consumers: ['outreach.ai_draft', 'replies.suggest_reply'],
  },
  product_positioning: {
    label: 'Product positioning',
    description: 'How outreach should describe the product.',
    polarity: { allowed: [0], default: 0 },
    appliesTo: ['outreach'],
    manualCreatable: true,
    consumers: ['outreach.ai_draft'],
  },
  reply_quality: {
    label: 'Reply handling',
    description: 'How to answer inbound replies.',
    polarity: { allowed: [0], default: 0 },
    appliesTo: ['replies'],
    manualCreatable: true,
    consumers: ['replies.suggest_reply'],
  },
  general_instruction: {
    label: 'General instruction',
    description: 'A workspace rule that qualification, outreach and reply suggestions all follow.',
    polarity: { allowed: [0, 1, -1], default: 0 },
    appliesTo: ['qualification', 'outreach', 'replies'],
    manualCreatable: true,
    consumers: [...QUALIFICATION_CONSUMERS, 'outreach.ai_draft', 'replies.suggest_reply'],
  },
} as const satisfies Record<string, LessonCategoryDefinition>;

export type LessonCategory = keyof typeof LESSON_CATEGORY_REGISTRY;

export const LESSON_CATEGORIES = Object.keys(LESSON_CATEGORY_REGISTRY) as readonly LessonCategory[];

/** Categories that existed before KL-01 and were removed because nothing
 *  consumed them. Rows still carrying one were retired by the KL-01
 *  migration (retired_reason 'category_removed'); the service rejects
 *  them for new or edited rules. Source quality is a learning event for
 *  Discovery, not a rule. */
export const REMOVED_LESSON_CATEGORIES = ['dedupe_hint', 'connector_quality'] as const;

const CATEGORY_SET = new Set<string>(LESSON_CATEGORIES);

export function isLessonCategory(value: string): value is LessonCategory {
  return CATEGORY_SET.has(value);
}

export function getLessonCategoryDefinition(category: string): LessonCategoryDefinition | null {
  return isLessonCategory(category) ? LESSON_CATEGORY_REGISTRY[category] : null;
}

/** Operator-facing label; unknown / removed categories fall back to the
 *  raw key with spaces so legacy rows still render. */
export function lessonCategoryLabel(category: string): string {
  return getLessonCategoryDefinition(category)?.label ?? category.replace(/_/g, ' ');
}

export const MANUAL_LESSON_CATEGORIES = LESSON_CATEGORIES.filter(
  (c) => LESSON_CATEGORY_REGISTRY[c].manualCreatable,
);

export function categoriesForAppliesTo(appliesTo: LessonAppliesTo): LessonCategory[] {
  return LESSON_CATEGORIES.filter((c) =>
    (LESSON_CATEGORY_REGISTRY[c].appliesTo as readonly LessonAppliesTo[]).includes(appliesTo),
  );
}

/** The category set a retrieval task reads — derived from the registry,
 *  never hand-listed at a call site. */
export function categoriesForTaskType(taskType: LessonTaskType): LessonCategory[] {
  return categoriesForAppliesTo(APPLIES_TO_BY_TASK_TYPE[taskType]);
}

/** Categories that may carry the given polarity (KL-03 constrains an
 *  extraction to the set matching the decision's polarity). */
export function categoriesForPolarity(polarity: LessonPolarity): LessonCategory[] {
  return LESSON_CATEGORIES.filter((c) =>
    (LESSON_CATEGORY_REGISTRY[c].polarity.allowed as readonly LessonPolarity[]).includes(polarity),
  );
}

export function isPolarityAllowed(category: LessonCategory, polarity: number): boolean {
  return (LESSON_CATEGORY_REGISTRY[category].polarity.allowed as readonly number[]).includes(
    polarity,
  );
}

/** Words that turn a rule into an AVOID rule when its category lets the
 *  rule choose (sector_preference, contact_role, general_instruction). */
const AVOID_PATTERN =
  /\b(avoid|skip|exclude|never|don't|do not|not relevant|not interested|reject|ignore|steer clear)\b/i;

/** Best-effort polarity for an extracted rule whose category lets the rule
 *  choose: an explicit avoid-verb means AVOID, anything else PREFER. */
export function inferPolarityFromRule(rule: string): LessonPolarity {
  return AVOID_PATTERN.test(rule) ? -1 : 1;
}

/**
 * The polarity a rule in `category` ends up with:
 *   - a category with one allowed polarity always gets it;
 *   - otherwise the requested polarity when allowed, else the default.
 * Callers that must REJECT a disallowed explicit choice (the manual form)
 * check isPolarityAllowed first.
 */
export function resolveLessonPolarity(
  category: LessonCategory,
  requested?: number | null,
): LessonPolarity {
  const def = LESSON_CATEGORY_REGISTRY[category].polarity;
  const allowed = def.allowed as readonly LessonPolarity[];
  if (allowed.length === 1) return allowed[0]!;
  if (
    requested !== undefined &&
    requested !== null &&
    allowed.includes(requested as LessonPolarity)
  ) {
    return requested as LessonPolarity;
  }
  return def.default;
}

/**
 * Polarity for a rule an extractor produced (AI or heuristic). Fixed
 * categories get theirs; an allowed explicit choice wins; otherwise an
 * avoid-verb in the text makes it AVOID where the category allows that,
 * and anything else gets the category default. Never trusts the text over
 * a fixed category — "avoid X" filed as qualification_positive stays +1.
 */
export function polarityForRule(
  category: LessonCategory,
  rule: string,
  requested?: number | null,
): LessonPolarity {
  const def = LESSON_CATEGORY_REGISTRY[category].polarity;
  const allowed = def.allowed as readonly LessonPolarity[];
  if (allowed.length === 1) return allowed[0]!;
  if (
    requested !== undefined &&
    requested !== null &&
    allowed.includes(requested as LessonPolarity)
  ) {
    return requested as LessonPolarity;
  }
  if (allowed.includes(-1) && inferPolarityFromRule(rule) === -1) return -1;
  return def.default;
}

/** Prompt mark for a rule: PREFER / AVOID / NOTE. */
export function lessonPolarityMark(polarity: number): 'PREFER' | 'AVOID' | 'NOTE' {
  if (polarity > 0) return 'PREFER';
  if (polarity < 0) return 'AVOID';
  return 'NOTE';
}

export function lessonPolarityLabel(polarity: number): string {
  if (polarity > 0) return 'Prefer';
  if (polarity < 0) return 'Avoid';
  return 'Neutral';
}

/** Form value ↔ polarity ('prefer' | 'avoid' | 'neutral'). */
export function parseLessonPolarity(value: string | null | undefined): LessonPolarity | null {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'prefer':
    case '1':
    case '+1':
      return 1;
    case 'avoid':
    case '-1':
      return -1;
    case 'neutral':
    case '0':
      return 0;
    default:
      return null;
  }
}

export function lessonPolarityFormValue(polarity: number): 'prefer' | 'avoid' | 'neutral' {
  if (polarity > 0) return 'prefer';
  if (polarity < 0) return 'avoid';
  return 'neutral';
}
