// Connector / Run service. Workspace-scoped CRUD on connectors + recipes,
// plus run lifecycle (start, status, list).

import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  connectorRecipes,
  connectorRuns,
  connectorRunLogs,
  connectors,
  sourceRecords,
  type Connector,
  type ConnectorRecipe,
  type ConnectorRun,
  type NewConnector,
  type NewConnectorRecipe,
  type NewConnectorRun,
} from '@/lib/db/schema/connectors';
import { type RunResult } from '@/lib/connectors/runner';
import { getJobQueue } from '@/lib/jobs';
import { registerJobHandlers, type ConnectorRunJobPayload } from '@/lib/jobs/bootstrap';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, canWrite, type WorkspaceContext } from './context';

export class ConnectorServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ConnectorServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new ConnectorServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = (kind: string) =>
  new ConnectorServiceError(`${kind} not found`, 'not_found');
const invariant = (msg: string) =>
  new ConnectorServiceError(msg, 'invariant_violation');

// ---- connectors -------------------------------------------------------

export async function createConnector(
  ctx: WorkspaceContext,
  input: Omit<NewConnector, 'workspaceId'>,
): Promise<Connector> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('create connector');
  const row: NewConnector = { ...input, workspaceId: ctx.workspaceId };
  const inserted = await db.insert(connectors).values(row).returning();
  const connector = inserted[0];
  if (!connector) throw invariant('connectors insert returned no row');
  await recordAuditEvent(ctx, {
    kind: 'connector.create',
    entityType: 'connector',
    entityId: connector.id,
    payload: { templateType: connector.templateType, name: connector.name },
  });
  return connector;
}

export async function listConnectors(ctx: WorkspaceContext): Promise<Connector[]> {
  return db
    .select()
    .from(connectors)
    .where(eq(connectors.workspaceId, ctx.workspaceId))
    .orderBy(desc(connectors.updatedAt));
}

export async function getConnectorRow(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<Connector> {
  const rows = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.workspaceId, ctx.workspaceId), eq(connectors.id, id)));
  const c = rows[0];
  if (!c) throw notFound('connector');
  return c;
}

// ---- recipes ----------------------------------------------------------

export async function createRecipe(
  ctx: WorkspaceContext,
  input: Omit<NewConnectorRecipe, 'workspaceId' | 'templateType'>,
): Promise<ConnectorRecipe> {
  if (!canWrite(ctx)) throw permissionDenied('create recipe');
  // Resolve templateType from parent connector (which lives in this workspace).
  const parent = await getConnectorRow(ctx, input.connectorId);
  const row: NewConnectorRecipe = {
    ...input,
    workspaceId: ctx.workspaceId,
    templateType: parent.templateType,
  };
  const inserted = await db.insert(connectorRecipes).values(row).returning();
  const recipe = inserted[0];
  if (!recipe) throw invariant('connector_recipes insert returned no row');
  await recordAuditEvent(ctx, {
    kind: 'connector_recipe.create',
    entityType: 'connector_recipe',
    entityId: recipe.id,
    payload: { connectorId: parent.id.toString(), name: recipe.name },
  });
  return recipe;
}

export async function listRecipes(
  ctx: WorkspaceContext,
  connectorId?: bigint,
): Promise<ConnectorRecipe[]> {
  const conds = [eq(connectorRecipes.workspaceId, ctx.workspaceId)];
  if (connectorId !== undefined) conds.push(eq(connectorRecipes.connectorId, connectorId));
  return db
    .select()
    .from(connectorRecipes)
    .where(and(...conds))
    .orderBy(desc(connectorRecipes.updatedAt));
}

export async function getRecipe(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<ConnectorRecipe> {
  const rows = await db
    .select()
    .from(connectorRecipes)
    .where(
      and(eq(connectorRecipes.workspaceId, ctx.workspaceId), eq(connectorRecipes.id, id)),
    );
  const r = rows[0];
  if (!r) throw notFound('connector_recipe');
  return r;
}

// ---- runs -------------------------------------------------------------

export interface StartRunInput {
  connectorId: bigint;
  recipeId?: bigint | null;
  productProfileIds?: bigint[];
  /**
   * If true, awaitRun() is called internally and `result` is populated.
   * Mostly useful for tests and CLI tools; UI flows should leave this false
   * and let the user navigate to the run page (which polls via reload).
   */
  wait?: boolean;
  /** Max ms to wait when wait:true. Default 60s. */
  waitTimeoutMs?: number;
}

/**
 * Start a connector run. Inserts the connector_runs row in `pending` state
 * and enqueues a `connector.run` job. The job handler (registered via
 * registerJobHandlers) drives the execution.
 *
 * - With JOB_QUEUE_PROVIDER=memory the handler runs on the next microtask.
 * - With JOB_QUEUE_PROVIDER=bullmq the handler runs in a Worker process.
 *
 * Returns the pending run row immediately. Pass `wait:true` (typically in
 * tests) to block until the job reaches a terminal state.
 */
export async function startRun(
  ctx: WorkspaceContext,
  input: StartRunInput,
): Promise<{ run: ConnectorRun; jobId: string; result?: RunResult }> {
  if (!canWrite(ctx)) throw permissionDenied('start connector run');

  const connector = await getConnectorRow(ctx, input.connectorId);
  if (!connector.active) {
    throw new ConnectorServiceError(
      'cannot start run: connector is inactive',
      'conflict',
    );
  }

  let recipeSnapshot: Record<string, unknown> | null = null;
  const recipeId: bigint | null = input.recipeId ?? null;
  if (recipeId !== null) {
    const recipe = await getRecipe(ctx, recipeId);
    if (recipe.connectorId !== connector.id) {
      throw new ConnectorServiceError(
        'recipe does not belong to the requested connector',
        'invalid_input',
      );
    }
    recipeSnapshot = freezeRecipe(recipe);
  }

  const newRow: NewConnectorRun = {
    workspaceId: ctx.workspaceId,
    connectorId: connector.id,
    recipeId,
    productProfileIds: input.productProfileIds ?? [],
    status: 'pending',
    recipeSnapshot,
  };

  const inserted = await db.insert(connectorRuns).values(newRow).returning();
  const created = inserted[0];
  if (!created) throw invariant('connector_runs insert returned no row');

  await recordAuditEvent(ctx, {
    kind: 'connector_run.start',
    entityType: 'connector_run',
    entityId: created.id,
    payload: {
      connectorId: connector.id.toString(),
      recipeId: recipeId?.toString() ?? null,
      productProfileIds: (input.productProfileIds ?? []).map((id) => id.toString()),
    },
  });

  // Make sure handlers are wired before we enqueue. Idempotent.
  registerJobHandlers();
  const queue = getJobQueue();
  const payload: ConnectorRunJobPayload = {
    runId: created.id.toString(),
    workspaceId: ctx.workspaceId.toString(),
    userId: ctx.userId,
    role: ctx.role,
  };
  const jobId = await queue.enqueue<ConnectorRunJobPayload>('connector.run', payload);

  if (input.wait) {
    const timeoutMs = input.waitTimeoutMs ?? 60_000;
    const result = await awaitRun(ctx, created.id, { timeoutMs });
    const reloaded = await getRun(ctx, created.id);
    await recordAuditEvent(ctx, {
      kind: 'connector_run.complete',
      entityType: 'connector_run',
      entityId: created.id,
      payload: { status: result.status, recordCount: result.recordCount },
    });
    return { run: reloaded, jobId, result };
  }

  return { run: created, jobId };
}

export interface AwaitRunOptions {
  /** Max ms to wait. Throws if exceeded. Default 60s. */
  timeoutMs?: number;
  /** Initial poll interval. Backs off up to 1s. Default 50ms. */
  initialIntervalMs?: number;
}

/**
 * Block until a connector run reaches a terminal state (succeeded /
 * failed / cancelled). Polls connector_runs.status with backoff.
 */
export async function awaitRun(
  ctx: WorkspaceContext,
  runId: bigint,
  options: AwaitRunOptions = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const start = Date.now();
  let interval = options.initialIntervalMs ?? 50;

  while (Date.now() - start < timeoutMs) {
    const run = await getRun(ctx, runId);
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      const result: RunResult = {
        status: run.status,
        recordCount: run.recordCount,
      };
      if (run.errorPayload) {
        const ep = run.errorPayload as { message?: string; payload?: unknown };
        if (ep.message) {
          result.error = { message: ep.message };
          if (ep.payload !== undefined) result.error.payload = ep.payload;
        }
      }
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 2, 1000);
  }
  throw new ConnectorServiceError(
    `awaitRun: timed out after ${timeoutMs}ms (run ${runId} did not reach terminal state)`,
    'timeout',
  );
}

export async function getRun(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<ConnectorRun> {
  const rows = await db
    .select()
    .from(connectorRuns)
    .where(and(eq(connectorRuns.workspaceId, ctx.workspaceId), eq(connectorRuns.id, id)));
  const run = rows[0];
  if (!run) throw notFound('connector_run');
  return run;
}

export async function listRuns(ctx: WorkspaceContext): Promise<ConnectorRun[]> {
  return db
    .select()
    .from(connectorRuns)
    .where(eq(connectorRuns.workspaceId, ctx.workspaceId))
    .orderBy(desc(connectorRuns.createdAt));
}

export async function listRunLogs(ctx: WorkspaceContext, runId: bigint) {
  // Workspace-scope check via the run row.
  await getRun(ctx, runId);
  return db
    .select()
    .from(connectorRunLogs)
    .where(eq(connectorRunLogs.runId, runId))
    .orderBy(connectorRunLogs.createdAt);
}

export async function listSourceRecords(
  ctx: WorkspaceContext,
  runId: bigint,
) {
  await getRun(ctx, runId);
  return db
    .select()
    .from(sourceRecords)
    .where(
      and(eq(sourceRecords.workspaceId, ctx.workspaceId), eq(sourceRecords.runId, runId)),
    )
    .orderBy(desc(sourceRecords.createdAt));
}

function freezeRecipe(recipe: ConnectorRecipe): Record<string, unknown> {
  // Stored as JSONB; we keep just the fields a connector might consume.
  return {
    name: recipe.name,
    seedUrls: recipe.seedUrls,
    searchQueries: recipe.searchQueries,
    selectors: recipe.selectors,
    paginationRules: recipe.paginationRules,
    enrichmentRules: recipe.enrichmentRules,
    normalizationMapping: recipe.normalizationMapping,
    evidenceRules: recipe.evidenceRules,
    // Mock connector reads `seed`, `count`, `delayMs`, `failAfter` from
    // top-level recipe — exposed via selectors / paginationRules /
    // enrichmentRules in the future. Phase 3 mock takes the recipe row's
    // jsonb fields as-is so tests can pass `{seed, count, ...}`.
    ...flattenJsonb(recipe.selectors),
  };
}

function flattenJsonb(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}
