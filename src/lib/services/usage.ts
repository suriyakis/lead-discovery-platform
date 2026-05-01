import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { usageLog, type NewUsageLogEntry, type UsageLogEntry } from '@/lib/db/schema/audit';
import type { WorkspaceContext } from './context';

export interface UsageEventInput {
  /** Domain kind, e.g. `ai.generate_text`, `search.query`, `connector.run`. */
  kind: string;
  /** Provider id, e.g. `mock`, `serpapi`, `anthropic`. */
  provider: string;
  /** Kind-specific count: tokens, queries, bytes, etc. */
  units: number | bigint;
  /** Estimated cost in cents (integer). Optional. */
  costEstimateCents?: number | null;
  /** Free-form structured detail. Don't put secrets here. */
  payload?: Record<string, unknown>;
}

/**
 * Record a usage event for cost tracking and dashboards. Append-only.
 */
export async function recordUsage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  event: UsageEventInput,
): Promise<UsageLogEntry> {
  const row: NewUsageLogEntry = {
    workspaceId: ctx.workspaceId,
    kind: event.kind,
    provider: event.provider,
    units: typeof event.units === 'bigint' ? event.units : BigInt(event.units),
    costEstimateCents: event.costEstimateCents ?? null,
    payload: (event.payload ?? {}) as NewUsageLogEntry['payload'],
  };
  const inserted = await db.insert(usageLog).values(row).returning();
  if (!inserted[0]) {
    throw new Error('usage_log insert returned no row');
  }
  return inserted[0];
}

export interface UsageSummaryRange {
  since?: Date;
  until?: Date;
}

export interface UsageSummaryRow {
  kind: string;
  provider: string;
  totalUnits: bigint;
  totalCostCents: number;
  eventCount: number;
}

/**
 * Aggregate usage for a workspace over a time range, grouped by `(kind, provider)`.
 * Useful for the per-workspace cost view.
 */
export async function summarizeUsage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  range: UsageSummaryRange = {},
): Promise<UsageSummaryRow[]> {
  const conds: SQL[] = [eq(usageLog.workspaceId, ctx.workspaceId)];
  if (range.since) conds.push(gte(usageLog.createdAt, range.since));
  if (range.until) conds.push(lte(usageLog.createdAt, range.until));

  const rows = await db
    .select({
      kind: usageLog.kind,
      provider: usageLog.provider,
      totalUnits: sql<bigint>`coalesce(sum(${usageLog.units}), 0)::bigint`,
      totalCostCents: sql<number>`coalesce(sum(${usageLog.costEstimateCents}), 0)::int`,
      eventCount: sql<number>`count(*)::int`,
    })
    .from(usageLog)
    .where(and(...conds))
    .groupBy(usageLog.kind, usageLog.provider);

  return rows.map((r) => ({
    kind: r.kind,
    provider: r.provider,
    totalUnits: typeof r.totalUnits === 'bigint' ? r.totalUnits : BigInt(r.totalUnits),
    totalCostCents: Number(r.totalCostCents),
    eventCount: Number(r.eventCount),
  }));
}

export interface UsageByKeySourceRow {
  kind: string;
  provider: string;
  keySource: string; // 'workspace' | 'platform' | 'mock' | other
  totalUnits: bigint;
  totalCostCents: number;
  eventCount: number;
}

/**
 * Cost view aggregation broken out by `payload.keySource` so the UI can
 * show "you spent X on your own SerpAPI key, Y on the platform default".
 */
export async function summarizeUsageByKeySource(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  range: UsageSummaryRange = {},
): Promise<UsageByKeySourceRow[]> {
  const conds: SQL[] = [eq(usageLog.workspaceId, ctx.workspaceId)];
  if (range.since) conds.push(gte(usageLog.createdAt, range.since));
  if (range.until) conds.push(lte(usageLog.createdAt, range.until));

  const keySource = sql<string>`coalesce(${usageLog.payload}->>'keySource', '(unspecified)')`;
  const rows = await db
    .select({
      kind: usageLog.kind,
      provider: usageLog.provider,
      keySource,
      totalUnits: sql<bigint>`coalesce(sum(${usageLog.units}), 0)::bigint`,
      totalCostCents: sql<number>`coalesce(sum(${usageLog.costEstimateCents}), 0)::int`,
      eventCount: sql<number>`count(*)::int`,
    })
    .from(usageLog)
    .where(and(...conds))
    .groupBy(usageLog.kind, usageLog.provider, keySource);

  return rows.map((r) => ({
    kind: r.kind,
    provider: r.provider,
    keySource: String(r.keySource),
    totalUnits: typeof r.totalUnits === 'bigint' ? r.totalUnits : BigInt(r.totalUnits),
    totalCostCents: Number(r.totalCostCents),
    eventCount: Number(r.eventCount),
  }));
}
