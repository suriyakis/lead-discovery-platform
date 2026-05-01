# Learning layer

The system gets smarter over time by capturing what users do (approve, reject, comment, edit) and turning it into reusable lessons that influence future qualification, drafts, and recommendations.

## Two-part design

### 1. Structured memory (Phase 5)
- Events come in as `LearningEvent` rows.
- A lesson extractor turns them into structured `LearningLesson` rows with a category, a one-sentence rule, optional product-profile scope, and an `enabled` flag.
- Lessons are retrieved by category + product-profile + free-text similarity (basic, not vector) and injected into prompts or used directly by rules.

### 2. Vector memory (Phase 12)
- Lessons (and example documents, rejected drafts, approved drafts, replies) get embeddings stored in a `vector(1536)` column.
- Retrieval moves from "matching keywords" to "semantically related."
- The interface for retrieval (`getRelevantLessons`) does not change — only its implementation.

The architecture commits to Phase 1 abstractions so Phase 12 is additive.

## Event categories

Tagged on `LearningEvent.actionType` and inherited by lessons:

- `qualification_positive` — "this is the kind of company we want"
- `qualification_negative` — "this is the kind we don't want"
- `outreach_style` — "we don't say 'we are excited to'..."
- `contact_role` — "for this product, target procurement, not engineering"
- `sector_preference` — "skip councils for this offer"
- `connector_quality` — "this directory has too many out-of-business companies"
- `false_positive` — qualification said yes, user said no
- `false_negative` — qualification said no, user said yes
- `dedupe_hint` — these two records are the same / are not the same
- `general_instruction` — workspace-wide rule that doesn't fit a tighter category
- `reply_quality` — feedback on a generated technical reply
- `product_positioning` — how we describe this product

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
Mutable (enable/disable, edit text), but never hard-deleted in Phase 5.

| col | type | notes |
|---|---|---|
| id | bigserial | PK |
| workspaceId | bigint | NOT NULL |
| productProfileId | bigint | nullable — null = workspace-wide |
| category | text | one of the categories above |
| rule | text | one-sentence imperative, e.g., "Skip councils for Vetrofluid offers." |
| evidenceEventIds | bigint[] | learning_events that produced/support this lesson |
| enabled | boolean | NOT NULL default true |
| confidence | smallint | 0–100 |
| embedding | vector(1536) | nullable — populated in Phase 12 |
| createdAt | timestamptz | |
| updatedAt | timestamptz | |

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

`getRelevantLessons` in Phase 5: filter by `(workspaceId, productProfileId, category)` and rank by recency + confidence. In Phase 12: rerank by embedding similarity to the task context.

## Extraction policy

- **Conservative.** A lesson is only created when the extractor is confident enough (configurable threshold, default 60). Low-confidence comments are kept as raw events but do not yet become lessons.
- **No autonomy.** Lessons can be reviewed by an admin from the UI (`/learning` page in Phase 5+). Disabled lessons stop influencing future runs immediately.
- **Workspace-isolated.** A lesson learned in workspace A is never used in workspace B, even if both are about the same product category. Cross-workspace learning is a deliberate, audited future feature.

## How lessons influence behavior

- **Qualification engine (Phase 7):** `getRelevantLessons` is called with `category in ('qualification_positive', 'qualification_negative', 'sector_preference', 'contact_role', 'product_positioning', 'false_positive', 'false_negative')`. The lessons are passed as additional rules to the rule engine and as additional context to the AI classifier (when AI is used).
- **Outreach drafts (Phase 8):** lessons in `('outreach_style', 'product_positioning', 'contact_role')` are injected into the prompt that generates the draft. Forbidden phrases come from the product profile, not from lessons.
- **Connector quality (later):** lessons in `connector_quality` feed into a per-recipe quality score that surfaces in the UI.
- **Recommendations layer (later):** lessons drive the "why this lead matters" / "why this may be wrong" features.

## What we don't do

- We do not silently change decisions based on lessons. Every classification or draft cites the lessons it used. The user can disable a lesson and see the immediate effect.
- We do not learn from a single comment without a clear category. Garbage in, garbage out.
- We do not embed everything in Phase 5. Vector storage costs and embedding latency only kick in once the corpus is meaningful (Phase 12).
