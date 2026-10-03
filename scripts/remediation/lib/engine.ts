// Generic machinery for versioned data-remediation scripts (flow:F-06).
//
// A module (e.g. 2026-10-funnel/mail.ts) computes a plan and, on apply,
// changes rows only through updateLogged / deleteLogged / creditLogged
// inside its own per-category transaction. Each records a remediation_log
// row with the before- and after-image, so revertRun can restore every
// change. Images are built in SQL (jsonb) and never pass through JS
// numbers, so a revert is byte-for-byte.
//
// Raw SQL here is deliberate: before/after images and the generic restore
// need to_jsonb / jsonb_populate_record over a table chosen at runtime.
// Table and column names come from the allow-list below and are checked
// against a strict identifier pattern before they reach sql.raw; every
// value is a bound parameter.

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import type { AuditKind } from '@/lib/kinds/audit';
import { users } from '@/lib/db/schema/auth';
import {
  remediationLog,
  remediationRuns,
  type RemediationLogEntry,
  type RemediationRun,
} from '@/lib/db/schema/remediation';
import { tokenTransactions } from '@/lib/db/schema/tokens';
import { workspaces } from '@/lib/db/schema/workspaces';
import { RemediationError } from './report-io';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Tables a remediation may change. Every one has a bigint `id` primary
 *  key and a `workspace_id`. */
export const REMEDIABLE_TABLES = [
  'mail_messages',
  'suppression_list',
  'contacts',
  'notifications',
  'mailboxes',
  'token_transactions',
] as const;
export type RemediableTable = (typeof REMEDIABLE_TABLES)[number];

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function tableSql(name: string): SQL {
  if (!(REMEDIABLE_TABLES as readonly string[]).includes(name)) {
    throw new RemediationError(`table ${name} is not remediable`, 'invalid_table');
  }
  return sql.raw(`"${name}"`);
}

function colSql(name: string, alias?: string): SQL {
  if (!IDENT_RE.test(name)) {
    throw new RemediationError(`invalid column name ${name}`, 'invalid_column');
  }
  return sql.raw(alias ? `${alias}."${name}"` : `"${name}"`);
}

/** jsonb_build_object('c1', t."c1", …) over alias t. */
function imageSql(cols: readonly string[]): SQL {
  if (cols.length === 0) throw new RemediationError('no columns to capture', 'invalid_column');
  const parts = cols.map((c) => sql`${sql.raw(`'${c}'`)}, ${colSql(c, 't')}`);
  return sql`jsonb_build_object(${sql.join(parts, sql`, `)})`;
}

async function rows<T extends Record<string, unknown>>(
  q: Tx | typeof db,
  query: SQL,
): Promise<T[]> {
  return [...((await q.execute(query)) as unknown as Iterable<T>)];
}

// ---- actor ---------------------------------------------------------------

export interface Actor {
  id: string;
  email: string;
}

/** The operator applying / reverting: an active platform super admin. */
export async function resolveActor(email: string): Promise<Actor> {
  const normalized = email.trim().toLowerCase();
  const [user] = await db
    .select({ id: users.id, email: users.email, role: users.role, status: users.accountStatus })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`)
    .limit(1);
  if (!user) throw new RemediationError(`no user ${normalized}`, 'actor_not_found');
  if (user.role !== 'super_admin' || user.status !== 'active') {
    throw new RemediationError(
      `${normalized} must be an active super admin to run a remediation`,
      'actor_not_allowed',
    );
  }
  return { id: user.id, email: user.email };
}

// ---- runs ----------------------------------------------------------------

export async function getRun(id: string): Promise<RemediationRun | null> {
  const [run] = await db.select().from(remediationRuns).where(eq(remediationRuns.id, id)).limit(1);
  return run ?? null;
}

export async function startRun(input: {
  id: string;
  script: string;
  module: string;
  planHash: string;
  decisionsHash: string;
  options: Record<string, unknown>;
  actor: Actor;
}): Promise<RemediationRun> {
  const inserted = await db
    .insert(remediationRuns)
    .values({
      id: input.id,
      script: input.script,
      module: input.module,
      planHash: input.planHash,
      decisionsHash: input.decisionsHash,
      options: input.options,
      status: 'applying',
      appliedBy: input.actor.id,
    })
    .onConflictDoNothing({ target: remediationRuns.id })
    .returning();
  if (!inserted[0]) {
    throw new RemediationError(`run ${input.id} already exists`, 'run_exists');
  }
  return inserted[0];
}

export async function finishRun(
  id: string,
  input: { status: 'applied' | 'failed'; summary: Record<string, unknown>; error?: string | null },
): Promise<void> {
  await db
    .update(remediationRuns)
    .set({
      status: input.status,
      summary: input.summary,
      error: input.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(remediationRuns.id, id));
}

// ---- logged changes ---------------------------------------------------------

export interface ChangeScope {
  tx: Tx;
  runId: string;
  category: string;
}

async function writeLog(
  c: ChangeScope,
  entry: {
    workspaceId: bigint;
    table: RemediableTable;
    rowId: bigint;
    action: 'update' | 'delete' | 'ledger_credit';
    before: string | null;
    after: string | null;
  },
): Promise<void> {
  await c.tx.insert(remediationLog).values({
    runId: c.runId,
    workspaceId: entry.workspaceId,
    category: c.category,
    tableName: entry.table,
    rowId: entry.rowId.toString(),
    action: entry.action,
    before: entry.before === null ? null : sql`${entry.before}::jsonb`,
    after: entry.after === null ? null : sql`${entry.after}::jsonb`,
  });
}

/**
 * Update one row and log the image of `cols` before and after. `mutate`
 * runs the guarded UPDATE (it must re-check the expected state in its
 * WHERE) and returns how many rows it changed; 0 means the row was no
 * longer in the planned state, nothing is logged and false is returned.
 */
export async function updateLogged(
  c: ChangeScope,
  spec: {
    table: RemediableTable;
    workspaceId: bigint;
    id: bigint;
    cols: readonly string[];
    mutate: () => Promise<number>;
  },
): Promise<boolean> {
  const tbl = tableSql(spec.table);
  const image = imageSql(spec.cols);
  const where = sql`t.id = ${spec.id} AND t.workspace_id = ${spec.workspaceId}`;
  const [before] = await rows<{ img: string }>(
    c.tx,
    sql`SELECT ${image}::text AS img FROM ${tbl} AS t WHERE ${where} FOR UPDATE`,
  );
  if (!before) return false;
  const changed = await spec.mutate();
  if (changed === 0) return false;
  if (changed !== 1) {
    throw new RemediationError(
      `${spec.table} ${spec.id}: expected to change 1 row, changed ${changed}`,
      'invariant_violation',
    );
  }
  const [after] = await rows<{ img: string }>(
    c.tx,
    sql`SELECT ${image}::text AS img FROM ${tbl} AS t WHERE ${where}`,
  );
  await writeLog(c, {
    workspaceId: spec.workspaceId,
    table: spec.table,
    rowId: spec.id,
    action: 'update',
    before: before.img,
    after: after?.img ?? null,
  });
  return true;
}

/** Delete one row (when `guard` still holds) and log the whole row. */
export async function deleteLogged(
  c: ChangeScope,
  spec: { table: RemediableTable; workspaceId: bigint; id: bigint; guard: SQL },
): Promise<boolean> {
  const tbl = tableSql(spec.table);
  const deleted = await rows<{ img: string }>(
    c.tx,
    sql`DELETE FROM ${tbl} AS t
        WHERE t.id = ${spec.id} AND t.workspace_id = ${spec.workspaceId} AND (${spec.guard})
        RETURNING to_jsonb(t.*)::text AS img`,
  );
  if (!deleted[0]) return false;
  await writeLog(c, {
    workspaceId: spec.workspaceId,
    table: spec.table,
    rowId: spec.id,
    action: 'delete',
    before: deleted[0].img,
    after: null,
  });
  return true;
}

/**
 * Append a ledgered token credit (kind 'adjustment') to a workspace wallet
 * and log it. The ledger is append-only, so a revert appends the matching
 * negative adjustment instead of deleting this row. Idempotent through
 * `externalRef` (unique on token_transactions).
 */
export async function creditLogged(
  c: ChangeScope,
  spec: {
    workspaceId: bigint;
    tokens: bigint;
    reason: string;
    externalRef: string;
    payload: Record<string, unknown>;
  },
): Promise<boolean> {
  if (spec.tokens <= 0n) return false;
  const existing = await c.tx
    .select({ id: tokenTransactions.id })
    .from(tokenTransactions)
    .where(eq(tokenTransactions.externalRef, spec.externalRef))
    .limit(1);
  if (existing[0]) return false;
  const [wallet] = await rows<{ img: string }>(
    c.tx,
    sql`SELECT jsonb_build_object('token_balance', w.token_balance)::text AS img
        FROM ${workspaces} AS w WHERE w.id = ${spec.workspaceId} FOR UPDATE`,
  );
  if (!wallet) return false;
  const [updated] = await c.tx
    .update(workspaces)
    .set({ tokenBalance: sql`${workspaces.tokenBalance} + ${spec.tokens}` })
    .where(eq(workspaces.id, spec.workspaceId))
    .returning({ balance: workspaces.tokenBalance });
  const [ledger] = await c.tx
    .insert(tokenTransactions)
    .values({
      workspaceId: spec.workspaceId,
      delta: spec.tokens,
      balanceAfter: updated!.balance,
      kind: 'adjustment',
      reason: spec.reason,
      externalRef: spec.externalRef,
      payload: spec.payload,
    })
    .returning({ id: tokenTransactions.id });
  const [after] = await rows<{ img: string }>(
    c.tx,
    sql`SELECT to_jsonb(t.*)::text AS img FROM token_transactions AS t WHERE t.id = ${ledger!.id}`,
  );
  await writeLog(c, {
    workspaceId: spec.workspaceId,
    table: 'token_transactions',
    rowId: ledger!.id,
    action: 'ledger_credit',
    before: wallet.img,
    after: after!.img,
  });
  return true;
}

// ---- audit -----------------------------------------------------------------

/** Audit row written inside the category transaction (null workspace =
 *  platform-scoped). */
export async function auditInTx(
  tx: Tx,
  event: {
    workspaceId: bigint | null;
    userId: string;
    /** A registered audit kind (src/lib/kinds/audit.ts, DS-09). */
    kind: AuditKind;
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    workspaceId: event.workspaceId,
    userId: event.userId,
    kind: event.kind,
    entityType: event.entityType,
    entityId: event.entityId,
    payload: event.payload,
  });
}

// ---- revert ------------------------------------------------------------------

export interface RevertConflict {
  logId: string;
  category: string;
  table: string;
  rowId: string;
  reason: string;
}

export interface RevertResult {
  runId: string;
  status: 'reverted' | 'revert_partial';
  reverted: number;
  byCategory: Record<string, number>;
  conflicts: RevertConflict[];
}

class RevertAborted extends RemediationError {
  constructor(public readonly conflicts: RevertConflict[]) {
    super(
      `${conflicts.length} row(s) changed since the apply; nothing was reverted. ` +
        'Re-run with --skip-conflicts to revert everything else and leave those rows as they are.',
      'revert_conflicts',
    );
  }
}

/**
 * Restore every logged change of a run, newest first, in ONE transaction.
 * A row whose changed columns no longer hold the after-image (someone
 * edited it since), a deleted row that cannot be re-inserted, or a vanished
 * row is a conflict: by default the whole revert aborts and lists them;
 * with `skipConflicts` those rows stay as they are and the run is marked
 * revert_partial (a later revert retries them).
 */
export async function revertRun(
  runId: string,
  input: { actor: Actor; skipConflicts?: boolean },
): Promise<RevertResult> {
  const run = await getRun(runId);
  if (!run) throw new RemediationError(`no run ${runId}`, 'run_not_found');
  if (run.status === 'reverted') {
    throw new RemediationError(`run ${runId} is already reverted`, 'already_reverted');
  }
  if (run.status === 'applying') {
    throw new RemediationError(`run ${runId} is still applying`, 'run_in_progress');
  }

  // Images are read back as jsonb TEXT and bound as text again, so they
  // never pass through JS numbers on the way back into the table.
  const entries: LoggedEntry[] = await db
    .select({
      id: remediationLog.id,
      category: remediationLog.category,
      tableName: remediationLog.tableName,
      rowId: remediationLog.rowId,
      action: remediationLog.action,
      workspaceId: remediationLog.workspaceId,
      beforeText: sql<string | null>`${remediationLog.before}::text`,
      afterText: sql<string | null>`${remediationLog.after}::text`,
    })
    .from(remediationLog)
    .where(and(eq(remediationLog.runId, runId), isNull(remediationLog.revertedAt)))
    .orderBy(desc(remediationLog.id));

  const conflicts: RevertConflict[] = [];
  const byCategory: Record<string, number> = {};
  const byWorkspace = new Map<string, number>();
  let reverted = 0;

  await db.transaction(async (tx) => {
    for (const entry of entries) {
      const conflict = await revertEntry(tx, runId, entry);
      if (conflict) {
        conflicts.push({
          logId: entry.id.toString(),
          category: entry.category,
          table: entry.tableName,
          rowId: entry.rowId,
          reason: conflict,
        });
        continue;
      }
      await tx
        .update(remediationLog)
        .set({ revertedAt: new Date() })
        .where(eq(remediationLog.id, entry.id));
      reverted++;
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
      const ws = entry.workspaceId?.toString() ?? '-';
      byWorkspace.set(ws, (byWorkspace.get(ws) ?? 0) + 1);
    }
    if (conflicts.length > 0 && !input.skipConflicts) throw new RevertAborted(conflicts);

    const status = conflicts.length > 0 ? 'revert_partial' : 'reverted';
    await tx
      .update(remediationRuns)
      .set({ status, revertedBy: input.actor.id, revertedAt: new Date() })
      .where(eq(remediationRuns.id, runId));
    await auditInTx(tx, {
      workspaceId: null,
      userId: input.actor.id,
      kind: 'remediation.revert',
      entityType: 'remediation_run',
      entityId: runId,
      payload: { reverted, byCategory, conflicts: conflicts.length, status },
    });
    for (const [ws, count] of byWorkspace) {
      if (ws === '-') continue;
      await auditInTx(tx, {
        workspaceId: BigInt(ws),
        userId: input.actor.id,
        kind: 'remediation.revert',
        entityType: 'remediation_run',
        entityId: runId,
        payload: { reverted: count },
      });
    }
  });

  return {
    runId,
    status: conflicts.length > 0 ? 'revert_partial' : 'reverted',
    reverted,
    byCategory,
    conflicts,
  };
}

interface LoggedEntry extends Pick<
  RemediationLogEntry,
  'id' | 'category' | 'tableName' | 'rowId' | 'action' | 'workspaceId'
> {
  beforeText: string | null;
  afterText: string | null;
}

/** Restore one logged change; returns a conflict reason or null. */
async function revertEntry(tx: Tx, runId: string, entry: LoggedEntry): Promise<string | null> {
  const id = BigInt(entry.rowId);
  if (entry.action === 'update') {
    if (!entry.beforeText || !entry.afterText) return 'the logged images are incomplete';
    if (!entry.workspaceId) return 'the workspace no longer exists';
    const tbl = tableSql(entry.tableName);
    const cols = Object.keys(JSON.parse(entry.beforeText) as Record<string, unknown>);
    const current = sql.join(
      cols.map((c) => colSql(c, 't')),
      sql`, `,
    );
    const planned = sql.join(
      cols.map((c) => colSql(c, 'a')),
      sql`, `,
    );
    const where = sql`t.id = ${id} AND t.workspace_id = ${entry.workspaceId}`;
    // Type-aware comparison: populate the after-image back into the
    // table's row type rather than comparing jsonb text, which depends on
    // the session time zone for timestamps.
    const [state] = await rows<{ unchanged: boolean }>(
      tx,
      sql`SELECT (ROW(${current}) IS NOT DISTINCT FROM ROW(${planned})) AS unchanged
          FROM ${tbl} AS t, jsonb_populate_record(NULL::${tbl}, ${entry.afterText}::jsonb) AS a
          WHERE ${where}
          FOR UPDATE OF t`,
    );
    if (!state) return 'the row no longer exists';
    if (!state.unchanged) return 'the row changed since the apply';
    const assignments = sql.join(
      cols.map((c) => sql`${colSql(c)} = ${colSql(c, 'b')}`),
      sql`, `,
    );
    await tx.execute(
      sql`UPDATE ${tbl} AS t SET ${assignments}
          FROM jsonb_populate_record(NULL::${tbl}, ${entry.beforeText}::jsonb) AS b
          WHERE ${where}`,
    );
    return null;
  }

  if (entry.action === 'delete') {
    if (!entry.beforeText) return 'the logged row image is missing';
    const tbl = tableSql(entry.tableName);
    try {
      // Savepoint: a failed re-insert (the id or a unique key is taken
      // again) must not poison the surrounding revert transaction.
      await tx.transaction(async (sp) => {
        await sp.execute(
          sql`INSERT INTO ${tbl}
              SELECT * FROM jsonb_populate_record(NULL::${tbl}, ${entry.beforeText}::jsonb)`,
        );
      });
      return null;
    } catch (err) {
      return `the row cannot be re-inserted: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (entry.action === 'ledger_credit') {
    if (!entry.afterText || !entry.workspaceId) return 'the ledger image is incomplete';
    const [credit] = await rows<{ delta: string | null }>(
      tx,
      sql`SELECT (${entry.afterText}::jsonb ->> 'delta') AS delta`,
    );
    if (!credit?.delta) return 'the ledger image has no delta';
    const delta = BigInt(credit.delta);
    const [updated] = await tx
      .update(workspaces)
      .set({ tokenBalance: sql`${workspaces.tokenBalance} - ${delta}` })
      .where(eq(workspaces.id, entry.workspaceId))
      .returning({ balance: workspaces.tokenBalance });
    if (!updated) return 'the workspace no longer exists';
    await tx.insert(tokenTransactions).values({
      workspaceId: entry.workspaceId,
      delta: -delta,
      balanceAfter: updated.balance,
      kind: 'adjustment',
      reason: `revert of remediation ${runId} (${entry.category})`,
      payload: { remediationRun: runId, reverts: entry.rowId },
    });
    return null;
  }

  return `unknown action ${entry.action}`;
}
