// Knowledge compaction: AI-managed shrinking of the workspace lesson base.
//
// The principle: every manual review-queue decision feeds the learning layer
// (P60-01). Without compaction, lessons grow unbounded — diluting prompt
// budget and surfacing stale advice. This service runs periodically (and on
// demand) to:
//   1. Retire dead-weight lessons (low confidence + not applied recently).
//   2. Merge near-duplicates within a (productProfileId, category) cluster
//      using the workspace AI provider, keeping the strongest survivor and
//      disabling the rest. Evidence_event_ids are unioned into the survivor
//      so we never silently drop the origin chain.
//
// Everything is workspace-scoped — both the lesson queries and the AI
// prompt content. A misbehaving caller cannot make this service touch
// another tenant's lessons.

import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { learningLessons, type LearningLesson } from '@/lib/db/schema/learning';
import { getAIProviderForCtx } from '@/lib/ai';
import { recordAuditEvent, recordPlatformAuditEvent } from './audit';
import { canAdminWorkspace, type WorkspaceContext } from './context';

export class KnowledgeCompactionError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'KnowledgeCompactionError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new KnowledgeCompactionError(`Permission denied: ${op}`, 'permission_denied');

// ---- thresholds --------------------------------------------------------

/** A lesson with confidence < this AND not applied within STALE_AGE_DAYS
 *  (or never applied at all) is eligible for retirement. */
const STALE_CONFIDENCE_THRESHOLD = 40;
/** Days since lastAppliedAt before a low-confidence lesson is retired.
 *  Lessons never applied AT ALL are retired only when they're also older
 *  than this many days, to give the platform time to actually use them. */
const STALE_AGE_DAYS = 30;
/** Max lessons in a single AI merge call. Beyond this we split into
 *  sub-clusters of this size (rare in practice — most categories have <10). */
const CLUSTER_MAX = 12;
/** Minimum cluster size for an AI merge attempt. */
const CLUSTER_MIN = 2;
/** Embedding pre-filter: when EVERY lesson in a chunk has a stored
 *  embedding and no pair reaches this cosine similarity, the chunk is
 *  clearly distinct — skip the AI merge call entirely. Deliberately
 *  below the create-time dedup threshold (0.92) so paraphrases in the
 *  0.75–0.92 band still get an AI look. */
const MERGE_CANDIDATE_SIMILARITY = 0.75;

// ---- public types ------------------------------------------------------

export interface CompactionSummary {
  workspaceId: bigint;
  startedAt: Date;
  finishedAt: Date;
  /** Count of lessons disabled because they were stale + low-confidence. */
  retiredStaleCount: number;
  /** Count of lessons disabled because they were merged into a survivor. */
  retiredMergedCount: number;
  /** Count of clusters where the AI chose to keep everything as-is. */
  keptClusters: number;
  /** Count of clusters that triggered an AI merge. */
  mergedClusters: number;
  /** Count of lessons NOT examined (singleton clusters auto-skip). */
  skippedSingletons: number;
  /** Chunks skipped without an AI call: nothing in them changed since
   *  the previous compaction run (that run already reviewed them). */
  skippedUnchangedClusters: number;
  /** Chunks skipped without an AI call: stored embeddings show no pair
   *  anywhere near merge similarity. */
  skippedDistinctClusters: number;
}

// ---- entry point -------------------------------------------------------

/**
 * Run a full compaction pass for the workspace. Admin-gated. Emits one
 * `knowledge.compaction.run` audit event per call, plus per-merge /
 * per-retire detail events.
 */
export async function compactWorkspaceKnowledge(
  ctx: WorkspaceContext,
): Promise<CompactionSummary> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('knowledge.compact');
  const startedAt = new Date();

  const retiredStaleCount = await retireStaleLessons(ctx);
  const pass = await runClusterPass(ctx, { swallowErrors: false });

  const finishedAt = new Date();
  const summary: CompactionSummary = {
    workspaceId: ctx.workspaceId,
    startedAt,
    finishedAt,
    retiredStaleCount,
    ...pass,
  };

  await recordAuditEvent(ctx, {
    kind: 'knowledge.compaction.run',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: {
      ...summary,
      workspaceId: summary.workspaceId.toString(),
      startedAt: summary.startedAt.toISOString(),
      finishedAt: summary.finishedAt.toISOString(),
    },
  });
  return summary;
}

/**
 * Cron-friendly variant: run for one workspace without an operator context.
 * Skips permission check (the cron handler is trusted) and writes a
 * platform audit event instead of a workspace one to keep the trail
 * tied to the worker, not a phantom user.
 */
export async function compactWorkspaceKnowledgeUnattended(
  workspaceId: bigint,
): Promise<CompactionSummary> {
  // Synthesize a bare write-context. The downstream queries only read
  // ctx.workspaceId; nothing in this service needs userId/role.
  const ctx = { workspaceId, userId: 'system', role: 'admin' as const };
  const startedAt = new Date();

  const retiredStaleCount = await retireStaleLessons(ctx);
  const pass = await runClusterPass(ctx, { swallowErrors: true });

  const finishedAt = new Date();
  const summary: CompactionSummary = {
    workspaceId,
    startedAt,
    finishedAt,
    retiredStaleCount,
    ...pass,
  };

  await recordPlatformAuditEvent(null, {
    kind: 'knowledge.compaction.run',
    entityType: 'workspace',
    entityId: workspaceId,
    payload: {
      ...summary,
      workspaceId: summary.workspaceId.toString(),
      startedAt: summary.startedAt.toISOString(),
      finishedAt: summary.finishedAt.toISOString(),
      mode: 'unattended',
    },
  });
  return summary;
}

// ---- shared cluster pass (with AI-cost guards) -------------------------

type ClusterPassResult = Omit<
  CompactionSummary,
  'workspaceId' | 'startedAt' | 'finishedAt' | 'retiredStaleCount'
>;

/**
 * The merge loop shared by the attended and unattended entry points, with
 * two guards that skip the (billable) AI merge call when it cannot
 * possibly pay off:
 *   1. UNCHANGED: no lesson in the chunk was created or touched since the
 *      previous compaction run — that run already reviewed exactly this
 *      material and chose to keep it.
 *   2. DISTINCT: every lesson in the chunk has a stored embedding and no
 *      pair reaches MERGE_CANDIDATE_SIMILARITY — nothing is close enough
 *      to be a merge candidate. (Chunks with missing embeddings fall
 *      through to the AI, never silently skip.)
 */
async function runClusterPass(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId' | 'role'>,
  options: { swallowErrors: boolean },
): Promise<ClusterPassResult> {
  const lastRun = await lastCompactionRun(ctx);
  const clusters = await loadClusters(ctx);
  const result: ClusterPassResult = {
    retiredMergedCount: 0,
    keptClusters: 0,
    mergedClusters: 0,
    skippedSingletons: 0,
    skippedUnchangedClusters: 0,
    skippedDistinctClusters: 0,
  };

  for (const cluster of clusters) {
    if (cluster.length < CLUSTER_MIN) {
      result.skippedSingletons += cluster.length;
      continue;
    }
    // Chunk oversized clusters so the AI prompt stays bounded.
    for (let i = 0; i < cluster.length; i += CLUSTER_MAX) {
      const chunk = cluster.slice(i, i + CLUSTER_MAX);
      if (chunk.length < CLUSTER_MIN) {
        result.skippedSingletons += chunk.length;
        continue;
      }
      if (lastRun && chunk.every((l) => l.updatedAt < lastRun.at)) {
        result.skippedUnchangedClusters += 1;
        continue;
      }
      if (chunkIsClearlyDistinct(chunk)) {
        result.skippedDistinctClusters += 1;
        continue;
      }
      try {
        const merge = await mergeClusterWithAI(ctx, chunk);
        if (merge.action === 'merge') {
          result.mergedClusters += 1;
          result.retiredMergedCount += merge.retiredIds.length;
        } else {
          result.keptClusters += 1;
        }
      } catch (err) {
        if (!options.swallowErrors) throw err;
        console.error(
          `[knowledge-compaction] cluster merge failed for workspace ${ctx.workspaceId}:`,
          err,
        );
      }
    }
  }
  return result;
}

/** Guard 2: true only when every lesson has an embedding AND no pair is
 *  anywhere near merge similarity. */
function chunkIsClearlyDistinct(chunk: LearningLesson[]): boolean {
  if (chunk.some((l) => !l.embedding || l.embedding.length === 0)) return false;
  for (let a = 0; a < chunk.length; a++) {
    for (let b = a + 1; b < chunk.length; b++) {
      const va = chunk[a]!.embedding!;
      const vb = chunk[b]!.embedding!;
      if (va.length !== vb.length) return false;
      if (pairCosine(va, vb) >= MERGE_CANDIDATE_SIMILARITY) return false;
    }
  }
  return true;
}

function pairCosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ---- stale retirement (no AI needed) ----------------------------------

async function retireStaleLessons(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AGE_DAYS * 24 * 60 * 60 * 1000);
  const stale = await db
    .select({ id: learningLessons.id })
    .from(learningLessons)
    .where(
      and(
        eq(learningLessons.workspaceId, ctx.workspaceId),
        eq(learningLessons.enabled, true),
        lt(learningLessons.confidence, STALE_CONFIDENCE_THRESHOLD),
        or(
          isNull(learningLessons.lastAppliedAt),
          lt(learningLessons.lastAppliedAt, cutoff),
        ),
        lt(learningLessons.createdAt, cutoff),
      ),
    );
  if (stale.length === 0) return 0;
  const ids = stale.map((s) => s.id);
  await db
    .update(learningLessons)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(learningLessons.workspaceId, ctx.workspaceId),
        inArray(learningLessons.id, ids),
      ),
    );
  // One audit row for the whole batch — the ids array keeps the trail
  // queryable per-lesson without N sequential inserts.
  await recordPlatformAuditEvent(null, {
    kind: 'knowledge.compaction.retire_stale',
    entityType: 'learning_lesson',
    entityId: null,
    payload: {
      workspaceId: ctx.workspaceId.toString(),
      ids: ids.map((id) => id.toString()),
      count: ids.length,
    },
  });
  return ids.length;
}

// ---- cluster loading ---------------------------------------------------

/**
 * Group enabled lessons by (productProfileId, category). null productProfileId
 * forms its own group. Returned ordered for deterministic compaction (newer
 * survives merges by default — the AI overrides this with explicit choice).
 */
async function loadClusters(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<LearningLesson[][]> {
  const rows = await db
    .select()
    .from(learningLessons)
    .where(
      and(
        eq(learningLessons.workspaceId, ctx.workspaceId),
        eq(learningLessons.enabled, true),
      ),
    );

  const groups = new Map<string, LearningLesson[]>();
  for (const row of rows) {
    const key = `${row.productProfileId?.toString() ?? 'null'}::${row.category}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return Array.from(groups.values());
}

// ---- AI merge ----------------------------------------------------------

const MergeDecisionSchema = z.object({
  action: z.enum(['merge', 'keep_all']),
  /** When action='merge': 0-based index of the lesson in the input array
   *  whose row will be updated to hold the consolidated rule. The other
   *  retireIndices entries are disabled. */
  survivorIndex: z.number().int().min(0).optional(),
  /** When action='merge': the consolidated one-sentence rule. */
  consolidatedRule: z.string().optional(),
  /** When action='merge': 0-based indices to disable. Must NOT include
   *  survivorIndex. May be empty (then it's effectively keep_all). */
  retireIndices: z.array(z.number().int().min(0)).optional(),
});

const MERGE_SYSTEM_PROMPT = `You compact a cluster of workspace knowledge rules. All rules in the cluster share the same product scope and category.

Decide one of:
- "keep_all": rules are distinct and worth keeping separately.
- "merge": at least one rule is a near-duplicate of another. Pick the survivor (the rule whose intent is broadest / most generalizable), provide a consolidated one-sentence rule that captures the merged intent, and list 0-based indices of the OTHER rules to retire.

Strict JSON output:
{
  "action": "keep_all" | "merge",
  "survivorIndex": <number, only when action="merge">,
  "consolidatedRule": "<one sentence, only when action='merge'>",
  "retireIndices": [<numbers>, only when action="merge", excluding survivorIndex]
}

Be conservative — only merge when the rules genuinely overlap. Different examples of the SAME underlying rule are merge candidates; two genuinely different rules in the same category are not. Output JSON only.`;

interface MergeOutcome {
  action: 'merge' | 'keep_all';
  retiredIds: bigint[];
}

async function mergeClusterWithAI(
  ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId' | 'role'>,
  cluster: LearningLesson[],
): Promise<MergeOutcome> {
  const provider = await getAIProviderForCtx(ctx);
  const indexed = cluster
    .map(
      (l, i) =>
        `${i}. [conf=${l.confidence}, apps=${l.applicationCount}] ${l.rule}`,
    )
    .join('\n');
  const userPrompt = `Cluster (${cluster.length} lessons, category=${cluster[0]?.category ?? 'unknown'}):\n${indexed}`;

  const decision = await provider.generateJson(
    { system: MERGE_SYSTEM_PROMPT, prompt: userPrompt },
    MergeDecisionSchema,
    {
      maxTokens: 512,
      temperature: 0,
      mockSeed: `knowledge.compact:${cluster.map((l) => l.id.toString()).join(',')}`,
    },
  );

  if (decision.action !== 'merge') {
    return { action: 'keep_all', retiredIds: [] };
  }

  const survivorIdx = decision.survivorIndex ?? 0;
  const retireIdx = (decision.retireIndices ?? []).filter(
    (i) => i !== survivorIdx && i >= 0 && i < cluster.length,
  );
  if (retireIdx.length === 0) {
    return { action: 'keep_all', retiredIds: [] };
  }
  const survivor = cluster[survivorIdx];
  if (!survivor) return { action: 'keep_all', retiredIds: [] };

  const retiredLessons = retireIdx
    .map((i) => cluster[i])
    .filter((l): l is LearningLesson => Boolean(l));
  const retiredIds = retiredLessons.map((l) => l.id);

  // Union evidence event ids so the survivor traces back to ALL the
  // signals — never silently drop the origin chain.
  const unionedEvidence = Array.from(
    new Set<bigint>([
      ...survivor.evidenceEventIds,
      ...retiredLessons.flatMap((l) => l.evidenceEventIds),
    ]),
  );

  const consolidatedRule = decision.consolidatedRule?.trim() || survivor.rule;

  await db.transaction(async (tx) => {
    await tx
      .update(learningLessons)
      .set({
        rule: consolidatedRule.slice(0, 1000),
        evidenceEventIds: unionedEvidence,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(learningLessons.workspaceId, ctx.workspaceId),
          eq(learningLessons.id, survivor.id),
        ),
      );
    await tx
      .update(learningLessons)
      .set({ enabled: false, updatedAt: new Date() })
      .where(
        and(
          eq(learningLessons.workspaceId, ctx.workspaceId),
          inArray(learningLessons.id, retiredIds),
        ),
      );
  });

  await recordPlatformAuditEvent(null, {
    kind: 'knowledge.compaction.merge',
    entityType: 'learning_lesson',
    entityId: survivor.id,
    payload: {
      workspaceId: ctx.workspaceId.toString(),
      survivorId: survivor.id.toString(),
      retiredIds: retiredIds.map((id) => id.toString()),
      consolidatedRule,
    },
  });

  // The survivor's rule text changed — refresh its embedding so semantic
  // retrieval matches the consolidated wording, not the pre-merge one.
  if (consolidatedRule !== survivor.rule) {
    const { scheduleLessonEmbedding } = await import('./learning');
    scheduleLessonEmbedding(ctx as WorkspaceContext, survivor.id);
  }

  return { action: 'merge', retiredIds };
}

// ---- introspection (for the UI panel) ---------------------------------

export async function lastCompactionRun(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<{
  at: Date;
  summary: Record<string, unknown>;
} | null> {
  const { auditLog } = await import('@/lib/db/schema/audit');
  const { desc } = await import('drizzle-orm');
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, ctx.workspaceId),
        eq(auditLog.kind, 'knowledge.compaction.run'),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // Fallback: unattended runs write platform audit events with no
    // workspace_id. Surface the most recent one for this workspace.
    const platformRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          isNull(auditLog.workspaceId),
          eq(auditLog.kind, 'knowledge.compaction.run'),
          // payload->>workspaceId === ctx.workspaceId
          sql`${auditLog.payload}->>'workspaceId' = ${ctx.workspaceId.toString()}`,
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    const p = platformRows[0];
    if (!p) return null;
    return { at: p.createdAt, summary: (p.payload as Record<string, unknown>) ?? {} };
  }
  return { at: row.createdAt, summary: (row.payload as Record<string, unknown>) ?? {} };
}
