// Phase 62 — Crawl Engine. Schedules + fires connector runs on a
// per-workspace cadence with quiet-hour gating + recipe/product
// selection. The cron tick lives in repeatables.ts and just calls
// processDueCrawlPlans(); manual run uses runCrawlPlanNow().

import { and, asc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  connectorRecipes,
  crawlPlans,
  type CrawlPlan,
  type NewCrawlPlan,
} from '@/lib/db/schema/connectors';
import { productProfiles } from '@/lib/db/schema/products';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  canWrite,
  type WorkspaceContext,
} from './context';
import { startRun } from './connector-run';

export class CrawlEngineError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'CrawlEngineError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new CrawlEngineError(`Permission denied: ${op}`, 'permission_denied');
const notFound = () => new CrawlEngineError('crawl plan not found', 'not_found');
const invalid = (msg: string) =>
  new CrawlEngineError(msg, 'invalid_input');

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60; // one week

// ---- helpers --------------------------------------------------------

/** Return current local-hour (0–23) in a given IANA timezone. Used to
 *  evaluate the quiet-hour gate. Falls back to UTC if the timezone is
 *  bogus. */
export function currentLocalHour(now: Date, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    // 'en-US' + hour12=false formats midnight as "24" on some
    // Node versions — normalise to 0.
    const raw = parseInt(fmt.format(now), 10);
    if (Number.isFinite(raw)) return raw % 24;
  } catch {
    // fall through
  }
  return now.getUTCHours();
}

/** Returns true when the local hour falls inside the inclusive quiet
 *  window. A window with start > end wraps midnight (e.g., 22 → 6). */
export function isInQuietHours(
  hour: number,
  quietStart: number | null,
  quietEnd: number | null,
): boolean {
  if (quietStart === null || quietEnd === null) return false;
  if (quietStart === quietEnd) return false; // zero-width window = always on
  if (quietStart < quietEnd) {
    // simple range, e.g. 22..23 — only those two hours are quiet
    return hour >= quietStart && hour < quietEnd;
  }
  // wrapping range, e.g. 22..6
  return hour >= quietStart || hour < quietEnd;
}

/** Sanity-clamp + reject obviously bad input. Caller passes the field
 *  name for clearer error messages. */
function clampInterval(value: number): number {
  if (!Number.isInteger(value)) {
    throw invalid('intervalMinutes must be an integer');
  }
  if (value < MIN_INTERVAL_MINUTES) {
    throw invalid(`intervalMinutes must be ≥ ${MIN_INTERVAL_MINUTES}`);
  }
  if (value > MAX_INTERVAL_MINUTES) {
    throw invalid(`intervalMinutes must be ≤ ${MAX_INTERVAL_MINUTES}`);
  }
  return value;
}

function validateQuietHour(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 23) {
    throw invalid(`${field} must be an integer in [0, 23] or null`);
  }
  return value;
}

// ---- CRUD ----------------------------------------------------------

export interface CrawlPlanInput {
  name: string;
  enabled?: boolean;
  intervalMinutes: number;
  quietStartHour?: number | null;
  quietEndHour?: number | null;
  timezone?: string;
  recipeIds: ReadonlyArray<bigint>;
  productProfileIds: ReadonlyArray<bigint>;
}

export async function createCrawlPlan(
  ctx: WorkspaceContext,
  input: CrawlPlanInput,
): Promise<CrawlPlan> {
  if (!canWrite(ctx)) throw denied('crawl_plan.create');
  const name = input.name.trim();
  if (!name) throw invalid('name cannot be empty');
  const interval = clampInterval(input.intervalMinutes);
  const qs = validateQuietHour(input.quietStartHour ?? null, 'quietStartHour');
  const qe = validateQuietHour(input.quietEndHour ?? null, 'quietEndHour');
  if ((qs === null) !== (qe === null)) {
    throw invalid('quietStartHour and quietEndHour must both be set or both null');
  }
  await assertRecipesBelong(ctx, input.recipeIds);
  await assertProductsBelong(ctx, input.productProfileIds);

  const row: NewCrawlPlan = {
    workspaceId: ctx.workspaceId,
    name: name.slice(0, 200),
    enabled: input.enabled ?? true,
    intervalMinutes: interval,
    quietStartHour: qs,
    quietEndHour: qe,
    timezone: (input.timezone ?? 'Europe/Warsaw').trim() || 'Europe/Warsaw',
    recipeIds: [...input.recipeIds],
    productProfileIds: [...input.productProfileIds],
    nextRunAt: new Date(),
  };
  const [created] = await db.insert(crawlPlans).values(row).returning();
  if (!created) throw new CrawlEngineError('insert returned no row', 'invariant_violation');
  await recordAuditEvent(ctx, {
    kind: 'crawl_plan.create',
    entityType: 'crawl_plan',
    entityId: created.id,
    payload: { name: created.name, recipes: input.recipeIds.length, products: input.productProfileIds.length },
  });
  return created;
}

export interface UpdateCrawlPlanInput {
  name?: string;
  enabled?: boolean;
  intervalMinutes?: number;
  quietStartHour?: number | null;
  quietEndHour?: number | null;
  timezone?: string;
  recipeIds?: ReadonlyArray<bigint>;
  productProfileIds?: ReadonlyArray<bigint>;
}

export async function updateCrawlPlan(
  ctx: WorkspaceContext,
  id: bigint,
  input: UpdateCrawlPlanInput,
): Promise<CrawlPlan> {
  if (!canWrite(ctx)) throw denied('crawl_plan.update');
  const existing = await getCrawlPlan(ctx, id);
  const patch: Partial<NewCrawlPlan> & { updatedAt: Date } = { updatedAt: new Date() };

  if (input.name !== undefined) {
    const n = input.name.trim();
    if (!n) throw invalid('name cannot be empty');
    patch.name = n.slice(0, 200);
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.intervalMinutes !== undefined) {
    patch.intervalMinutes = clampInterval(input.intervalMinutes);
  }
  if (input.quietStartHour !== undefined) {
    patch.quietStartHour = validateQuietHour(
      input.quietStartHour,
      'quietStartHour',
    );
  }
  if (input.quietEndHour !== undefined) {
    patch.quietEndHour = validateQuietHour(input.quietEndHour, 'quietEndHour');
  }
  if (patch.quietStartHour !== undefined || patch.quietEndHour !== undefined) {
    const finalStart =
      patch.quietStartHour !== undefined
        ? patch.quietStartHour
        : existing.quietStartHour;
    const finalEnd =
      patch.quietEndHour !== undefined
        ? patch.quietEndHour
        : existing.quietEndHour;
    if ((finalStart === null) !== (finalEnd === null)) {
      throw invalid(
        'quietStartHour and quietEndHour must both be set or both null',
      );
    }
  }
  if (input.timezone !== undefined) {
    patch.timezone = input.timezone.trim() || 'Europe/Warsaw';
  }
  if (input.recipeIds !== undefined) {
    await assertRecipesBelong(ctx, input.recipeIds);
    patch.recipeIds = [...input.recipeIds];
  }
  if (input.productProfileIds !== undefined) {
    await assertProductsBelong(ctx, input.productProfileIds);
    patch.productProfileIds = [...input.productProfileIds];
  }

  const [row] = await db
    .update(crawlPlans)
    .set(patch)
    .where(
      and(eq(crawlPlans.workspaceId, ctx.workspaceId), eq(crawlPlans.id, id)),
    )
    .returning();
  if (!row) throw new CrawlEngineError('update returned no row', 'invariant_violation');
  await recordAuditEvent(ctx, {
    kind: 'crawl_plan.update',
    entityType: 'crawl_plan',
    entityId: id,
    payload: { fields: Object.keys(patch).filter((k) => k !== 'updatedAt') },
  });
  return row;
}

export async function deleteCrawlPlan(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw denied('crawl_plan.delete');
  await getCrawlPlan(ctx, id);
  await db
    .delete(crawlPlans)
    .where(
      and(eq(crawlPlans.workspaceId, ctx.workspaceId), eq(crawlPlans.id, id)),
    );
  await recordAuditEvent(ctx, {
    kind: 'crawl_plan.delete',
    entityType: 'crawl_plan',
    entityId: id,
  });
}

export async function listCrawlPlans(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<CrawlPlan[]> {
  return db
    .select()
    .from(crawlPlans)
    .where(eq(crawlPlans.workspaceId, ctx.workspaceId))
    .orderBy(asc(crawlPlans.name));
}

export async function getCrawlPlan(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  id: bigint,
): Promise<CrawlPlan> {
  const rows = await db
    .select()
    .from(crawlPlans)
    .where(
      and(eq(crawlPlans.workspaceId, ctx.workspaceId), eq(crawlPlans.id, id)),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

// ---- ownership guards ----------------------------------------------

async function assertRecipesBelong(
  ctx: WorkspaceContext,
  ids: ReadonlyArray<bigint>,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: connectorRecipes.id })
    .from(connectorRecipes)
    .where(
      and(
        eq(connectorRecipes.workspaceId, ctx.workspaceId),
        inArray(connectorRecipes.id, [...ids]),
      ),
    );
  if (rows.length !== ids.length) {
    throw invalid(
      `${ids.length - rows.length} recipe id(s) do not belong to this workspace`,
    );
  }
}

async function assertProductsBelong(
  ctx: WorkspaceContext,
  ids: ReadonlyArray<bigint>,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: productProfiles.id })
    .from(productProfiles)
    .where(
      and(
        eq(productProfiles.workspaceId, ctx.workspaceId),
        inArray(productProfiles.id, [...ids]),
      ),
    );
  if (rows.length !== ids.length) {
    throw invalid(
      `${ids.length - rows.length} product id(s) do not belong to this workspace`,
    );
  }
}

// ---- run path ------------------------------------------------------

export interface RunPlanResult {
  planId: bigint;
  startedRuns: bigint[];
  skippedRecipes: bigint[];
  failedRecipes: Array<{ recipeId: bigint; error: string }>;
}

/** Fire every active recipe in a plan as a separate connector_runs row.
 *  Skips inactive recipes silently (they were valid at plan time but
 *  the operator archived them since). Always updates lastRunAt +
 *  nextRunAt, even if the plan has zero eligible recipes — that keeps
 *  the scheduler moving forward. */
export async function runCrawlPlanNow(
  ctx: WorkspaceContext,
  id: bigint,
): Promise<RunPlanResult> {
  if (!canWrite(ctx)) throw denied('crawl_plan.run_now');
  const plan = await getCrawlPlan(ctx, id);
  return executePlan(ctx, plan);
}

/** Internal — used by both runCrawlPlanNow and the cron handler. */
async function executePlan(
  ctx: WorkspaceContext,
  plan: CrawlPlan,
): Promise<RunPlanResult> {
  const now = new Date();
  const startedRuns: bigint[] = [];
  const skippedRecipes: bigint[] = [];
  const failedRecipes: Array<{ recipeId: bigint; error: string }> = [];
  // Resolve eligible recipes: must belong to workspace AND be active.
  const eligible =
    plan.recipeIds.length === 0
      ? []
      : await db
          .select({
            id: connectorRecipes.id,
            connectorId: connectorRecipes.connectorId,
            active: connectorRecipes.active,
          })
          .from(connectorRecipes)
          .where(
            and(
              eq(connectorRecipes.workspaceId, ctx.workspaceId),
              inArray(connectorRecipes.id, [...plan.recipeIds]),
            ),
          );
  for (const r of eligible) {
    if (!r.active) {
      skippedRecipes.push(r.id);
      continue;
    }
    try {
      const { run } = await startRun(ctx, {
        connectorId: r.connectorId,
        recipeId: r.id,
        productProfileIds: [...plan.productProfileIds],
      });
      startedRuns.push(run.id);
    } catch (err) {
      failedRecipes.push({
        recipeId: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Recipes referenced by plan but no longer in workspace (e.g. deleted)
  // count as skipped.
  const seenIds = new Set(eligible.map((r) => r.id.toString()));
  for (const id of plan.recipeIds) {
    if (!seenIds.has(id.toString())) skippedRecipes.push(id);
  }

  const summary = {
    started: startedRuns.length,
    skipped: skippedRecipes.length,
    failed: failedRecipes.length,
    startedRuns: startedRuns.map(String),
    skippedRecipes: skippedRecipes.map(String),
    failedRecipes: failedRecipes.map((f) => ({
      recipeId: f.recipeId.toString(),
      error: f.error,
    })),
    ranAt: now.toISOString(),
  };
  const nextRunAt = new Date(now.getTime() + plan.intervalMinutes * 60_000);
  await db
    .update(crawlPlans)
    .set({
      lastRunAt: now,
      nextRunAt,
      lastRunSummary: summary,
      updatedAt: now,
    })
    .where(eq(crawlPlans.id, plan.id));

  await recordAuditEvent(ctx, {
    kind: 'crawl_plan.run',
    entityType: 'crawl_plan',
    entityId: plan.id,
    payload: summary,
  });
  return { planId: plan.id, startedRuns, skippedRecipes, failedRecipes };
}

// ---- cron tick -----------------------------------------------------

export interface TickSummary {
  workspaces: number;
  processed: number;
  inQuietHours: number;
  notDue: number;
  totalStartedRuns: number;
  totalFailedRecipes: number;
}

/** Per-workspace fan-out. Runs every plan whose nextRunAt is past AND
 *  whose current local hour is not inside the quiet window. */
export async function processDueCrawlPlans(
  ctx: WorkspaceContext,
  now: Date = new Date(),
): Promise<TickSummary> {
  const allPlans = await db
    .select()
    .from(crawlPlans)
    .where(
      and(
        eq(crawlPlans.workspaceId, ctx.workspaceId),
        eq(crawlPlans.enabled, true),
      ),
    );
  let processed = 0;
  let inQuiet = 0;
  let notDue = 0;
  let totalStarted = 0;
  let totalFailed = 0;
  for (const plan of allPlans) {
    const due = plan.nextRunAt === null || plan.nextRunAt.getTime() <= now.getTime();
    if (!due) {
      notDue++;
      continue;
    }
    const localHour = currentLocalHour(now, plan.timezone);
    if (isInQuietHours(localHour, plan.quietStartHour, plan.quietEndHour)) {
      inQuiet++;
      // Push nextRunAt forward by 15 min so we re-check after the quiet
      // edge instead of hammering every cron tick.
      await db
        .update(crawlPlans)
        .set({
          nextRunAt: new Date(now.getTime() + 15 * 60_000),
          updatedAt: now,
        })
        .where(eq(crawlPlans.id, plan.id));
      continue;
    }
    try {
      const result = await executePlan(ctx, plan);
      processed++;
      totalStarted += result.startedRuns.length;
      totalFailed += result.failedRecipes.length;
    } catch (err) {
      console.error(
        `[crawl.engine.tick] plan=${plan.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return {
    workspaces: 1,
    processed,
    inQuietHours: inQuiet,
    notDue,
    totalStartedRuns: totalStarted,
    totalFailedRecipes: totalFailed,
  };
}

// Silence the unused-import warning when arrays end up empty.
void (sql as unknown);
void (lte as unknown);
void ((null as unknown) as SQL);
