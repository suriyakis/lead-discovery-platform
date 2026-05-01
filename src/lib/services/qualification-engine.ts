// Pure rule engine for qualification.
//
// Input:  one source record's normalized data + a product profile + the
//         relevant learning lessons.
// Output: a structured verdict with score, isRelevant, reasons, matched
//         keywords, disqualifying signals.
//
// No I/O — easily testable. The classification SERVICE wraps this with
// DB persistence and learning-lesson retrieval; the engine itself is
// stateless.

import type { ProductProfile } from '@/lib/db/schema/products';
import type { LearningLesson } from '@/lib/db/schema/learning';

/** What the engine extracts from a source record's normalized payload. */
export interface ClassifiableRecord {
  title?: string | null;
  snippet?: string | null;
  url?: string | null;
  domain?: string | null;
  /** Free-form text that may contain useful signal (descriptions, body, etc.). */
  body?: string | null;
}

export interface ClassificationVerdict {
  isRelevant: boolean;
  /** Final score 0..100 after all signals applied. */
  relevanceScore: number;
  confidence: number;
  matchedKeywords: string[];
  disqualifyingSignals: string[];
  qualificationReason: string | null;
  rejectionReason: string | null;
  /** Audit trail of every contribution to the score. */
  evidence: {
    contributions: Array<{ kind: string; value: string; delta: number }>;
    matchedLessonIds: bigint[];
  };
  method: 'rules';
}

interface SignalContribution {
  kind: string;
  value: string;
  delta: number;
}

const BASE_SCORE = 50;
const INCLUDE_DELTA = 6;
const EXCLUDE_DELTA = -25;
const SECTOR_DELTA = 10;
const FORBIDDEN_DELTA = -50;
const POSITIVE_LESSON_DELTA = 10;
const NEGATIVE_LESSON_DELTA = -15;

const POSITIVE_LESSON_CATEGORIES = new Set([
  'qualification_positive',
  'sector_preference',
  'product_positioning',
  'false_negative', // lesson learned: don't dismiss this kind again
]);
const NEGATIVE_LESSON_CATEGORIES = new Set([
  'qualification_negative',
  'false_positive',
]);

export function classifyRecord(
  record: ClassifiableRecord,
  product: ProductProfile,
  lessons: ReadonlyArray<LearningLesson>,
): ClassificationVerdict {
  const haystack = buildHaystack(record);
  const contributions: SignalContribution[] = [];
  let score = BASE_SCORE;

  // ---- include keywords ----
  const matchedKeywords: string[] = [];
  for (const kw of product.includeKeywords) {
    if (matchesIn(haystack, kw)) {
      matchedKeywords.push(kw);
      score += INCLUDE_DELTA;
      contributions.push({ kind: 'include_keyword', value: kw, delta: INCLUDE_DELTA });
    }
  }

  // ---- exclude keywords ----
  const disqualifyingSignals: string[] = [];
  for (const kw of product.excludeKeywords) {
    if (matchesIn(haystack, kw)) {
      disqualifyingSignals.push(`excluded:${kw}`);
      score += EXCLUDE_DELTA;
      contributions.push({ kind: 'exclude_keyword', value: kw, delta: EXCLUDE_DELTA });
    }
  }

  // ---- sector match ----
  const matchedSectors: string[] = [];
  for (const sector of product.targetSectors) {
    if (matchesIn(haystack, sector)) {
      matchedSectors.push(sector);
      score += SECTOR_DELTA;
      contributions.push({ kind: 'sector', value: sector, delta: SECTOR_DELTA });
    }
  }

  // ---- forbidden phrases — these are commonly used by competitors / wrong fits ----
  let forbiddenHit = false;
  for (const phrase of product.forbiddenPhrases) {
    if (matchesIn(haystack, phrase)) {
      forbiddenHit = true;
      disqualifyingSignals.push(`forbidden:${phrase}`);
      score += FORBIDDEN_DELTA;
      contributions.push({ kind: 'forbidden_phrase', value: phrase, delta: FORBIDDEN_DELTA });
    }
  }

  // ---- learning lessons ----
  const matchedLessonIds: bigint[] = [];
  for (const lesson of lessons) {
    if (!lesson.enabled) continue;
    if (!matchesIn(haystack, keyTokenForLesson(lesson.rule))) continue;
    matchedLessonIds.push(lesson.id);
    if (POSITIVE_LESSON_CATEGORIES.has(lesson.category)) {
      score += POSITIVE_LESSON_DELTA;
      contributions.push({
        kind: `lesson:${lesson.category}`,
        value: short(lesson.rule),
        delta: POSITIVE_LESSON_DELTA,
      });
    } else if (NEGATIVE_LESSON_CATEGORIES.has(lesson.category)) {
      score += NEGATIVE_LESSON_DELTA;
      disqualifyingSignals.push(`lesson:${short(lesson.rule)}`);
      contributions.push({
        kind: `lesson:${lesson.category}`,
        value: short(lesson.rule),
        delta: NEGATIVE_LESSON_DELTA,
      });
    }
    // Other categories (outreach_style, etc.) don't directly affect relevance.
  }

  // ---- finalize ----
  const finalScore = clamp(Math.round(score), 0, 100);
  const threshold = product.relevanceThreshold;
  const meetsThreshold = finalScore >= threshold;
  const isRelevant = meetsThreshold && !forbiddenHit;

  const totalSignals =
    matchedKeywords.length +
    disqualifyingSignals.length +
    matchedSectors.length +
    matchedLessonIds.length;
  // Confidence: more signals → more confident. Cap at 95 to avoid overclaiming.
  const confidence = clamp(40 + totalSignals * 6, 30, 95);

  const qualificationReason = isRelevant ? buildQualReason(matchedKeywords, matchedSectors) : null;
  const rejectionReason = isRelevant ? null : buildRejectionReason(forbiddenHit, finalScore, threshold, disqualifyingSignals);

  return {
    isRelevant,
    relevanceScore: finalScore,
    confidence,
    matchedKeywords,
    disqualifyingSignals,
    qualificationReason,
    rejectionReason,
    evidence: { contributions, matchedLessonIds },
    method: 'rules',
  };
}

// ---- helpers ----------------------------------------------------------

function buildHaystack(record: ClassifiableRecord): string {
  return [
    record.title ?? '',
    record.snippet ?? '',
    record.url ?? '',
    record.domain ?? '',
    record.body ?? '',
  ]
    .join(' \n ')
    .toLowerCase();
}

function matchesIn(haystack: string, needle: string): boolean {
  const trimmed = needle.trim().toLowerCase();
  if (!trimmed) return false;
  return haystack.includes(trimmed);
}

/**
 * Heuristic: pick the most distinctive word from a lesson rule to use as
 * the trigger. For Phase 7 this is "longest word > 4 chars". Phase 12 will
 * replace this with embedding similarity against the record body.
 */
function keyTokenForLesson(rule: string): string {
  const words = rule
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 4);
  if (words.length === 0) return rule.toLowerCase();
  return words.sort((a, b) => b.length - a.length)[0]!;
}

function short(s: string, n = 60): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function buildQualReason(matchedKeywords: string[], matchedSectors: string[]): string {
  const parts: string[] = [];
  if (matchedKeywords.length > 0) {
    parts.push(`include: ${matchedKeywords.slice(0, 5).join(', ')}`);
  }
  if (matchedSectors.length > 0) {
    parts.push(`sectors: ${matchedSectors.slice(0, 5).join(', ')}`);
  }
  if (parts.length === 0) parts.push('met threshold');
  return parts.join(' · ');
}

function buildRejectionReason(
  forbiddenHit: boolean,
  finalScore: number,
  threshold: number,
  disqualifyingSignals: string[],
): string {
  if (forbiddenHit) return 'forbidden phrase matched';
  if (finalScore < threshold) {
    const sigList = disqualifyingSignals.length > 0
      ? ` (signals: ${disqualifyingSignals.slice(0, 3).join(', ')})`
      : '';
    return `score ${finalScore} < threshold ${threshold}${sigList}`;
  }
  return 'rejected';
}
