# Learning layer

The system gets smarter over time by capturing what users do (approve, reject, comment, edit) and turning it into reusable lessons that influence future qualification, drafts, and recommendations.

## Two-part design

### 1. Structured memory (Phase 5)
- Events come in as `LearningEvent` rows.
- A lesson extractor turns them into structured `LearningLesson` rows with a category, a one-sentence rule, a polarity (PREFER / AVOID / neutral), a scope (workspace-wide or a set of products) and a lifecycle (`active`, `proposed`, `disabled`, `retired`).
- Lessons are retrieved by the task's registry categories + scope (`lessonInScope`) + free-text similarity and injected into prompts or used directly by rules. Only `active` lessons are retrieved.

### 2. Vector memory (Phase 12)
- Lessons (and example documents, rejected drafts, approved drafts, replies) get embeddings stored in a `vector(1536)` column.
- Retrieval moves from "matching keywords" to "semantically related."
- The interface for retrieval (`getRelevantLessons`) does not change — only its implementation.

The architecture commits to Phase 1 abstractions so Phase 12 is additive.

## Lesson categories (registry)

`src/lib/services/learning-categories.ts` is the single source of truth (KL-01). For every category it records the operator label and description, the allowed polarity, which tasks read it (`appliesTo`: qualification / outreach / replies), whether the manual form offers it, and the code that consumes it. Retrieval (`resolveCategoriesForTask`), both extractors, the synthesis prompt, the /learning forms and the qualification prompt's PREFER / AVOID marks derive from it, and `src/tests/learning-categories.test.ts` fails when a category has no consumer for a task it claims.

| category | polarity | applies to |
|---|---|---|
| `qualification_positive` | PREFER | qualification |
| `qualification_negative` | AVOID | qualification |
| `sector_preference` | PREFER or AVOID | qualification |
| `contact_role` | PREFER or AVOID | qualification, outreach |
| `false_positive` (not manual) | AVOID | qualification |
| `false_negative` (not manual) | PREFER | qualification |
| `outreach_style` | neutral | outreach, replies |
| `product_positioning` | neutral | outreach |
| `reply_quality` | neutral | replies |
| `general_instruction` | any | qualification, outreach, replies |

`dedupe_hint` and `connector_quality` were removed in KL-01: nothing ever read them. Existing rows were retired with `retired_reason = 'category_removed'`. Source quality is a learning event for Discovery, not a rule.

`LearningEvent.actionType` stays a loose text tag (the categories above plus outcome tags such as `reply_positive`).

## Data model

### `learning_events`
Append-only.

| col | type | notes |
|---|---|---|
| id | bigserial | PK |
| workspaceId | bigint | NOT NULL |
| userId | bigint | nullable (system events possible) |
| entityType | text | `review_item` `draft` `qualification` `record` ... |
| entityId | text | |
| productProfileId | bigint | nullable |
| actionType | text | category from list above |
| originalComment | text | nullable — the user's verbatim words |
| extractedLessonId | bigint | nullable, FK learning_lessons |
| confidence | smallint | 0–100; how sure the extractor is |
| createdAt | timestamptz | |

### `learning_lessons`
Mutable (edit text, lifecycle), never hard-deleted.

| col | type | notes |
|---|---|---|
| id | bigserial | PK; UNIQUE (workspace_id, id) |
| workspaceId | bigint | NOT NULL |
| scopeKind | enum | `workspace` or `products` (see `lesson_scopes`) |
| category | text | one of the registry categories |
| rule | text | one-sentence imperative, e.g., "Skip councils for Vetrofluid offers." |
| polarity | smallint | +1 PREFER, -1 AVOID, 0 neutral |
| evidenceEventIds | bigint[] | learning_events that produced/support this lesson |
| lifecycle | enum | `active` / `proposed` / `disabled` / `retired` |
| retiredReason, retiredNote, mergedIntoId | | why, and into which rule, a rule was retired |
| confidence | smallint | 0-100 |
| applicationCount, lastAppliedAt | | exposures (pulled into a prompt) |
| citedCount, lastCitedAt | | citations by a model (KL-04) |
| reinforcedAt | timestamptz | last outcome-driven confidence change |
| embedding | vector(1536) | nullable |
| createdAt, updatedAt | timestamptz | |

### `lesson_scopes`
`(lesson_id, workspace_id, product_profile_id)`; composite FKs on `workspace_id` to both `learning_lessons` and `product_profiles`, `ON DELETE CASCADE`. A rule can only be scoped to products of its own workspace, and deleting a product leaves its rules in place but out of scope.

## Service interface

```ts
interface ILearningMemory {
  recordFeedback(ctx: WorkspaceContext, event: LearningEventInput): Promise<LearningEvent>;
  extractLesson(comment: string, context: LessonContext): Promise<LearningLessonDraft | null>;
  getRelevantLessons(ctx: WorkspaceContext, q: LessonQuery): Promise<LearningLesson[]>;
  applyLessonsToPrompt(basePrompt: string, lessons: LearningLesson[]): string;
  listLessons(ctx: WorkspaceContext, filter?: LessonFilter): Promise<LearningLesson[]>;
  enableLesson(ctx: WorkspaceContext, id: bigint): Promise<void>;
  disableLesson(ctx: WorkspaceContext, id: bigint): Promise<void>;
  updateLesson(ctx: WorkspaceContext, id: bigint, patch: LessonPatch): Promise<LearningLesson>;
}
```

`recordFeedback` enqueues lesson extraction as a job in Phase 5+. The job calls `extractLesson` (which can be the mock AI or real AI provider), gets a structured draft, and writes a `learning_lessons` row linked back to the event.

`getRelevantLessons`: active lessons, `lessonInScope(productProfileId)`, the task's registry categories, ranked by confidence + recency; reranked by embedding similarity to the task context when the pool exceeds the prompt budget.

## Extraction policy

- **Conservative.** A lesson is only created when the extractor is confident enough (configurable threshold, default 60). Low-confidence comments are kept as raw events but do not yet become lessons.
- **No autonomy.** Lessons can be reviewed by an admin from the UI (`/learning` page in Phase 5+). Disabled lessons stop influencing future runs immediately.
- **Workspace-isolated.** A lesson learned in workspace A is never used in workspace B, even if both are about the same product category. Cross-workspace learning is a deliberate, audited future feature.

## How lessons influence behavior

- **Qualification (Phase 7):** `getRelevantLessons({ taskType: 'classification' })` returns the registry's qualification categories, `general_instruction` included. The AI prompt marks each rule PREFER / AVOID / NOTE from its polarity; the rules fallback adds or subtracts by polarity and ignores neutral rules. A review verdict reinforces the matched rules by polarity (`reinforceLessonsForVerdict`): rules that pointed the way the operator decided gain, the others lose.
- **Outreach drafts (Phase 8):** `taskType: 'outreach'` (`outreach_style`, `contact_role`, `product_positioning`, `general_instruction`). Forbidden phrases come from the product profile, not from lessons.
- **Reply suggestions:** `retrieveLessons({ taskType: 'reply' })` (`reply_quality`, `outreach_style`, `general_instruction`).
- **Recommendations layer (later):** lessons drive the "why this lead matters" / "why this may be wrong" features.

## What we don't do

- We do not silently change decisions based on lessons. Every classification or draft cites the lessons it used. The user can disable a lesson and see the immediate effect.
- We do not learn from a single comment without a clear category. Garbage in, garbage out.
- We do not embed everything in Phase 5. Vector storage costs and embedding latency only kick in once the corpus is meaningful (Phase 12).
