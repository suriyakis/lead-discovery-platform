// Remediation 2026-10-funnel, mail module (flow:F-06) — apply.
//
// --apply never trusts the report file for WHAT to change: it recomputes
// the plan from the database with the report's options and refuses unless
// the hash equals the reviewed one (any drift → run a new dry run). The
// report contributes only its batch id, options and hash; the decisions
// file contributes the owner's choices.
//
// One transaction per category (R0, R1, R2, R3, R4, R7, R8). Every changed
// row goes through the engine (before/after image in remediation_log).
// Each UPDATE / DELETE re-checks the planned state in its WHERE, so a row
// that changed meanwhile is skipped, never overwritten. Suppressions are
// revoked and contacts archived, never deleted; only the false lead.replied
// notifications are deleted (their whole row is logged for the revert).
// Re-applying a report whose run exists changes nothing.

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { contacts } from '@/lib/db/schema/contacts';
import { mailMessages, mailboxes, suppressionList } from '@/lib/db/schema/mailing';
import {
  auditInTx,
  creditLogged,
  deleteLogged,
  finishRun,
  getRun,
  startRun,
  updateLogged,
  type Actor,
  type ChangeScope,
  type Tx,
} from '../../lib/engine';
import { RemediationError, isBatchId } from '../../lib/report-io';
import { decisionKey, resolveDecisions, type ResolvedDecisions } from './decisions';
import { buildMailPlan, pendingSendsTo } from './plan';
import {
  INBOUND_AUTO_TAG,
  MAIL_PLAN_VERSION,
  MODULE,
  REVOKE_REASON,
  SCRIPT,
  type MailChecks,
  type MailPlan,
  type MailPlanInternals,
  type WorkspaceMailPlan,
} from './types';

export const APPLY_ORDER = ['R0', 'R1', 'R2', 'R3', 'R4', 'R7', 'R8'] as const;
export type ApplyCategory = (typeof APPLY_ORDER)[number];

export interface CategoryOutcome {
  /** Rows the decisions selected. */
  selected: number;
  /** Rows changed (each has a remediation_log row). */
  changed: number;
  /** Selected rows no longer in the planned state (left alone). */
  skipped: number;
}

export interface ApplyResult {
  runId: string;
  status: 'applied' | 'already_applied' | 'failed';
  categories: Partial<Record<ApplyCategory, CategoryOutcome>>;
  totalChanged: number;
  /** Checks recomputed after the apply (expected 0 unless kept by decision). */
  post: MailChecks | null;
  /** How many of the post counts the owner chose to keep. */
  keptByDecision: { r1a: number; r3: number };
  decisions: { missing: string[]; overrides: string[] };
  error: string | null;
}

/** Shape check of a parsed report file. */
export function assertMailReport(value: unknown): MailPlan {
  const r = value as Partial<MailPlan> | null;
  if (
    !r ||
    r.kind !== 'remediation-plan' ||
    r.script !== SCRIPT ||
    r.module !== MODULE ||
    typeof r.batchId !== 'string' ||
    !isBatchId(r.batchId) ||
    typeof r.planHash !== 'string' ||
    !r.options
  ) {
    throw new RemediationError(`not a ${SCRIPT} ${MODULE} dry-run report`, 'invalid_report');
  }
  if (r.version !== MAIL_PLAN_VERSION) {
    throw new RemediationError(
      `report was made by plan version ${r.version}; this script is version ${MAIL_PLAN_VERSION} — run a new dry run`,
      'report_version',
    );
  }
  return r as MailPlan;
}

function sumChecks(plan: MailPlan): MailChecks {
  const total: MailChecks = {
    inboundWithoutRelevance: 0,
    activeAutoSuppressionsFromNonProspectMail: 0,
    labelledNonProspectInbound: 0,
    inboundOnlyContacts: 0,
    visibleInboundAutoContacts: 0,
    leadRepliedOnThreadsWithoutOutbound: 0,
  };
  for (const w of plan.workspaces) {
    for (const k of Object.keys(total) as Array<keyof MailChecks>) total[k] += w.checks[k];
  }
  return total;
}

export async function applyMailPlan(input: {
  report: MailPlan;
  decisionsCsv: string;
  actor: Actor;
  /** Rehearsals on a restored snapshot only: F-01 is not live there. */
  skipPreconditions?: boolean;
}): Promise<ApplyResult> {
  const report = assertMailReport(input.report);
  const empty = {
    categories: {},
    totalChanged: 0,
    post: null,
    keptByDecision: { r1a: 0, r3: 0 },
    decisions: { missing: [], overrides: [] },
    error: null,
  };

  const existing = await getRun(report.batchId);
  if (existing) {
    if (existing.status === 'applied' && existing.planHash === report.planHash) {
      return { runId: report.batchId, status: 'already_applied', ...empty };
    }
    throw new RemediationError(
      `batch ${report.batchId} is ${existing.status}; run a new dry run to continue`,
      'run_exists',
    );
  }

  const { plan, internals } = await buildMailPlan(report.options, { batchId: report.batchId });
  if (plan.planHash !== report.planHash) {
    throw new RemediationError(
      'the data changed since the dry run (plan hash differs); run a new dry run and review it',
      'plan_changed',
    );
  }
  const decisions = resolveDecisions(plan, input.decisionsCsv);
  if (!plan.preconditions.ok && !input.skipPreconditions) {
    throw new RemediationError(
      `preconditions not met: ${plan.preconditions.notes.join(' ') || 'see the report'}`,
      'preconditions',
    );
  }
  await assertNoPendingSends(plan, decisions);

  await startRun({
    id: plan.batchId,
    script: SCRIPT,
    module: MODULE,
    planHash: plan.planHash,
    decisionsHash: decisions.hash,
    options: plan.options as unknown as Record<string, unknown>,
    actor: input.actor,
  });

  const categories: Partial<Record<ApplyCategory, CategoryOutcome>> = {};
  let error: string | null = null;
  for (const category of APPLY_ORDER) {
    try {
      categories[category] = await db.transaction((tx) =>
        applyCategory(category, {
          tx,
          plan,
          internals,
          decisions,
          actor: input.actor,
        }),
      );
    } catch (err) {
      error = `${category}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
  }

  const totalChanged = Object.values(categories).reduce((n, c) => n + (c?.changed ?? 0), 0);
  const after = (await buildMailPlan(plan.options, { batchId: plan.batchId })).plan;
  const post = sumChecks(after);
  const keptByDecision = {
    r1a: countKept(plan, decisions, 'R1a'),
    r3: countKept(plan, decisions, 'R3'),
  };
  const summary = {
    categories,
    totalChanged,
    post,
    keptByDecision,
    decisions: { missing: decisions.missing, overrides: decisions.overrides },
    skippedPreconditions: !plan.preconditions.ok && !!input.skipPreconditions,
  };
  await finishRun(plan.batchId, { status: error ? 'failed' : 'applied', summary, error });

  return {
    runId: plan.batchId,
    status: error ? 'failed' : 'applied',
    categories,
    totalChanged,
    post,
    keptByDecision,
    decisions: summary.decisions,
    error,
  };
}

function countKept(plan: MailPlan, d: ResolvedDecisions, category: 'R1a' | 'R3'): number {
  let n = 0;
  for (const w of plan.workspaces) {
    const ids =
      category === 'R1a'
        ? w.r1.filter((r) => r.class === 'R1a').map((r) => r.suppressionId)
        : w.r3.map((r) => r.contactId);
    for (const id of ids) {
      const decision = d.rows.get(decisionKey(category, w.workspaceId, id));
      if (decision !== (category === 'R1a' ? 'revoke' : 'archive')) n++;
    }
  }
  return n;
}

/** Revoking a suppression must not release mail that is already waiting. */
async function assertNoPendingSends(plan: MailPlan, d: ResolvedDecisions): Promise<void> {
  const blocked: string[] = [];
  for (const w of plan.workspaces) {
    const targets = new Set(
      w.r1
        .filter(
          (r) =>
            r.kind === 'email' &&
            d.rows.get(decisionKey(r.class, w.workspaceId, r.suppressionId)) === 'revoke',
        )
        .map((r) => r.value),
    );
    const n = await pendingSendsTo(BigInt(w.workspaceId), targets);
    if (n > 0) blocked.push(`workspace ${w.workspaceId}: ${n}`);
  }
  if (blocked.length > 0) {
    throw new RemediationError(
      `queued sends or due follow-ups exist for addresses R1 would un-suppress (${blocked.join(', ')}); ` +
        'cancel them or keep those rows, then run a new dry run',
      'pending_sends',
    );
  }
}

interface CategoryInput {
  tx: Tx;
  plan: MailPlan;
  internals: MailPlanInternals;
  decisions: ResolvedDecisions;
  actor: Actor;
}

async function applyCategory(category: ApplyCategory, c: CategoryInput): Promise<CategoryOutcome> {
  const outcome: CategoryOutcome = { selected: 0, changed: 0, skipped: 0 };
  const byWorkspace: Record<string, number> = {};
  for (const w of c.plan.workspaces) {
    const ws = BigInt(w.workspaceId);
    const scope = (sub: string): ChangeScope => ({
      tx: c.tx,
      runId: c.plan.batchId,
      category: sub,
    });
    const count = (changed: boolean) => {
      outcome.selected++;
      if (changed) {
        outcome.changed++;
        byWorkspace[w.workspaceId] = (byWorkspace[w.workspaceId] ?? 0) + 1;
      } else {
        outcome.skipped++;
      }
    };
    const approved = c.decisions.categories.get(decisionKey(category, w.workspaceId)) === true;

    if (category === 'R0' && approved) {
      for (const r of w.r0)
        count(await applyR0(scope('R0'), ws, r.messageId, r.relevance, c.internals));
    } else if (category === 'R1') {
      for (const r of w.r1) {
        if (c.decisions.rows.get(decisionKey(r.class, w.workspaceId, r.suppressionId)) !== 'revoke')
          continue;
        count(await applyR1(scope(r.class), ws, r, c));
      }
    } else if (category === 'R2' && approved) {
      for (const r of w.r2) count(await applyR2(scope('R2'), ws, BigInt(r.messageId)));
    } else if (category === 'R3') {
      for (const r of w.r3) {
        if (c.decisions.rows.get(decisionKey('R3', w.workspaceId, r.contactId)) !== 'archive')
          continue;
        count(await applyR3(scope('R3'), ws, BigInt(r.contactId)));
      }
    } else if (category === 'R4' && approved) {
      for (const r of w.r4) {
        count(
          await deleteLogged(scope('R4'), {
            table: 'notifications',
            workspaceId: ws,
            id: BigInt(r.notificationId),
            guard: sql`t.kind = 'lead.replied'`,
          }),
        );
      }
    } else if (category === 'R7') {
      for (const r of w.r7) {
        if (c.decisions.rows.get(decisionKey('R7', w.workspaceId, r.mailboxId)) !== 'recheck_now')
          continue;
        count(await applyR7(scope('R7'), ws, BigInt(r.mailboxId)));
      }
    } else if (category === 'R8' && approved) {
      count(await applyR8(scope('R8'), ws, w, c));
    }
  }

  if (outcome.changed > 0) {
    await auditInTx(c.tx, {
      workspaceId: null,
      userId: c.actor.id,
      kind: 'remediation.apply',
      entityType: 'remediation_run',
      entityId: c.plan.batchId,
      payload: { category, ...outcome, byWorkspace },
    });
    for (const [ws, changed] of Object.entries(byWorkspace)) {
      await auditInTx(c.tx, {
        workspaceId: BigInt(ws),
        userId: c.actor.id,
        kind: 'remediation.apply',
        entityType: 'remediation_run',
        entityId: c.plan.batchId,
        payload: { category, changed },
      });
    }
  }
  return outcome;
}

async function applyR0(
  scope: ChangeScope,
  ws: bigint,
  messageId: string,
  relevance: MailPlan['workspaces'][number]['r0'][number]['relevance'],
  internals: MailPlanInternals,
): Promise<boolean> {
  const assessed = internals.assessments.get(messageId);
  if (!assessed) return false;
  const id = BigInt(messageId);
  return updateLogged(scope, {
    table: 'mail_messages',
    workspaceId: ws,
    id,
    cols: ['outreach_relevance', 'relevance_signals'],
    mutate: async () =>
      (
        await scope.tx
          .update(mailMessages)
          .set({ outreachRelevance: relevance, relevanceSignals: assessed.signals })
          .where(
            and(
              eq(mailMessages.workspaceId, ws),
              eq(mailMessages.id, id),
              eq(mailMessages.direction, 'inbound'),
              isNull(mailMessages.outreachRelevance),
            ),
          )
          .returning({ id: mailMessages.id })
      ).length,
  });
}

async function applyR1(
  scope: ChangeScope,
  ws: bigint,
  row: WorkspaceMailPlan['r1'][number],
  c: CategoryInput,
): Promise<boolean> {
  const id = BigInt(row.suppressionId);
  const revokeReason = `${REVOKE_REASON} (${c.plan.batchId}, ${row.class})`;
  const [prior] = await scope.tx
    .select()
    .from(suppressionList)
    .where(and(eq(suppressionList.workspaceId, ws), eq(suppressionList.id, id)))
    .limit(1);
  const changed = await updateLogged(scope, {
    table: 'suppression_list',
    workspaceId: ws,
    id,
    cols: ['revoked_at', 'revoked_by', 'revoke_reason'],
    mutate: async () =>
      (
        await scope.tx
          .update(suppressionList)
          .set({ revokedAt: new Date(), revokedBy: c.actor.id, revokeReason })
          .where(
            and(
              eq(suppressionList.workspaceId, ws),
              eq(suppressionList.id, id),
              isNull(suppressionList.revokedAt),
              eq(suppressionList.reason, row.reason as typeof suppressionList.$inferSelect.reason),
              eq(suppressionList.source, row.source as typeof suppressionList.$inferSelect.source),
            ),
          )
          .returning({ id: suppressionList.id })
      ).length,
  });
  if (changed && prior) {
    // Same event the F-03 revoke writes, so the suppression's history reads
    // the same whichever way it was lifted.
    await auditInTx(scope.tx, {
      workspaceId: ws,
      userId: c.actor.id,
      kind: 'suppression.revoke',
      entityType: 'suppression_entry',
      entityId: row.suppressionId,
      payload: {
        kind: prior.kind,
        value: prior.value,
        revokeReason,
        remediationRun: c.plan.batchId,
        category: row.class,
        prior: {
          reason: prior.reason,
          source: prior.source,
          sourceRef: prior.sourceRef,
          note: prior.note,
          expiresAt: prior.expiresAt?.toISOString() ?? null,
          createdBy: prior.createdBy,
          createdAt: prior.createdAt.toISOString(),
        },
      },
    });
  }
  return changed;
}

async function applyR2(scope: ChangeScope, ws: bigint, id: bigint): Promise<boolean> {
  return updateLogged(scope, {
    table: 'mail_messages',
    workspaceId: ws,
    id,
    cols: [
      'reply_classification',
      'reply_classification_confidence',
      'reply_classified_at',
      'extracted_emails',
    ],
    mutate: async () =>
      (
        await scope.tx
          .update(mailMessages)
          .set({
            replyClassification: null,
            replyClassificationConfidence: null,
            replyClassifiedAt: null,
            extractedEmails: [],
          })
          .where(
            and(
              eq(mailMessages.workspaceId, ws),
              eq(mailMessages.id, id),
              eq(mailMessages.direction, 'inbound'),
              // Not re-labelled as ours since the plan.
              or(
                isNull(mailMessages.outreachRelevance),
                inArray(mailMessages.outreachRelevance, ['bulk', 'unrelated']),
              ),
            ),
          )
          .returning({ id: mailMessages.id })
      ).length,
  });
}

async function applyR3(scope: ChangeScope, ws: bigint, id: bigint): Promise<boolean> {
  return updateLogged(scope, {
    table: 'contacts',
    workspaceId: ws,
    id,
    cols: ['status', 'tags'],
    mutate: async () =>
      (
        await scope.tx
          .update(contacts)
          .set({
            status: 'archived',
            tags: sql`array_append(${contacts.tags}, ${INBOUND_AUTO_TAG}::text)`,
          })
          .where(
            and(
              eq(contacts.workspaceId, ws),
              eq(contacts.id, id),
              eq(contacts.status, 'active'),
              // Still untouched by a person since the plan.
              sql`cardinality(${contacts.tags}) = 0`,
              sql`coalesce(${contacts.notes}, '') = ''`,
            ),
          )
          .returning({ id: contacts.id })
      ).length,
  });
}

async function applyR7(scope: ChangeScope, ws: bigint, id: bigint): Promise<boolean> {
  return updateLogged(scope, {
    table: 'mailboxes',
    workspaceId: ws,
    id,
    cols: ['imap_next_sync_after'],
    mutate: async () =>
      (
        await scope.tx
          .update(mailboxes)
          .set({ imapNextSyncAfter: new Date() })
          .where(
            and(
              eq(mailboxes.workspaceId, ws),
              eq(mailboxes.id, id),
              eq(mailboxes.status, 'failing'),
            ),
          )
          .returning({ id: mailboxes.id })
      ).length,
  });
}

async function applyR8(
  scope: ChangeScope,
  ws: bigint,
  w: WorkspaceMailPlan,
  c: CategoryInput,
): Promise<boolean> {
  const tokens = BigInt(w.r8.tokens);
  const reason = `${REVOKE_REASON}: tokens spent translating non-prospect mail`;
  const changed = await creditLogged(scope, {
    workspaceId: ws,
    tokens,
    reason,
    externalRef: `remediation:${c.plan.batchId}:R8:${w.workspaceId}`,
    payload: {
      actorUserId: c.actor.id,
      remediationRun: c.plan.batchId,
      usageLogIds: w.r8.usageLogIds,
    },
  });
  if (changed) {
    // Same audit event as a super-admin adjustment (tokens.adjust).
    await auditInTx(scope.tx, {
      workspaceId: ws,
      userId: c.actor.id,
      kind: 'tokens.adjust',
      entityType: 'workspace',
      entityId: w.workspaceId,
      payload: { delta: tokens.toString(), reason, remediationRun: c.plan.batchId },
    });
  }
  return changed;
}
