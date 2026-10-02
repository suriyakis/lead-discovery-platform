// KL-06 test helper: run the knowledge.index outbox of a workspace in this
// process, the way the job would — every due 'queued' row, repeatedly,
// until nothing due is left (a row in retry backoff stays queued).

import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { indexingJobs } from '@/lib/db/schema/rag';
import type { WorkspaceContext } from '@/lib/services/context';
import {
  runKnowledgeIndexJob,
  type IndexRunDeps,
  type IndexRunOutcome,
} from '@/lib/services/knowledge-indexing';

export async function runQueuedIndexJobs(
  ctx: WorkspaceContext,
  deps: IndexRunDeps = {},
): Promise<IndexRunOutcome[]> {
  const outcomes: IndexRunOutcome[] = [];
  for (let round = 0; round < 10; round++) {
    const rows = await db
      .select({ id: indexingJobs.id })
      .from(indexingJobs)
      .where(and(eq(indexingJobs.workspaceId, ctx.workspaceId), eq(indexingJobs.status, 'queued')))
      .orderBy(asc(indexingJobs.id));
    let progressed = false;
    for (const r of rows) {
      const outcome = await runKnowledgeIndexJob(ctx, r.id, deps);
      outcomes.push(outcome);
      if (outcome.kind !== 'skipped') progressed = true;
    }
    if (!progressed) break;
  }
  return outcomes;
}
