// Workspace health checks (AP-06 on top of the original weekly check).
//
// The findings come from ONE place: the diagnostics engine
// (src/lib/diagnostics, getWorkspaceDiagnostics). This module adds what is
// specific to the saved, scheduled report:
//
//   1. THE WEEKLY REPORT — a summary over the engine's findings plus the
//      AI COMMUNICATION REVIEW: the AI reads a sample of recent outbound
//      conversations and judges them the way a recipient would (flow,
//      repetition, contradictions, tone). Saved as a report (score 0–100,
//      findings, review, advice); a warning notification links to /health.
//      Admins switch the scheduled check (and with it every AI token it
//      spends) on or off and pick its interval (I069); "Run now" always
//      works.
//   2. THE TICK — health.check.tick (every 6 h) first runs the free notify
//      sweep for every active workspace (diagnostics/notify.ts: rules only,
//      no AI), then the weekly reports that are due. A report that throws
//      gives its slot back: health_check_last_at returns to its prior value,
//      so the next tick (≤ 6 h) retries instead of waiting a whole interval,
//      and the tick turns the failure into an ops incident (PC-07), which
//      the engine shows as a finding until a check succeeds.

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import {
  workspaceHealthReports,
  type WorkspaceHealthReport,
} from '@/lib/db/schema/health';
import { mailMessages, mailThreads } from '@/lib/db/schema/mailing';
import { workspaces } from '@/lib/db/schema/workspaces';
import { getAIProviderForCtx } from '@/lib/ai';
import { getWorkspaceDiagnostics, invalidateDiagnostics } from '@/lib/diagnostics/engine';
import { blendConversationReview } from '@/lib/diagnostics/score';
import {
  FINDING_SEVERITIES,
  findingMessage,
  isProblem,
  type Finding,
  type FindingSeverity,
  type LegacyHealthFinding,
} from '@/lib/diagnostics/types';
import { recordAuditEvent } from './audit';
import { checkGate } from './automation-gate';
import { canAdminWorkspace, type WorkspaceContext } from './context';
import { notify } from './notifications';
import { hasTokens } from './token-ledger';

export class HealthCheckError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'HealthCheckError';
    this.code = code;
  }
}

/** Finding severities, mildest first (the engine's). */
export const HEALTH_FINDING_SEVERITIES = FINDING_SEVERITIES;
export type HealthFindingSeverity = FindingSeverity;

/** @deprecated AP-06: the one-sentence shape of reports saved before the
 *  engine and of collectRuleFindings. New code reads Finding. */
export type HealthFinding = LegacyHealthFinding;

/** A finding as a saved report keeps it: the engine's fields plus the
 *  one-sentence `message` older readers know. */
export interface StoredHealthFinding {
  code: string;
  severity: FindingSeverity;
  advisory?: boolean;
  title?: string;
  detail?: string;
  message: string;
  href?: string;
}

export function toStoredFinding(f: Finding): StoredHealthFinding {
  return {
    code: f.code,
    severity: f.severity,
    advisory: f.advisory,
    title: f.title,
    detail: f.detail,
    message: findingMessage(f),
    ...(f.href ? { href: f.href } : {}),
  };
}

/** Read a saved report's findings, whatever release wrote them. */
export function readStoredFindings(raw: unknown): StoredHealthFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): StoredHealthFinding[] => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const severity = (FINDING_SEVERITIES as readonly string[]).includes(String(o.severity))
      ? (o.severity as FindingSeverity)
      : 'info';
    const title = typeof o.title === 'string' ? o.title : undefined;
    const detail = typeof o.detail === 'string' ? o.detail : undefined;
    const message =
      typeof o.message === 'string'
        ? o.message
        : title
          ? findingMessage({ title, detail: detail ?? '' })
          : '';
    return [
      {
        code: typeof o.code === 'string' ? o.code : 'unknown',
        severity,
        advisory: o.advisory === true,
        ...(title ? { title } : {}),
        ...(detail ? { detail } : {}),
        message,
        ...(typeof o.href === 'string' ? { href: o.href } : {}),
      },
    ];
  });
}

/**
 * @deprecated AP-06: a thin wrapper kept one release for callers of the
 * old rule check. It returns the engine's findings (advisory ones left
 * out) in the old one-sentence shape. Use getWorkspaceDiagnostics.
 */
export async function collectRuleFindings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<HealthFinding[]> {
  const report = await getWorkspaceDiagnostics(ctx, { fresh: true });
  return report.findings
    .filter((f) => !f.advisory)
    .map((f) => ({
      severity: f.severity,
      code: f.code,
      message: findingMessage(f),
      ...(f.href ? { href: f.href } : {}),
    }));
}

export interface ThreadReview {
  threadId: string;
  subject: string;
  naturalness: number;
  issues: string[];
  advice: string[];
}

const ReviewSchema = z.object({
  naturalness: z.number().int().min(0).max(100),
  issues: z.array(z.string().max(300)).max(8).default([]),
  advice: z.array(z.string().max(300)).max(5).default([]),
});

/** How many recent conversations the AI reads per check. */
const THREAD_SAMPLE = 3;
/** Transcript budget per thread fed to the reviewer. */
const TRANSCRIPT_CHAR_BUDGET = 9000;

// ---- settings ---------------------------------------------------------

/** I069: the intervals an admin can pick for the scheduled check. */
export const HEALTH_CHECK_INTERVAL_CHOICES = [1, 3, 7, 14, 30] as const;

export const HealthCheckSettingsSchema = z.object({
  enabled: z.boolean(),
  intervalDays: z
    .number()
    .int()
    .refine((n) => (HEALTH_CHECK_INTERVAL_CHOICES as readonly number[]).includes(n), {
      message: `the interval is one of ${HEALTH_CHECK_INTERVAL_CHOICES.join(', ')} days`,
    }),
});
export type HealthCheckSettingsInput = z.infer<typeof HealthCheckSettingsSchema>;

export interface HealthCheckSettings {
  enabled: boolean;
  intervalDays: number;
  /** The last scheduled (or manual) check's claim. */
  lastAt: Date | null;
  /** When the check is next due (null while off); the 6-hourly tick
   *  starts it within 6 hours of this. */
  nextDueAt: Date | null;
}

export async function getHealthCheckSettings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<HealthCheckSettings> {
  const [ws] = await db
    .select({
      enabled: workspaces.healthCheckEnabled,
      intervalDays: workspaces.healthCheckIntervalDays,
      lastAt: workspaces.healthCheckLastAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  if (!ws) throw new HealthCheckError('workspace not found', 'not_found');
  const nextDueAt = !ws.enabled
    ? null
    : ws.lastAt
      ? new Date(ws.lastAt.getTime() + ws.intervalDays * 24 * 60 * 60 * 1000)
      : new Date();
  return { ...ws, nextDueAt };
}

/**
 * I069: switch the scheduled check (its AI review spends tokens) on or off
 * and set its interval. Owners and admins; audited with before and after.
 */
export async function updateHealthCheckSettings(
  ctx: WorkspaceContext,
  input: HealthCheckSettingsInput,
): Promise<HealthCheckSettings> {
  if (!canAdminWorkspace(ctx)) {
    throw new HealthCheckError('Permission denied: health.settings', 'permission_denied');
  }
  const parsed = HealthCheckSettingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new HealthCheckError(
      parsed.error.issues.map((i) => i.message).join('; '),
      'invalid_input',
    );
  }
  const before = await getHealthCheckSettings(ctx);
  await db.transaction(async (tx) => {
    await tx
      .update(workspaces)
      .set({
        healthCheckEnabled: parsed.data.enabled,
        healthCheckIntervalDays: parsed.data.intervalDays,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, ctx.workspaceId));
    await recordAuditEvent(
      ctx,
      {
        kind: 'health_check.settings_update',
        entityType: 'workspace',
        entityId: ctx.workspaceId,
        payload: {
          before: { enabled: before.enabled, intervalDays: before.intervalDays },
          after: parsed.data,
        },
      },
      tx,
    );
  });
  invalidateDiagnostics(ctx.workspaceId);
  return getHealthCheckSettings(ctx);
}

// ---- AI communication review ----------------------------------------

async function sampleRecentThreads(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  sinceDays: number,
): Promise<Array<{ threadId: bigint; subject: string; transcript: string }>> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  // Threads with recent activity AND at least one outbound message —
  // we're reviewing OUR side of the conversation.
  const threads = await db
    .select({ id: mailThreads.id, subject: mailThreads.subject })
    .from(mailThreads)
    .where(
      and(
        eq(mailThreads.workspaceId, ctx.workspaceId),
        gte(mailThreads.lastMessageAt, since),
        gte(mailThreads.messageCount, 3),
      ),
    )
    .orderBy(desc(mailThreads.lastMessageAt))
    .limit(THREAD_SAMPLE * 3);
  if (threads.length === 0) return [];

  const out: Array<{ threadId: bigint; subject: string; transcript: string }> = [];
  const msgs = await db
    .select({
      threadId: mailMessages.threadId,
      direction: mailMessages.direction,
      fromName: mailMessages.fromName,
      bodyText: mailMessages.bodyText,
      createdAt: mailMessages.createdAt,
    })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        inArray(mailMessages.threadId, threads.map((t) => t.id)),
      ),
    )
    .orderBy(mailMessages.createdAt);

  for (const t of threads) {
    const rows = msgs.filter((m) => m.threadId === t.id);
    if (!rows.some((m) => m.direction === 'outbound')) continue;
    let transcript = rows
      .map((m) => {
        const who = m.direction === 'outbound' ? '[us]' : `[${m.fromName ?? 'them'}]`;
        return `${who}\n${(m.bodyText ?? '').trim().slice(0, 1500)}`;
      })
      .join('\n\n---\n\n');
    if (transcript.length > TRANSCRIPT_CHAR_BUDGET) {
      transcript = transcript.slice(0, TRANSCRIPT_CHAR_BUDGET) + '\n… [truncated]';
    }
    out.push({ threadId: t.id, subject: t.subject, transcript });
    if (out.length >= THREAD_SAMPLE) break;
  }
  return out;
}

export async function reviewCommunicationQuality(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  sinceDays: number,
): Promise<ThreadReview[]> {
  const samples = await sampleRecentThreads(ctx, sinceDays);
  if (samples.length === 0) return [];
  const ai = await getAIProviderForCtx(ctx, 'ai.health_check');

  const reviews: ThreadReview[] = [];
  for (const s of samples) {
    try {
      const verdict = await ai.generateJson(
        {
          system: [
            'You are a communication-quality reviewer for B2B sales email',
            'threads. Judge the messages marked [us] the way the RECIPIENT',
            'would experience them. Score naturalness 0-100 and list concrete',
            'issues: repetition of earlier questions/claims, broken',
            'conversation flow (ignoring what the recipient said), robotic or',
            'template-like tone, re-introductions mid-thread, contradictions,',
            'wrong language or awkward phrasing, pushiness. For each issue',
            'give short actionable advice. If the thread reads well, say so',
            'with an empty issues list. Return JSON only:',
            '{"naturalness": int 0-100, "issues": string[], "advice": string[]}',
          ].join('\n'),
          prompt: `Subject: ${s.subject}\n\nConversation (oldest → newest):\n${s.transcript}`,
        },
        ReviewSchema,
        { temperature: 0.2, maxTokens: 600, mockSeed: `health:${s.threadId}` },
      );
      reviews.push({
        threadId: s.threadId.toString(),
        subject: s.subject,
        naturalness: verdict.naturalness,
        issues: verdict.issues ?? [],
        advice: verdict.advice ?? [],
      });
    } catch (err) {
      console.error(
        `[health-check] thread review failed (thread=${s.threadId}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return reviews;
}

// ---- the report --------------------------------------------------------

/**
 * Write a health report: the engine's findings (fresh), the AI review of
 * recent conversations when the gate and the wallet allow it, the blended
 * score and the advice; notify when something needs attention.
 */
export async function runWorkspaceHealthCheck(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  options: {
    /** PC-06: a person pressed Run now (the tick passes false). */
    manual?: boolean;
  } = {},
): Promise<WorkspaceHealthReport> {
  const [ws] = await db
    .select({ intervalDays: workspaces.healthCheckIntervalDays })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  const intervalDays = ws?.intervalDays ?? 7;

  const diagnostics = await getWorkspaceDiagnostics(ctx, { fresh: true });

  // The AI part costs tokens — skip it (rules still run) on an empty
  // wallet; the empty wallet is itself the top finding at that point.
  // PC-06: also under a Background AI hold, and for the scheduled run
  // when the workspace has no accountable owner.
  // PC-05: the scheduled run also skips it while the workspace is paused.
  const aiGate = await checkGate(ctx, 'background_ai', {
    manual: options.manual ?? false,
    spendsTokens: true,
  });
  const commReview =
    aiGate.allowed && (await hasTokens(ctx))
      ? await reviewCommunicationQuality(ctx, intervalDays)
      : [];

  const score = blendConversationReview(
    diagnostics.score,
    commReview.map((r) => r.naturalness),
  );
  const problems = diagnostics.findings.filter(isProblem);
  const advice = [
    ...problems.map(findingMessage),
    ...commReview.flatMap((r) => r.advice),
  ].slice(0, 20);

  const [report] = await db
    .insert(workspaceHealthReports)
    .values({
      workspaceId: ctx.workspaceId,
      score,
      findings: diagnostics.findings.map(toStoredFinding),
      commReview,
      advice,
    })
    .returning();
  if (!report) throw new HealthCheckError('report insert returned no row', 'invariant');

  const commIssueCount = commReview.reduce((a, r) => a + r.issues.length, 0);
  if (problems.length > 0 || commIssueCount > 0 || score < 80) {
    await notify(ctx.workspaceId, {
      kind: 'health.warning',
      title: `Workspace health check: score ${score}/100 — ${problems.length} problem(s), ${commIssueCount} conversation issue(s)`,
      body: advice.slice(0, 3).join(' · ') || null,
      href: '/health',
      dedupeKey: 'health.warning',
    });
  }

  return report;
}

/** Admin-triggered immediate check (the "Run now" button). */
export async function runHealthCheckNow(
  ctx: WorkspaceContext,
): Promise<WorkspaceHealthReport> {
  if (!canAdminWorkspace(ctx)) {
    throw new HealthCheckError('Permission denied: health.run', 'permission_denied');
  }
  const report = await runWorkspaceHealthCheck(ctx, { manual: true });
  await db
    .update(workspaces)
    .set({ healthCheckLastAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaces.id, ctx.workspaceId));
  invalidateDiagnostics(ctx.workspaceId);
  return report;
}

export async function listHealthReports(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  options: { limit?: number } = {},
): Promise<WorkspaceHealthReport[]> {
  return db
    .select()
    .from(workspaceHealthReports)
    .where(eq(workspaceHealthReports.workspaceId, ctx.workspaceId))
    .orderBy(desc(workspaceHealthReports.createdAt))
    .limit(Math.min(options.limit ?? 10, 50));
}

/**
 * Tick entry point: atomically claim workspaces whose check is due
 * (enabled + lastAt older than their interval), then run each. The
 * conditional UPDATE prevents double-runs across concurrent ticks.
 *
 * PC-07: the observer hears each claimed workspace's outcome (the tick
 * turns a failure into an ops incident and a later success resolves it).
 * A claim that throws counts as that workspace's failure instead of
 * aborting the whole tick.
 *
 * I069: a check that throws gives its slot back — health_check_last_at
 * returns to the value it had before the claim (only while the claim is
 * still ours), so the workspace is due again at the next tick, at most 6
 * hours later, instead of a whole interval.
 */
export interface HealthCheckTickObserver {
  /** Best-effort; must not throw. */
  onWorkspaceFailed?: (workspaceId: bigint, err: unknown) => Promise<void> | void;
  /** Best-effort; must not throw. */
  onWorkspaceSucceeded?: (workspaceId: bigint) => Promise<void> | void;
}

export async function processDueHealthChecks(
  options: HealthCheckTickObserver & {
    /** PC-13: only these workspaces (the health-check tick passes the
     *  ones whose automation policy runs the health check). Omitted = every
     *  active workspace with the health check on. */
    workspaceIds?: readonly bigint[];
  } = {},
): Promise<{
  checked: number;
  failed: number;
  /** Failed checks whose slot went back for the next tick. */
  retrying: number;
}> {
  if (options.workspaceIds && options.workspaceIds.length === 0) {
    return { checked: 0, failed: 0, retrying: 0 };
  }
  const due = await db
    .select({
      id: workspaces.id,
      ownerUserId: workspaces.ownerUserId,
      intervalDays: workspaces.healthCheckIntervalDays,
      lastAt: workspaces.healthCheckLastAt,
    })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.status, 'active'),
        eq(workspaces.healthCheckEnabled, true),
        options.workspaceIds ? inArray(workspaces.id, [...options.workspaceIds]) : undefined,
      ),
    );

  let checked = 0;
  let failed = 0;
  let retrying = 0;
  const now = Date.now();
  for (const ws of due) {
    const intervalMs = ws.intervalDays * 24 * 60 * 60 * 1000;
    if (ws.lastAt && now - ws.lastAt.getTime() < intervalMs) continue;
    // Atomic claim (same pattern as auto top-up): only one tick wins.
    const cutoff = new Date(now - intervalMs);
    const claimedAt = new Date();
    let claimed = false;
    try {
      const rows = await db
        .update(workspaces)
        .set({ healthCheckLastAt: claimedAt, updatedAt: claimedAt })
        .where(
          and(
            eq(workspaces.id, ws.id),
            sql`(${workspaces.healthCheckLastAt} IS NULL OR ${workspaces.healthCheckLastAt} < ${cutoff.toISOString()}::timestamptz)`,
          ),
        )
        .returning({ id: workspaces.id });
      if (!rows[0]) continue;
      claimed = true;
      await runWorkspaceHealthCheck({ workspaceId: ws.id }, { manual: false });
      checked++;
    } catch (err) {
      failed++;
      console.error(
        `[health.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      if (claimed && (await releaseHealthCheckClaim(ws.id, claimedAt, ws.lastAt))) retrying++;
      await options.onWorkspaceFailed?.(ws.id, err);
      continue;
    }
    await options.onWorkspaceSucceeded?.(ws.id);
  }
  return { checked, failed, retrying };
}

/** Give a failed check's slot back (I069): only while the claim is still
 *  ours. Best-effort; true when it was restored. */
async function releaseHealthCheckClaim(
  workspaceId: bigint,
  claimedAt: Date,
  prior: Date | null,
): Promise<boolean> {
  try {
    const rows = await db
      .update(workspaces)
      .set({ healthCheckLastAt: prior })
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.healthCheckLastAt, claimedAt)))
      .returning({ id: workspaces.id });
    return rows.length > 0;
  } catch (err) {
    console.error(
      `[health.tick] workspace=${workspaceId}: the failed check's slot was not restored:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
