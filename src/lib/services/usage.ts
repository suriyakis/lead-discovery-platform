import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { usageLog, type NewUsageLogEntry, type UsageLogEntry } from '@/lib/db/schema/audit';
import { tokenTransactions } from '@/lib/db/schema/tokens';
import { workspaces } from '@/lib/db/schema/workspaces';
import { costCentsToTokens } from '@/lib/billing/tokens';
import { debitTokens } from './token-ledger';
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
 *
 * Billing hook: this is the single choke point every metered action
 * already flows through, so the prepaid-token debit lives here. A usage
 * event debits `ceil(costEstimateCents × markup)` tokens from the
 * workspace wallet unless:
 *   - the provider is `mock` (no real cost),
 *   - the call ran on the workspace's own BYOK key
 *     (`payload.keySource === 'workspace'` — they pay the vendor),
 *   - the workspace is billing-exempt (platform-internal),
 *   - the cost rounds to zero tokens,
 *   - the call was platform support (`payload.support === true` — a
 *     super-admin asking inside a tenant; the platform pays, AP-02),
 *   - the call produced no usable output (`payload.unbilled` set — an
 *     empty answer or a refusal is logged for cost tracking but never
 *     charged, AP-02).
 * The debit is best-effort: a ledger hiccup must never fail the action
 * that already happened — the usage row itself is the recovery source.
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

  try {
    await maybeDebitForUsage(ctx.workspaceId, inserted[0]);
  } catch (err) {
    console.error(
      `[usage] token debit failed for usage_log ${inserted[0].id}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return inserted[0];
}

async function maybeDebitForUsage(
  workspaceId: bigint,
  entry: UsageLogEntry,
): Promise<void> {
  if (entry.provider === 'mock') return;
  const payload = (entry.payload as Record<string, unknown> | null) ?? {};
  const keySource = payload.keySource;
  if (keySource === 'workspace' || keySource === 'mock') return;
  if (payload.support === true) return;
  if (payload.unbilled) return;

  const tokens = costCentsToTokens(entry.costEstimateCents);
  if (tokens <= 0) return;

  const ws = await db
    .select({ billingExempt: workspaces.billingExempt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws[0] || ws[0].billingExempt) return;

  await debitTokens(workspaceId, {
    tokens,
    reason: entry.kind,
    payload: {
      usageLogId: entry.id.toString(),
      provider: entry.provider,
      costEstimateCents: entry.costEstimateCents,
      units: entry.units.toString(),
    },
  });
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
 * Tenant cost views leave out platform-support rows (`payload.support`):
 * a super-admin's questions asked inside the tenant are the platform's
 * usage, not the tenant's (AP-02). Platform-wide admin aggregates read
 * usage_log directly and still count them.
 */
function tenantUsageConds(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  range: UsageSummaryRange,
): SQL[] {
  const conds: SQL[] = [
    eq(usageLog.workspaceId, ctx.workspaceId),
    sql`(${usageLog.payload}->>'support') is distinct from 'true'`,
  ];
  if (range.since) conds.push(gte(usageLog.createdAt, range.since));
  if (range.until) conds.push(lte(usageLog.createdAt, range.until));
  return conds;
}

/**
 * Aggregate usage for a workspace over a time range, grouped by `(kind, provider)`.
 * Useful for the per-workspace cost view. Excludes platform-support rows.
 */
export async function summarizeUsage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  range: UsageSummaryRange = {},
): Promise<UsageSummaryRow[]> {
  const conds = tenantUsageConds(ctx, range);

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
 * Excludes platform-support rows, like summarizeUsage.
 */
export async function summarizeUsageByKeySource(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  range: UsageSummaryRange = {},
): Promise<UsageByKeySourceRow[]> {
  const conds = tenantUsageConds(ctx, range);

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

export interface TokenDebitSummaryRow {
  kind: string;
  provider: string;
  keySource: string; // same buckets as UsageByKeySourceRow.keySource
  /** Tokens taken from the wallet for these events (positive). */
  tokens: bigint;
}

/**
 * Tokens debited from the workspace wallet for the usage events in a
 * range, grouped like summarizeUsageByKeySource. This is what the
 * customer actually paid; the cents columns above are the platform's
 * provider cost, which only super-admins should see.
 *
 * Each debit row carries the usage_log id it charged
 * (payload.usageLogId, written by maybeDebitForUsage), so debits are
 * joined back to their events and the range filters on the event time.
 * The totals therefore line up row for row with the usage summaries.
 * Events that debited nothing (mock, BYOK, billing-exempt, zero cost)
 * have no row here.
 */
export async function summarizeTokenDebits(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  range: UsageSummaryRange = {},
): Promise<TokenDebitSummaryRow[]> {
  const conds: SQL[] = [eq(usageLog.workspaceId, ctx.workspaceId)];
  if (range.since) conds.push(gte(usageLog.createdAt, range.since));
  if (range.until) conds.push(lte(usageLog.createdAt, range.until));

  const keySource = sql<string>`coalesce(${usageLog.payload}->>'keySource', '(unspecified)')`;
  const rows = await db
    .select({
      kind: usageLog.kind,
      provider: usageLog.provider,
      keySource,
      // Debits are stored as negative deltas.
      tokens: sql<bigint>`coalesce(sum(-${tokenTransactions.delta}), 0)::bigint`,
    })
    .from(usageLog)
    .innerJoin(
      tokenTransactions,
      and(
        eq(tokenTransactions.workspaceId, usageLog.workspaceId),
        eq(tokenTransactions.kind, 'usage'),
        // Raw SQL: the link lives in a jsonb field, which the builder
        // cannot compare against a bigint column.
        sql`${tokenTransactions.payload}->>'usageLogId' = ${usageLog.id}::text`,
      ),
    )
    .where(and(...conds))
    .groupBy(usageLog.kind, usageLog.provider, keySource);

  return rows.map((r) => ({
    kind: r.kind,
    provider: r.provider,
    keySource: String(r.keySource),
    tokens: typeof r.tokens === 'bigint' ? r.tokens : BigInt(r.tokens),
  }));
}
