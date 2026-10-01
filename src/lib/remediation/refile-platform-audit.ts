// PC-03 remediation: refile audit rows that the old /admin console wrote
// into the wrong workspace (I051).
//
// Before PlatformContext, every console action resolved a WorkspaceContext
// and logged into ctx.workspaceId — the workspace the super-admin's
// switcher pointed at (in god mode, a tenant they are not a member of).
// That tenant's admins could then read other customers' names, emails and
// suspension reasons on /settings/audit.
//
// This module finds those rows and moves each one to where the fixed code
// files it today:
//   - platform kinds (user lifecycle, pre-authorisation, platform role,
//     password reset, profile edit)        -> workspace_id NULL
//   - admin.set_billing_exempt             -> the workspace it changed
//                                             (entity_id)
//   - admin support reply / close / reopen -> the support thread's workspace
//
// Every moved row records payload.refiledFrom = { workspaceId, runId, at,
// by }, so a run can be reverted exactly. Plans are fingerprinted: apply
// refuses to run unless the caller passes the fingerprint of the dry run
// the owner reviewed AND the candidate set is still identical.
//
// The DB handle is injected (the CLI in scripts/remediation/ opens its own
// connection; tests pass the shared test client). Reports carry ids,
// kinds and counts only — never emails, names or payload contents.

import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { auditLog } from '@/lib/db/schema/audit';
import { supportThreads } from '@/lib/db/schema/support';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';

// Accepts the app client, a script's own client, or a transaction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RefileDb = PgDatabase<PgQueryResultHKT, any, any>;

export const REFILE_TAG = 'PC-03 refile-platform-audit';

/**
 * Kinds that belong at platform scope. Every one of them could only be
 * written by a super-admin (each service gated on the super-admin role),
 * so a row of these kinds with a workspace_id is misfiled by definition —
 * the actor's CURRENT role is not re-checked (a since-demoted admin's rows
 * are just as misfiled).
 */
export const PLATFORM_SCOPE_KINDS = [
  'user.set_account_status',
  'user.preauthorize',
  'user.revoke_preauthorize',
  'user.create_password_user',
  'user.set_platform_role',
  'user.set_password',
  'user.delete',
  'admin.user.update_profile',
] as const;

/** Belongs to the workspace whose billing changed (entity_id). */
export const BILLING_KINDS = ['admin.set_billing_exempt'] as const;

/** Belongs to the support thread's workspace (entity_id = thread id). */
export const SUPPORT_ADMIN_KINDS = [
  'support.message.admin',
  'support.thread.close',
  'support.thread.reopen',
] as const;

const ALL_KINDS: string[] = [...PLATFORM_SCOPE_KINDS, ...BILLING_KINDS, ...SUPPORT_ADMIN_KINDS];

export type RefileCategory = 'platform' | 'billing' | 'support';

/**
 * How bad the misfiling is, judged by today's memberships:
 *   cross_tenant  — the actor is not a member of the workspace the row sits
 *                   in (god mode): the leak I051 describes.
 *   own_workspace — filed in a workspace the actor belongs to (their home
 *                   workspace): still wrong, visible to its other admins.
 *   actor_unknown — the actor's user row is gone (user_id NULL).
 */
export type RefileExposure = 'cross_tenant' | 'own_workspace' | 'actor_unknown';

/** `all` refiles every misfiled row; `cross-tenant` only the god-mode leaks. */
export type RefileScope = 'all' | 'cross-tenant';

export interface RefileCandidate {
  auditId: string;
  kind: string;
  category: RefileCategory;
  exposure: RefileExposure;
  fromWorkspaceId: string;
  /** null = platform scope. */
  toWorkspaceId: string | null;
}

export interface RefileWorkspaceSummary {
  workspaceId: string;
  rows: number;
  crossTenant: number;
  ownWorkspace: number;
  actorUnknown: number;
  toPlatform: number;
  toOtherWorkspace: number;
  byKind: Record<string, number>;
}

export interface RefilePlan {
  generatedAt: string;
  scope: RefileScope;
  fingerprint: string;
  totals: {
    rows: number;
    crossTenant: number;
    ownWorkspace: number;
    actorUnknown: number;
    byCategory: Record<RefileCategory, number>;
  };
  byWorkspace: RefileWorkspaceSummary[];
  candidates: RefileCandidate[];
}

export class RefileError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RefileError';
    this.code = code;
  }
}

function categoryOf(kind: string): RefileCategory {
  if ((BILLING_KINDS as readonly string[]).includes(kind)) return 'billing';
  if ((SUPPORT_ADMIN_KINDS as readonly string[]).includes(kind)) return 'support';
  return 'platform';
}

const DIGITS = /^\d+$/;

/**
 * Compute what a refile would change. Read-only.
 */
export async function planRefile(
  db: RefileDb,
  options: { scope?: RefileScope; now?: Date } = {},
): Promise<RefilePlan> {
  const scope = options.scope ?? 'all';
  const rows = await db
    .select({
      id: auditLog.id,
      kind: auditLog.kind,
      workspaceId: auditLog.workspaceId,
      userId: auditLog.userId,
      entityId: auditLog.entityId,
      payload: auditLog.payload,
    })
    .from(auditLog)
    .where(and(isNotNull(auditLog.workspaceId), inArray(auditLog.kind, ALL_KINDS)))
    .orderBy(auditLog.id);

  // Target lookups. Workspaces that still exist (a refile must never point
  // a row at a deleted workspace — the FK would refuse anyway).
  const existingWs = new Set(
    (await db.select({ id: workspaces.id }).from(workspaces)).map((w) => w.id.toString()),
  );

  const threadIds = Array.from(
    new Set(
      rows
        .filter((r) => categoryOf(r.kind) === 'support' && r.entityId && DIGITS.test(r.entityId))
        .map((r) => BigInt(r.entityId!)),
    ),
  );
  const threadWs = new Map<string, string>();
  if (threadIds.length > 0) {
    const threads = await db
      .select({ id: supportThreads.id, workspaceId: supportThreads.workspaceId })
      .from(supportThreads)
      .where(inArray(supportThreads.id, threadIds));
    for (const t of threads) threadWs.set(t.id.toString(), t.workspaceId.toString());
  }

  const actorIds = Array.from(
    new Set(rows.map((r) => r.userId).filter((u): u is string => Boolean(u))),
  );
  const memberships = new Set<string>();
  if (actorIds.length > 0) {
    const ms = await db
      .select({ workspaceId: workspaceMembers.workspaceId, userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(inArray(workspaceMembers.userId, actorIds));
    for (const m of ms) memberships.add(`${m.workspaceId.toString()}|${m.userId}`);
  }

  const candidates: RefileCandidate[] = [];
  for (const r of rows) {
    const from = r.workspaceId!.toString();
    const category = categoryOf(r.kind);
    let to: string | null = null;
    if (category === 'billing') {
      const target = r.entityId && DIGITS.test(r.entityId) ? r.entityId : null;
      to = target && existingWs.has(target) ? target : null;
    } else if (category === 'support') {
      const viaThread = r.entityId ? threadWs.get(r.entityId) : undefined;
      const payloadWs = (r.payload as Record<string, unknown> | null)?.workspaceId;
      const viaPayload =
        typeof payloadWs === 'string' && DIGITS.test(payloadWs) && existingWs.has(payloadWs)
          ? payloadWs
          : undefined;
      // Thread gone and no usable hint: the row certainly does not belong
      // to the admin's workspace — park it at platform scope.
      to = viaThread ?? viaPayload ?? null;
    }
    if (to === from) continue; // already filed where the fixed code files it

    const exposure: RefileExposure = !r.userId
      ? 'actor_unknown'
      : memberships.has(`${from}|${r.userId}`)
        ? 'own_workspace'
        : 'cross_tenant';
    if (scope === 'cross-tenant' && exposure !== 'cross_tenant') continue;

    candidates.push({
      auditId: r.id.toString(),
      kind: r.kind,
      category,
      exposure,
      fromWorkspaceId: from,
      toWorkspaceId: to,
    });
  }

  return summarize(candidates, scope, options.now ?? new Date());
}

function summarize(candidates: RefileCandidate[], scope: RefileScope, now: Date): RefilePlan {
  const byWs = new Map<string, RefileWorkspaceSummary>();
  const byCategory: Record<RefileCategory, number> = { platform: 0, billing: 0, support: 0 };
  let crossTenant = 0;
  let ownWorkspace = 0;
  let actorUnknown = 0;
  for (const c of candidates) {
    byCategory[c.category] += 1;
    if (c.exposure === 'cross_tenant') crossTenant += 1;
    else if (c.exposure === 'own_workspace') ownWorkspace += 1;
    else actorUnknown += 1;
    let s = byWs.get(c.fromWorkspaceId);
    if (!s) {
      s = {
        workspaceId: c.fromWorkspaceId,
        rows: 0,
        crossTenant: 0,
        ownWorkspace: 0,
        actorUnknown: 0,
        toPlatform: 0,
        toOtherWorkspace: 0,
        byKind: {},
      };
      byWs.set(c.fromWorkspaceId, s);
    }
    s.rows += 1;
    if (c.exposure === 'cross_tenant') s.crossTenant += 1;
    else if (c.exposure === 'own_workspace') s.ownWorkspace += 1;
    else s.actorUnknown += 1;
    if (c.toWorkspaceId === null) s.toPlatform += 1;
    else s.toOtherWorkspace += 1;
    s.byKind[c.kind] = (s.byKind[c.kind] ?? 0) + 1;
  }
  return {
    generatedAt: now.toISOString(),
    scope,
    fingerprint: fingerprintOf(candidates, scope),
    totals: { rows: candidates.length, crossTenant, ownWorkspace, actorUnknown, byCategory },
    byWorkspace: Array.from(byWs.values()).sort((a, b) =>
      BigInt(a.workspaceId) < BigInt(b.workspaceId) ? -1 : 1,
    ),
    candidates,
  };
}

/** Stable digest of exactly which rows move where. */
export function fingerprintOf(candidates: RefileCandidate[], scope: RefileScope): string {
  const lines = candidates
    .map((c) => `${c.auditId}:${c.fromWorkspaceId}>${c.toWorkspaceId ?? 'platform'}`)
    .sort();
  return createHash('sha256')
    .update(`${REFILE_TAG}\nscope=${scope}\n${lines.join('\n')}`)
    .digest('hex')
    .slice(0, 16);
}

export interface RefileApplyResult {
  runId: string;
  moved: number;
  plan: RefilePlan;
}

/**
 * Apply a reviewed plan. Re-plans inside one transaction and refuses
 * unless the fingerprint matches what the owner signed off; then moves
 * every candidate and writes one platform-scope summary event.
 */
export async function applyRefile(
  db: RefileDb,
  options: { expectFingerprint: string; scope?: RefileScope; runId?: string; now?: Date },
): Promise<RefileApplyResult> {
  const scope = options.scope ?? 'all';
  const now = options.now ?? new Date();
  const runId = options.runId ?? `refile-${now.toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  return db.transaction(async (tx) => {
    const plan = await planRefile(tx, { scope, now });
    if (plan.fingerprint !== options.expectFingerprint) {
      throw new RefileError(
        `plan changed since the reviewed dry run (expected ${options.expectFingerprint}, now ${plan.fingerprint}) — re-run the dry run and get it signed off again`,
        'fingerprint_mismatch',
      );
    }
    if (plan.candidates.length === 0) {
      return { runId, moved: 0, plan };
    }

    // One UPDATE per (from, to) pair; the from-guard makes a concurrent
    // change fail loudly instead of being overwritten.
    const groups = new Map<string, RefileCandidate[]>();
    for (const c of plan.candidates) {
      const key = `${c.fromWorkspaceId}>${c.toWorkspaceId ?? ''}`;
      const g = groups.get(key) ?? [];
      g.push(c);
      groups.set(key, g);
    }
    let moved = 0;
    for (const g of groups.values()) {
      const from = g[0]!.fromWorkspaceId;
      const to = g[0]!.toWorkspaceId;
      const stamp = JSON.stringify({
        refiledFrom: { workspaceId: from, runId, at: now.toISOString(), by: REFILE_TAG },
      });
      const updated = await tx
        .update(auditLog)
        .set({
          workspaceId: to === null ? null : BigInt(to),
          payload: sql`${auditLog.payload} || ${stamp}::jsonb`,
        })
        .where(
          and(
            inArray(
              auditLog.id,
              g.map((c) => BigInt(c.auditId)),
            ),
            eq(auditLog.workspaceId, BigInt(from)),
          ),
        )
        .returning({ id: auditLog.id });
      if (updated.length !== g.length) {
        throw new RefileError(
          `expected to move ${g.length} rows out of workspace ${from}, moved ${updated.length} — aborting (nothing committed)`,
          'concurrent_change',
        );
      }
      moved += updated.length;
    }

    await tx.insert(auditLog).values({
      workspaceId: null,
      userId: null,
      kind: 'admin.audit.refile',
      entityType: 'audit_log',
      entityId: runId,
      payload: {
        runId,
        scope,
        fingerprint: plan.fingerprint,
        moved,
        byCategory: plan.totals.byCategory,
        crossTenant: plan.totals.crossTenant,
        ownWorkspace: plan.totals.ownWorkspace,
        actorUnknown: plan.totals.actorUnknown,
        by: REFILE_TAG,
      },
    });
    return { runId, moved, plan };
  });
}

export interface RefileRevertResult {
  runId: string;
  restored: number;
  /** Rows whose original workspace has since been deleted — left in place. */
  skippedMissingWorkspace: number;
}

/**
 * Undo one apply run: every row stamped with this runId goes back to the
 * workspace recorded in payload.refiledFrom, and the stamp is removed.
 */
export async function revertRefile(
  db: RefileDb,
  options: { runId: string },
): Promise<RefileRevertResult> {
  const { runId } = options;
  if (!runId.trim()) throw new RefileError('runId is required', 'invalid_input');
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: auditLog.id, payload: auditLog.payload })
      .from(auditLog)
      .where(sql`${auditLog.payload} -> 'refiledFrom' ->> 'runId' = ${runId}`);
    const existingWs = new Set(
      (await tx.select({ id: workspaces.id }).from(workspaces)).map((w) => w.id.toString()),
    );
    const byFrom = new Map<string, bigint[]>();
    let skipped = 0;
    for (const r of rows) {
      const from = (r.payload as { refiledFrom?: { workspaceId?: unknown } }).refiledFrom
        ?.workspaceId;
      if (typeof from !== 'string' || !DIGITS.test(from) || !existingWs.has(from)) {
        skipped += 1;
        continue;
      }
      const ids = byFrom.get(from) ?? [];
      ids.push(r.id);
      byFrom.set(from, ids);
    }
    let restored = 0;
    for (const [from, ids] of byFrom) {
      const updated = await tx
        .update(auditLog)
        .set({
          workspaceId: BigInt(from),
          payload: sql`${auditLog.payload} - 'refiledFrom'`,
        })
        .where(inArray(auditLog.id, ids))
        .returning({ id: auditLog.id });
      restored += updated.length;
    }
    await tx.insert(auditLog).values({
      workspaceId: null,
      userId: null,
      kind: 'admin.audit.refile_revert',
      entityType: 'audit_log',
      entityId: runId,
      payload: { runId, restored, skippedMissingWorkspace: skipped, by: REFILE_TAG },
    });
    return { runId, restored, skippedMissingWorkspace: skipped };
  });
}

/** Human-readable summary for the owner. Ids and counts only. */
export function renderRefileReport(plan: RefilePlan): string {
  const out: string[] = [];
  out.push(`# Audit refile — ${plan.scope === 'all' ? 'all misfiled rows' : 'cross-tenant rows only'}`);
  out.push('');
  out.push(`Generated: ${plan.generatedAt}`);
  out.push(`Fingerprint: ${plan.fingerprint}`);
  out.push('');
  const t = plan.totals;
  out.push(
    `Rows to refile: ${t.rows} (cross-tenant ${t.crossTenant}, own workspace ${t.ownWorkspace}, actor unknown ${t.actorUnknown})`,
  );
  out.push(
    `By destination: platform ${t.byCategory.platform}, target workspace for billing ${t.byCategory.billing}, thread workspace for support ${t.byCategory.support}`,
  );
  out.push('');
  if (plan.byWorkspace.length === 0) {
    out.push('Nothing to refile.');
    return out.join('\n');
  }
  out.push('| Workspace id | Rows | Cross-tenant | Own workspace | Actor unknown | -> platform | -> other workspace | Kinds |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const w of plan.byWorkspace) {
    const kinds = Object.entries(w.byKind)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${k} x${n}`)
      .join(', ');
    out.push(
      `| ${w.workspaceId} | ${w.rows} | ${w.crossTenant} | ${w.ownWorkspace} | ${w.actorUnknown} | ${w.toPlatform} | ${w.toOtherWorkspace} | ${kinds} |`,
    );
  }
  return out.join('\n');
}
