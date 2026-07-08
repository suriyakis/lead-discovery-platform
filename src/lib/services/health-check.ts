// AI workspace health check. Runs on a schedule (default weekly) per
// workspace and does two things a human account manager would:
//
//   1. RULE FINDINGS — deterministic audit of configuration + operations:
//      empty wallet, recipes without a target country, mock search, no
//      mailbox, failed runs, review backlog, stale drafts, pending
//      follow-up approvals.
//   2. COMMUNICATION REVIEW — the AI reads a sample of recent outbound
//      conversations and judges them the way a recipient would: is the
//      flow natural? does it repeat itself? does it contradict earlier
//      messages or break the thread's context?
//
// The result is persisted as a report (score 0–100 + advice) and, when
// anything is wrong, a warning notification linking to /health.

import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { connectorRecipes, connectorRuns } from '@/lib/db/schema/connectors';
import {
  workspaceHealthReports,
  type WorkspaceHealthReport,
} from '@/lib/db/schema/health';
import { mailMessages, mailThreads, mailboxes } from '@/lib/db/schema/mailing';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { productProfiles } from '@/lib/db/schema/products';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { reviewItems } from '@/lib/db/schema/review';
import { workspaces } from '@/lib/db/schema/workspaces';
import { getAIProviderForCtx } from '@/lib/ai';
import { canAdminWorkspace, type WorkspaceContext } from './context';
import { notify } from './notifications';
import { getTokenWallet, hasTokens } from './token-ledger';

export class HealthCheckError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'HealthCheckError';
    this.code = code;
  }
}

export interface HealthFinding {
  severity: 'warning' | 'info';
  code: string;
  message: string;
  href?: string;
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

// ---- rule findings --------------------------------------------------

export async function collectRuleFindings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<HealthFinding[]> {
  const wsId = ctx.workspaceId;
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const findings: HealthFinding[] = [];

  const wallet = await getTokenWallet(ctx);
  if (!wallet.billingExempt && wallet.balance <= 0n) {
    findings.push({
      severity: 'warning',
      code: 'tokens.empty',
      message:
        'Token wallet is empty — discovery, drafting and translation are paused.',
      href: '/settings/billing',
    });
  }

  const [products] = await db
    .select({ c: count() })
    .from(productProfiles)
    .where(and(eq(productProfiles.workspaceId, wsId), eq(productProfiles.active, true)));
  if (Number(products?.c ?? 0) === 0) {
    findings.push({
      severity: 'warning',
      code: 'products.none',
      message: 'No active product profile — nothing can be qualified or pitched.',
      href: '/products/new',
    });
  }

  const [mbs] = await db
    .select({ c: count() })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, wsId), eq(mailboxes.status, 'active')));
  if (Number(mbs?.c ?? 0) === 0) {
    findings.push({
      severity: 'warning',
      code: 'mailbox.none',
      message: 'No active mailbox — approved drafts cannot be sent.',
      href: '/mailbox/new',
    });
  }

  const recipes = await db
    .select({
      total: count(),
      withCountry: sql<number>`count(*) filter (where selectors->>'country' is not null)::int`,
    })
    .from(connectorRecipes)
    .where(eq(connectorRecipes.workspaceId, wsId));
  const recipeRow = recipes[0];
  if (recipeRow && Number(recipeRow.total) > 0 && Number(recipeRow.withCountry) < Number(recipeRow.total)) {
    findings.push({
      severity: 'warning',
      code: 'recipes.no_country',
      message: `${Number(recipeRow.total) - Number(recipeRow.withCountry)} of ${recipeRow.total} recipes have no target country — the geography gate cannot verify those leads and holds them for manual review.`,
      href: '/connectors',
    });
  }

  const [failedRuns] = await db
    .select({ c: count() })
    .from(connectorRuns)
    .where(
      and(
        eq(connectorRuns.workspaceId, wsId),
        eq(connectorRuns.status, 'failed'),
        gte(connectorRuns.createdAt, since7d),
      ),
    );
  if (Number(failedRuns?.c ?? 0) > 0) {
    findings.push({
      severity: 'warning',
      code: 'runs.failed',
      message: `${failedRuns!.c} discovery run(s) failed in the last 7 days.`,
      href: '/connectors',
    });
  }

  const [backlog] = await db
    .select({ c: count() })
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.workspaceId, wsId),
        sql`${reviewItems.state} in ('new', 'needs_review')`,
        sql`${reviewItems.updatedAt} < ${since7d.toISOString()}::timestamptz`,
      ),
    );
  if (Number(backlog?.c ?? 0) > 10) {
    findings.push({
      severity: 'info',
      code: 'review.backlog',
      message: `${backlog!.c} review items are older than a week — reviewing them also teaches the qualifier what you want.`,
      href: '/review',
    });
  }

  const [staleDrafts] = await db
    .select({ c: count() })
    .from(outreachDrafts)
    .where(
      and(
        eq(outreachDrafts.workspaceId, wsId),
        sql`${outreachDrafts.status} in ('draft', 'needs_edit')`,
        sql`${outreachDrafts.updatedAt} < ${since7d.toISOString()}::timestamptz`,
      ),
    );
  if (Number(staleDrafts?.c ?? 0) > 0) {
    findings.push({
      severity: 'info',
      code: 'drafts.stale',
      message: `${staleDrafts!.c} draft(s) have waited over a week for approval — cold leads go colder.`,
      href: '/drafts',
    });
  }

  const [pendingApprovals] = await db
    .select({ c: count() })
    .from(outreachFollowUps)
    .where(
      and(
        eq(outreachFollowUps.workspaceId, wsId),
        eq(outreachFollowUps.status, 'awaiting_approval'),
      ),
    );
  if (Number(pendingApprovals?.c ?? 0) > 0) {
    findings.push({
      severity: 'info',
      code: 'follow_ups.pending',
      message: `${pendingApprovals!.c} follow-up(s) are awaiting approval.`,
      href: '/communication/follow-ups',
    });
  }

  return findings;
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
        sql`${mailThreads.messageCount} >= 3`,
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

// ---- the check --------------------------------------------------------

export async function runWorkspaceHealthCheck(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<WorkspaceHealthReport> {
  const [ws] = await db
    .select({ intervalDays: workspaces.healthCheckIntervalDays })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  const intervalDays = ws?.intervalDays ?? 7;

  const findings = await collectRuleFindings(ctx);

  // The AI part costs tokens — skip it (rules still run) on an empty
  // wallet; the empty wallet is itself the top finding at that point.
  const commReview = (await hasTokens(ctx))
    ? await reviewCommunicationQuality(ctx, intervalDays)
    : [];

  // Score: start at 100; -15 per warning, -5 per info; communication
  // naturalness averages in when we have reviews (weighted 40%).
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const infos = findings.length - warnings;
  let score = 100 - warnings * 15 - infos * 5;
  if (commReview.length > 0) {
    const avg =
      commReview.reduce((a, r) => a + r.naturalness, 0) / commReview.length;
    score = Math.round(score * 0.6 + avg * 0.4);
  }
  score = Math.max(0, Math.min(100, score));

  const advice = [
    ...findings.map((f) => f.message),
    ...commReview.flatMap((r) => r.advice),
  ].slice(0, 20);

  const [report] = await db
    .insert(workspaceHealthReports)
    .values({
      workspaceId: ctx.workspaceId,
      score,
      findings,
      commReview,
      advice,
    })
    .returning();
  if (!report) throw new HealthCheckError('report insert returned no row', 'invariant');

  const commIssueCount = commReview.reduce((a, r) => a + r.issues.length, 0);
  if (warnings > 0 || commIssueCount > 0 || score < 80) {
    await notify(ctx.workspaceId, {
      kind: 'health.warning',
      title: `Workspace health check: score ${score}/100 — ${warnings} warning(s), ${commIssueCount} conversation issue(s)`,
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
  const report = await runWorkspaceHealthCheck(ctx);
  await db
    .update(workspaces)
    .set({ healthCheckLastAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaces.id, ctx.workspaceId));
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
 */
export async function processDueHealthChecks(): Promise<{
  checked: number;
  failed: number;
}> {
  const due = await db
    .select({
      id: workspaces.id,
      ownerUserId: workspaces.ownerUserId,
      intervalDays: workspaces.healthCheckIntervalDays,
      lastAt: workspaces.healthCheckLastAt,
    })
    .from(workspaces)
    .where(
      and(eq(workspaces.status, 'active'), eq(workspaces.healthCheckEnabled, true)),
    );

  let checked = 0;
  let failed = 0;
  const now = Date.now();
  for (const ws of due) {
    const intervalMs = ws.intervalDays * 24 * 60 * 60 * 1000;
    if (ws.lastAt && now - ws.lastAt.getTime() < intervalMs) continue;
    // Atomic claim (same pattern as auto top-up): only one tick wins.
    const cutoff = new Date(now - intervalMs);
    const claimed = await db
      .update(workspaces)
      .set({ healthCheckLastAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(workspaces.id, ws.id),
          sql`(${workspaces.healthCheckLastAt} IS NULL OR ${workspaces.healthCheckLastAt} < ${cutoff.toISOString()}::timestamptz)`,
        ),
      )
      .returning({ id: workspaces.id });
    if (!claimed[0]) continue;
    try {
      await runWorkspaceHealthCheck({ workspaceId: ws.id });
      checked++;
    } catch (err) {
      failed++;
      console.error(
        `[health.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { checked, failed };
}
