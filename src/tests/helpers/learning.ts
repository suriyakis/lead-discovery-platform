// In-memory LearningLesson rows for pure-function tests (rules engine,
// prompt builders). DB-backed tests go through createLesson instead.

import type { LearningLesson } from '@/lib/db/schema/learning';

export function makeLessonRow(overrides: Partial<LearningLesson> = {}): LearningLesson {
  const base: LearningLesson = {
    id: 1n,
    workspaceId: 1n,
    scopeKind: 'workspace',
    category: 'qualification_positive',
    rule: 'A rule',
    polarity: 1,
    source: 'operator',
    evidenceEventIds: [],
    lifecycle: 'active',
    retiredReason: null,
    retiredNote: null,
    mergedIntoId: null,
    confidence: 80,
    applicationCount: 0,
    lastAppliedAt: null,
    citedCount: 0,
    lastCitedAt: null,
    reinforcedAt: null,
    embedding: null,
    embeddingModel: null,
    embeddingDim: 1536,
    embeddedAt: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { ...base, ...overrides };
}
