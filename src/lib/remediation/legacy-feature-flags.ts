// PC-06: import the legacy feature_flags rows into holds.
//
// feature_flags were toggled from the console but never read (I048), so a
// disabled flag stopped nothing — workspace 2 kept syncing its inbox with
// mailbox.imap_sync=false (X6). Holds replace them. Because nobody ever
// saw those flags do anything, an import must not suddenly start
// enforcing them: every disabled row becomes a `pending_review` row that
// the platform owner confirms (→ an enforced hold) or discards on
// /admin/workspaces/[id].
//
//   outreach.send       disabled → pending hold on Sending
//   mailbox.imap_sync   disabled → pending hold on Inbox sync
//   crm.hubspot         disabled → pending hold on CRM sync
//   connector.serpapi   disabled → a note (no hold stops one search
//                                  provider; the workspace's search
//                                  provider is picked on /settings/integrations)
//   rag.openai          dropped  (the vector-storage provider setting decides it)
//   any other key       disabled → a note
//   enabled rows        dropped  (an enabled flag asked for nothing)
//
// Idempotent: one imported row per (workspace, legacy key) — a unique
// index — so a second --apply inserts nothing. The DB handle is injected
// (the CLI opens its own connection; tests pass the shared client).
// Reports carry workspace ids and names, flag keys and dates only.

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { featureFlags } from '@/lib/db/schema/admin';
import { auditLog } from '@/lib/db/schema/audit';
import {
  workspaceHolds,
  type AutomationCapability,
  type NewWorkspaceHold,
} from '@/lib/db/schema/holds';
import { workspaces } from '@/lib/db/schema/workspaces';

// Accepts the app client, a script's own client, or a transaction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LegacyFlagsDb = PgDatabase<PgQueryResultHKT, any, any>;

export const LEGACY_IMPORT_TAG = 'PC-06 legacy feature_flags import';

export type LegacyFlagAction = 'hold' | 'note' | 'drop';

export interface LegacyFlagMapping {
  action: LegacyFlagAction;
  capabilities: AutomationCapability[];
  /** Why this row maps the way it does (shown in the report). */
  why: string;
}

const HOLD_KEYS: Readonly<Record<string, AutomationCapability>> = {
  'outreach.send': 'sending',
  'mailbox.imap_sync': 'inbox_sync',
  'crm.hubspot': 'crm_sync',
};

/** Pure mapping of one feature_flags row. */
export function mapLegacyFlag(row: { key: string; enabled: boolean }): LegacyFlagMapping {
  if (row.enabled) {
    return { action: 'drop', capabilities: [], why: 'enabled — an enabled flag asked for nothing' };
  }
  const capability = HOLD_KEYS[row.key];
  if (capability) {
    return {
      action: 'hold',
      capabilities: [capability],
      why: `disabled — pending hold on ${capability}`,
    };
  }
  if (row.key === 'rag.openai') {
    return {
      action: 'drop',
      capabilities: [],
      why: 'the vector-storage provider setting decides this, not a hold',
    };
  }
  if (row.key === 'connector.serpapi') {
    return {
      action: 'note',
      capabilities: [],
      why: 'disabled — note: no hold stops a single search provider',
    };
  }
  return { action: 'note', capabilities: [], why: 'disabled — note: unknown legacy key' };
}

/** The reason text the imported row carries (the console and, once
 *  confirmed, the tenant banner show it). */
export function legacyReason(
  row: { key: string; setAt: Date },
  mapping: LegacyFlagMapping,
): string {
  const when = row.setAt.toISOString().slice(0, 10);
  if (mapping.action === 'note') {
    const hint =
      row.key === 'connector.serpapi'
        ? ' No hold stops one search provider: the workspace picks its search provider on /settings/integrations.'
        : '';
    return `Legacy feature flag ${row.key} was disabled on ${when}. Feature flags were never enforced (I048), and this one has no hold equivalent.${hint} Discard once read.`;
  }
  return `Legacy feature flag ${row.key} was disabled on ${when}. Feature flags were never enforced (I048): confirm to enforce it as a hold from now on, or discard it.`;
}

export interface LegacyFlagPlanRow {
  workspaceId: string;
  workspaceName: string | null;
  key: string;
  enabled: boolean;
  setAt: string;
  action: LegacyFlagAction;
  capabilities: AutomationCapability[];
  why: string;
  /** A row for this (workspace, key) already exists in workspace_holds. */
  alreadyImported: boolean;
}

export interface LegacyFlagPlan {
  rows: LegacyFlagPlanRow[];
  totals: {
    flags: number;
    holds: number;
    notes: number;
    dropped: number;
    alreadyImported: number;
    toInsert: number;
  };
}

/** What an import would do. Read-only. */
export async function planLegacyFlagImport(db: LegacyFlagsDb): Promise<LegacyFlagPlan> {
  const flags = await db
    .select({
      workspaceId: featureFlags.workspaceId,
      workspaceName: workspaces.name,
      key: featureFlags.key,
      enabled: featureFlags.enabled,
      setAt: featureFlags.setAt,
    })
    .from(featureFlags)
    .leftJoin(workspaces, eq(workspaces.id, featureFlags.workspaceId))
    .orderBy(featureFlags.workspaceId, featureFlags.key);

  const imported = flags.length
    ? await db
        .select({ workspaceId: workspaceHolds.workspaceId, key: workspaceHolds.legacyFlagKey })
        .from(workspaceHolds)
        .where(
          and(
            inArray(
              workspaceHolds.workspaceId,
              [...new Set(flags.map((f) => f.workspaceId.toString()))].map((s) => BigInt(s)),
            ),
            isNotNull(workspaceHolds.legacyFlagKey),
          ),
        )
    : [];
  const importedKeys = new Set(imported.map((r) => `${r.workspaceId}:${r.key}`));

  const rows: LegacyFlagPlanRow[] = flags.map((f) => {
    const m = mapLegacyFlag(f);
    return {
      workspaceId: f.workspaceId.toString(),
      workspaceName: f.workspaceName,
      key: f.key,
      enabled: f.enabled,
      setAt: f.setAt.toISOString(),
      action: m.action,
      capabilities: m.capabilities,
      why: m.why,
      alreadyImported: importedKeys.has(`${f.workspaceId}:${f.key}`),
    };
  });
  const kept = rows.filter((r) => r.action !== 'drop');
  return {
    rows,
    totals: {
      flags: rows.length,
      holds: rows.filter((r) => r.action === 'hold').length,
      notes: rows.filter((r) => r.action === 'note').length,
      dropped: rows.filter((r) => r.action === 'drop').length,
      alreadyImported: kept.filter((r) => r.alreadyImported).length,
      toInsert: kept.filter((r) => !r.alreadyImported).length,
    },
  };
}

export interface LegacyFlagApplyResult {
  plan: LegacyFlagPlan;
  inserted: number;
}

/**
 * Import every disabled flag as a pending_review row (holds and notes),
 * in one transaction, with one tenant-scoped audit row per imported row
 * and one platform-scope summary. Never enforces anything.
 */
export async function applyLegacyFlagImport(
  db: LegacyFlagsDb,
  options: { now?: Date } = {},
): Promise<LegacyFlagApplyResult> {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const plan = await planLegacyFlagImport(tx);
    const flags = await tx
      .select()
      .from(featureFlags)
      .orderBy(featureFlags.workspaceId, featureFlags.key);
    let inserted = 0;
    for (const f of flags) {
      const m = mapLegacyFlag(f);
      if (m.action === 'drop') continue;
      const row: NewWorkspaceHold = {
        workspaceId: f.workspaceId,
        kind: m.action === 'hold' ? 'hold' : 'note',
        scope: 'capabilities',
        capabilities: m.capabilities,
        state: 'pending_review',
        source: 'platform',
        reason: legacyReason(f, m),
        placedByUserId: f.setBy,
        placedAt: f.setAt,
        legacyFlagKey: f.key,
        history: [
          {
            at: now.toISOString(),
            action: 'imported',
            actorUserId: null,
            reason: LEGACY_IMPORT_TAG,
          },
        ],
      };
      const [hold] = await tx.insert(workspaceHolds).values(row).onConflictDoNothing().returning();
      if (!hold) continue; // imported by an earlier run
      inserted++;
      await tx.insert(auditLog).values({
        workspaceId: f.workspaceId,
        userId: null,
        kind: 'workspace.hold.import',
        entityType: 'workspace_hold',
        entityId: hold.id.toString(),
        payload: {
          holdId: hold.id.toString(),
          legacyFlagKey: f.key,
          kind: hold.kind,
          capabilities: hold.capabilities,
          state: hold.state,
          tag: LEGACY_IMPORT_TAG,
        },
      });
    }
    await tx.insert(auditLog).values({
      workspaceId: null,
      userId: null,
      kind: 'admin.legacy_flags.import',
      entityType: 'feature_flags',
      entityId: null,
      payload: { tag: LEGACY_IMPORT_TAG, inserted, totals: plan.totals },
    });
    return { plan, inserted };
  });
}

/** Plain-text report for the CLI (and a ticket). */
export function renderLegacyFlagReport(plan: LegacyFlagPlan): string {
  const lines: string[] = [];
  lines.push(
    `feature_flags rows: ${plan.totals.flags} · pending holds: ${plan.totals.holds} · notes: ${plan.totals.notes} · dropped: ${plan.totals.dropped}`,
  );
  lines.push(
    `already imported: ${plan.totals.alreadyImported} · would insert: ${plan.totals.toInsert}`,
  );
  const ws = (r: LegacyFlagPlanRow) =>
    `${r.workspaceId}${r.workspaceName ? ` (${r.workspaceName})` : ''}`;
  const kept = plan.rows.filter((r) => r.action !== 'drop');
  const dropped = plan.rows.filter((r) => r.action === 'drop');
  lines.push('');
  lines.push('Imported as pending_review (never enforced until confirmed):');
  if (kept.length === 0) lines.push('  (none)');
  else lines.push('  workspace | key | disabled since | becomes | capabilities');
  for (const r of kept) {
    lines.push(
      `  ${[
        ws(r),
        r.key,
        r.setAt.slice(0, 10),
        `${r.action}${r.alreadyImported ? ' (already imported)' : ''}`,
        r.capabilities.join(', ') || '-',
      ].join(' | ')}`,
    );
  }
  lines.push('');
  lines.push('Dropped (not imported):');
  if (dropped.length === 0) lines.push('  (none)');
  for (const r of dropped) lines.push(`  ${ws(r)} | ${r.key} | ${r.why}`);
  return lines.join('\n');
}
