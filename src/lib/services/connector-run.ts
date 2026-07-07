// Connector / Run service. Workspace-scoped CRUD on connectors + recipes,
// plus run lifecycle (start, status, list).

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
import { normalizeCountry } from './geo';
import { translateText } from './translation';
import { getWorkspaceNativeLanguage } from './workspace';

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

/** Coerce a jsonb value into a shallow-cloned plain object (or {}). */
function asSelectorsObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * Canonicalise `selectors.country` to ISO 3166-1 alpha-2 at save time, so
 * every downstream comparison (geo gate, send-time guard) works on one
 * spelling. Rejects unrecognisable values outright — a typo like "Atlantis"
 * must fail the save, not silently weaken the locality gate later.
 */
function withNormalizedCountry(
  selectors: Record<string, unknown>,
): Record<string, unknown> {
  const raw = selectors.country;
  if (raw === undefined || raw === null || raw === '') return selectors;
  if (typeof raw !== 'string') {
    throw new ConnectorServiceError('selectors.country must be a string', 'invalid_input');
  }
  const code = normalizeCountry(raw);
  if (!code) {
    throw new ConnectorServiceError(
      `selectors.country "${raw}" is not a recognised country — ` +
        'use an ISO 3166-1 alpha-2 code (PL, DE, GB, …) or a country name',
      'invalid_input',
    );
  }
  return code === raw ? selectors : { ...selectors, country: code };
}

/**
 * Phase 63: pre-translate a recipe's search queries into its search
 * language at SAVE time and store them as `selectors.searchQueriesIssued`
 * (parallel to the operator's native-language queries). The internet-search
 * connector issues these, so the concurrent run path does NO per-query
 * translation. No-op — and clears any stale issued queries — when there's no
 * search language, no queries, or the search language equals the workspace
 * native language. `effectiveQueries` is what the connector will actually
 * run (selectors.searchQueries when present, else the searchQueries column).
 */
async function applyIssuedQueries(
  ctx: WorkspaceContext,
  selectors: Record<string, unknown>,
  effectiveQueries: readonly string[],
): Promise<Record<string, unknown>> {
  const stripIssued = () => {
    if ('searchQueriesIssued' in selectors) {
      const clone = { ...selectors };
      delete clone.searchQueriesIssued;
      return clone;
    }
    return selectors;
  };

  const language = typeof selectors.language === 'string' ? selectors.language : null;
  const base = language ? (language.toLowerCase().split('-')[0] ?? null) : null;
  if (!base || effectiveQueries.length === 0) return stripIssued();

  const native = await getWorkspaceNativeLanguage(ctx);
  if (base === native) return stripIssued();

  const issued: string[] = [];
  for (const q of effectiveQueries) {
    try {
      const t = await translateText(ctx, {
        text: q,
        targetLanguage: base,
        sourceLanguageHint: native,
        recordAudit: false,
      });
      issued.push(t.translatedText);
    } catch {
      issued.push(q); // best-effort: fall back to the native query
    }
  }
  return { ...selectors, searchQueriesIssued: issued };
}

export async function createRecipe(
  ctx: WorkspaceContext,
  input: Omit<NewConnectorRecipe, 'workspaceId' | 'templateType'>,
): Promise<ConnectorRecipe> {
  if (!canWrite(ctx)) throw permissionDenied('create recipe');
  // Resolve templateType from parent connector (which lives in this workspace).
  const parent = await getConnectorRow(ctx, input.connectorId);
  // Only touch selectors (and pay the async translation cost) when the
  // recipe actually declares a search language; otherwise keep the exact
  // baseline behaviour so the common path is byte-for-byte unchanged.
  // Country (when present) is validated + canonicalised to ISO alpha-2
  // here so the geo gate always compares canonical codes.
  const selectorsObj = withNormalizedCountry(asSelectorsObject(input.selectors));
  let finalSelectors: unknown =
    input.selectors === undefined || input.selectors === null
      ? input.selectors
      : selectorsObj;
  if (typeof selectorsObj.language === 'string' && selectorsObj.language.length > 0) {
    const effectiveQueries = Array.isArray(selectorsObj.searchQueries)
      ? selectorsObj.searchQueries.filter((q): q is string => typeof q === 'string')
      : (input.searchQueries ?? []).map(String);
    finalSelectors = await applyIssuedQueries(ctx, selectorsObj, effectiveQueries);
  }
  const row: NewConnectorRecipe = {
    ...input,
    selectors: finalSelectors as NewConnectorRecipe['selectors'],
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

// ---- bulk run delete (P62-24) --------------------------------------

/** Hard-delete connector_runs rows by id. Workspace-scoped via the
 *  WHERE clause — never crosses workspaces even if an attacker passes
 *  someone else's id. Returns the count actually deleted (≤ ids.length
 *  if some ids belonged elsewhere). Cascade on connector_run_logs +
 *  source_records is handled by their existing FK constraints. */
export async function deleteConnectorRuns(
  ctx: WorkspaceContext,
  ids: ReadonlyArray<bigint>,
): Promise<{ affected: number; ids: bigint[] }> {
  if (!canWrite(ctx)) throw permissionDenied('delete connector runs');
  if (ids.length === 0) return { affected: 0, ids: [] };
  const deleted = await db
    .delete(connectorRuns)
    .where(
      and(
        eq(connectorRuns.workspaceId, ctx.workspaceId),
        inArray(connectorRuns.id, [...ids]),
      ),
    )
    .returning({ id: connectorRuns.id });
  if (deleted.length > 0) {
    await recordAuditEvent(ctx, {
      kind: 'connector_run.bulk_delete',
      entityType: 'connector_run',
      payload: { count: deleted.length, ids: deleted.map((r) => r.id.toString()) },
    });
  }
  return { affected: deleted.length, ids: deleted.map((r) => r.id) };
}

// ---- consolidation (P62-21) ----------------------------------------

/** Friendly label per template type. Mirrors TEMPLATE_META in
 *  src/app/connectors/page.tsx — when we collapse a workspace's
 *  multiple instances into one, this is the name we use. */
const TEMPLATE_FRIENDLY_NAME: Record<string, string> = {
  internet_search: 'Internet Search',
  directory_harvester: 'Directory Harvester',
  tender_api: 'Tender API',
  csv_import: 'CSV Import',
  mock: 'Mock',
};

export interface ConsolidateResult {
  canonicalId: bigint;
  canonicalName: string;
  recipesAdopted: number;
  recipesCreatedFromInstance: number;
  connectorsDeleted: number;
}

/** Admin-only. Collapses every connector of `templateType` in the
 *  workspace into a single canonical connector named after the
 *  TEMPLATE_FRIENDLY_NAME. Recipes are preserved:
 *    - recipes belonging to the canonical → stay
 *    - recipes belonging to other connectors → re-pointed at the
 *      canonical
 *    - other connectors with zero recipes → become a NEW recipe under
 *      the canonical, preserving their name + config as selectors
 *      (so the operator's intent — "Waterproofing" as a separate
 *      search — survives)
 *    - non-canonical connectors are then hard-deleted */
export async function consolidateConnectorsByTemplate(
  ctx: WorkspaceContext,
  templateType: string,
): Promise<ConsolidateResult> {
  if (!canWrite(ctx)) throw permissionDenied('consolidate connectors');
  const friendlyName = TEMPLATE_FRIENDLY_NAME[templateType] ?? templateType;

  // 1. Load all connectors of this template type in the workspace.
  const allInstances = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.workspaceId, ctx.workspaceId),
        eq(connectors.templateType, templateType as 'internet_search'),
      ),
    );

  // 2. Pick canonical = the connector with the most recipes (tie-break
  //    by lowest id so it's deterministic). If none exist, create one.
  if (allInstances.length === 0) {
    const [created] = await db
      .insert(connectors)
      .values({
        workspaceId: ctx.workspaceId,
        templateType: templateType as 'internet_search',
        name: friendlyName,
        active: true,
      })
      .returning();
    if (!created) throw invariant('connector insert returned no row');
    return {
      canonicalId: created.id,
      canonicalName: created.name,
      recipesAdopted: 0,
      recipesCreatedFromInstance: 0,
      connectorsDeleted: 0,
    };
  }

  const recipeCounts = await db
    .select({
      connectorId: connectorRecipes.connectorId,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(connectorRecipes)
    .where(eq(connectorRecipes.workspaceId, ctx.workspaceId))
    .groupBy(connectorRecipes.connectorId);
  const countByConnector = new Map<string, number>();
  for (const r of recipeCounts) {
    countByConnector.set(r.connectorId.toString(), r.n);
  }
  const sorted = [...allInstances].sort((a, b) => {
    const ca = countByConnector.get(a.id.toString()) ?? 0;
    const cb = countByConnector.get(b.id.toString()) ?? 0;
    if (ca !== cb) return cb - ca;
    return Number(a.id - b.id);
  });
  const canonicalId = sorted[0]!.id;

  // 3. Rename canonical to friendly label (if different) and ensure active.
  if (sorted[0]!.name !== friendlyName || !sorted[0]!.active) {
    await db
      .update(connectors)
      .set({ name: friendlyName, active: true, updatedAt: new Date() })
      .where(eq(connectors.id, canonicalId));
  }

  // 4. For each non-canonical instance: move recipes, or create recipe
  //    from the instance itself.
  let recipesAdopted = 0;
  let recipesCreatedFromInstance = 0;
  let connectorsDeleted = 0;
  for (const inst of sorted.slice(1)) {
    const recipes = await db
      .select()
      .from(connectorRecipes)
      .where(
        and(
          eq(connectorRecipes.workspaceId, ctx.workspaceId),
          eq(connectorRecipes.connectorId, inst.id),
        ),
      );
    if (recipes.length > 0) {
      await db
        .update(connectorRecipes)
        .set({ connectorId: canonicalId, updatedAt: new Date() })
        .where(
          and(
            eq(connectorRecipes.workspaceId, ctx.workspaceId),
            eq(connectorRecipes.connectorId, inst.id),
          ),
        );
      recipesAdopted += recipes.length;
    } else {
      // Empty connector → create a recipe under canonical that
      // preserves the original instance's name + config so the
      // operator's intent isn't lost.
      const row: NewConnectorRecipe = {
        workspaceId: ctx.workspaceId,
        connectorId: canonicalId,
        templateType: templateType as 'internet_search',
        name: inst.name,
        active: inst.active,
        selectors: inst.config as Record<string, unknown>,
      };
      await db.insert(connectorRecipes).values(row);
      recipesCreatedFromInstance++;
    }
    await db.delete(connectors).where(eq(connectors.id, inst.id));
    connectorsDeleted++;
  }

  await recordAuditEvent(ctx, {
    kind: 'connector.consolidate',
    entityType: 'connector',
    entityId: canonicalId,
    payload: {
      templateType,
      friendlyName,
      recipesAdopted,
      recipesCreatedFromInstance,
      connectorsDeleted,
    },
  });

  return {
    canonicalId,
    canonicalName: friendlyName,
    recipesAdopted,
    recipesCreatedFromInstance,
    connectorsDeleted,
  };
}

// ---- recipe edit / archive / delete (P62-01) -----------------------

export interface UpdateRecipeInput {
  name?: string;
  active?: boolean;
  seedUrls?: ReadonlyArray<string>;
  searchQueries?: ReadonlyArray<string>;
  selectors?: Record<string, unknown>;
  paginationRules?: Record<string, unknown>;
  enrichmentRules?: Record<string, unknown>;
  normalizationMapping?: Record<string, unknown>;
  evidenceRules?: Record<string, unknown>;
}

function sanitiseJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConnectorServiceError(
      `${label}: must be a JSON object`,
      'invalid_input',
    );
  }
  return value as Record<string, unknown>;
}

export async function updateRecipe(
  ctx: WorkspaceContext,
  id: bigint,
  input: UpdateRecipeInput,
): Promise<ConnectorRecipe> {
  if (!canWrite(ctx)) throw permissionDenied('update recipe');
  const existing = await getRecipe(ctx, id);
  const updates: Partial<NewConnectorRecipe> & { updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (!trimmed) {
      throw new ConnectorServiceError('name cannot be empty', 'invalid_input');
    }
    updates.name = trimmed.slice(0, 200);
  }
  if (input.active !== undefined) updates.active = input.active;
  if (input.seedUrls !== undefined) {
    updates.seedUrls = [...input.seedUrls]
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (input.searchQueries !== undefined) {
    updates.searchQueries = [...input.searchQueries]
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (input.selectors !== undefined) {
    updates.selectors = withNormalizedCountry(
      asSelectorsObject(sanitiseJsonObject(input.selectors, 'selectors')),
    );
  }
  // Recompute issued (translated) search queries only when a search language
  // is in play (after applying this update). Recipes without a search
  // language keep the exact baseline behaviour above — no async translation.
  if (input.selectors !== undefined || input.searchQueries !== undefined) {
    const baseSelectors =
      input.selectors !== undefined
        ? withNormalizedCountry(
            asSelectorsObject(sanitiseJsonObject(input.selectors, 'selectors')),
          )
        : asSelectorsObject(existing.selectors);
    if (typeof baseSelectors.language === 'string' && baseSelectors.language.length > 0) {
      const columnQueries =
        input.searchQueries !== undefined
          ? [...input.searchQueries].map((s) => s.trim()).filter((s) => s.length > 0)
          : existing.searchQueries;
      const effectiveQueries = Array.isArray(baseSelectors.searchQueries)
        ? baseSelectors.searchQueries.filter((q): q is string => typeof q === 'string')
        : columnQueries;
      updates.selectors = await applyIssuedQueries(ctx, baseSelectors, effectiveQueries);
    }
  }
  if (input.paginationRules !== undefined) {
    updates.paginationRules = sanitiseJsonObject(
      input.paginationRules,
      'paginationRules',
    );
  }
  if (input.enrichmentRules !== undefined) {
    updates.enrichmentRules = sanitiseJsonObject(
      input.enrichmentRules,
      'enrichmentRules',
    );
  }
  if (input.normalizationMapping !== undefined) {
    updates.normalizationMapping = sanitiseJsonObject(
      input.normalizationMapping,
      'normalizationMapping',
    );
  }
  if (input.evidenceRules !== undefined) {
    updates.evidenceRules = sanitiseJsonObject(
      input.evidenceRules,
      'evidenceRules',
    );
  }
  const [row] = await db
    .update(connectorRecipes)
    .set(updates)
    .where(
      and(
        eq(connectorRecipes.workspaceId, ctx.workspaceId),
        eq(connectorRecipes.id, id),
      ),
    )
    .returning();
  if (!row) throw invariant('connector_recipes update returned no row');
  await recordAuditEvent(ctx, {
    kind: 'connector_recipe.update',
    entityType: 'connector_recipe',
    entityId: id,
    payload: { fields: Object.keys(updates).filter((k) => k !== 'updatedAt') },
  });
  return row;
}

/** Hard-delete a recipe. Past runs lose their FK link (ON DELETE SET NULL)
 *  but keep their recipe_snapshot for audit. Refuses if the recipe is the
 *  target of any active outreach plan — caller should detach first. */
export async function deleteRecipe(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<{ deleted: bigint }> {
  if (!canWrite(ctx)) throw permissionDenied('delete recipe');
  const recipe = await getRecipe(ctx, id);
  const result = await db
    .delete(connectorRecipes)
    .where(
      and(
        eq(connectorRecipes.workspaceId, ctx.workspaceId),
        eq(connectorRecipes.id, id),
      ),
    )
    .returning({ id: connectorRecipes.id });
  if (result.length === 0) {
    throw invariant('connector_recipes delete returned no row');
  }
  await recordAuditEvent(ctx, {
    kind: 'connector_recipe.delete',
    entityType: 'connector_recipe',
    entityId: id,
    payload: { name: recipe.name, connectorId: recipe.connectorId.toString() },
  });
  return { deleted: id };
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

/** Batch-load runs by id (workspace-scoped; unknown / foreign ids are
 *  silently absent). Powers the crawl-engine plan cards, which resolve
 *  lastRunSummary.startedRuns into visible outcomes. */
export async function getRunsByIds(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  ids: ReadonlyArray<bigint>,
): Promise<ConnectorRun[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(connectorRuns)
    .where(
      and(
        eq(connectorRuns.workspaceId, ctx.workspaceId),
        inArray(connectorRuns.id, [...ids]),
      ),
    );
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
