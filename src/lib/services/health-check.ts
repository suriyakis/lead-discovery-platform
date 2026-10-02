// AI workspace health check. Runs on a schedule (default weekly) per
// workspace and does two things a human account manager would:
//
//   1. RULE FINDINGS — deterministic audit of configuration + operations:
//      empty wallet, no active product, no mailbox / each failing
//      mailbox / no active mailbox, recipes without a target country,
//      failed runs, review backlog, stale drafts, pending follow-up
//      approvals. (There is no mock-search finding yet — see I073.)
//   2. COMMUNICATION REVIEW — the AI reads a sample of recent outbound
//      conversations and judges them the way a recipient would: is the
//      flow natural? does it repeat itself? does it contradict earlier
//      messages or break the thread's context?
//
// The result is persisted as a report (score 0–100 + advice) and, when
// anything is wrong, a warning notification linking to /health.

import { and, asc, count, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { formatUtc } from '@/lib/format-utc';
import { connectorRecipes, connectorRuns } from '@/lib/db/schema/connectors';
import {
  workspaceHealthReports,
  type WorkspaceHealthReport,
} from '@/lib/db/schema/health';
import {
  mailMessages,
  mailThreads,
  mailboxes,
  type Mailbox,
} from '@/lib/db/schema/mailing';
import { outreachDrafts } from '@/lib/db/schema/outreach';
import { productProfiles } from '@/lib/db/schema/products';
import { outreachFollowUps } from '@/lib/db/schema/follow-ups';
import { reviewItems } from '@/lib/db/schema/review';
import { workspaces } from '@/lib/db/schema/workspaces';
import { getAIProviderForCtx } from '@/lib/ai';
import { checkGate } from './automation-gate';
import { canAdminWorkspace, type WorkspaceContext } from './context';
import { summarizeMailboxFailure } from './mailbox';
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

/** Finding severities, mildest first. DS-09: info reads neutral, warning
 *  amber (src/lib/ui/tone.ts); there is no critical level yet. */
export const HEALTH_FINDING_SEVERITIES = ['info', 'warning'] as const;
export type HealthFindingSeverity = (typeof HEALTH_FINDING_SEVERITIES)[number];

export interface HealthFinding {
  severity: HealthFindingSeverity;
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

/**
 * flow:F-04 + PC-05: what "no active mailbox" means depends on why. Both
 * a FAILING and a PAUSED mailbox hold their queue — the automation gate
 * defers due entries and follow-ups instead of failing them (P0-F08) —
 * but a failing one also stops reading replies, while a paused one is
 * the operator's own choice.
 */
export function noActiveMailboxMessage(anyFailing: boolean, anyPaused: boolean): string {
  const why = anyFailing && anyPaused ? 'failing or paused' : anyFailing ? 'failing' : 'paused';
  const parts = [`No mailbox is active (each one is ${why}) — no replies are read.`];
  if (anyFailing) {
    parts.push(
      'Outreach and follow-ups queued on a failing mailbox are held until it works again.',
    );
  }
  if (anyPaused) {
    parts.push(
      'Outreach and follow-ups that come due on a paused mailbox are held (not sent, not failed) ' +
        'until you re-enable it.',
    );
  }
  return parts.join(' ');
}

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

  const mbs = await db
    .select({
      id: mailboxes.id,
      name: mailboxes.name,
      status: mailboxes.status,
      lastError: mailboxes.lastError,
      lastErrorAt: mailboxes.lastErrorAt,
      failingSince: mailboxes.failingSince,
      smtpHost: mailboxes.smtpHost,
      smtpPort: mailboxes.smtpPort,
      imapHost: mailboxes.imapHost,
      imapPort: mailboxes.imapPort,
    })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, wsId), ne(mailboxes.status, 'archived')))
    .orderBy(asc(mailboxes.id));
  findings.push(...mailboxFindings(mbs));

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
      // No target country = no geography gate (applyGeoGate → 'no_gate'):
      // nothing is held for review, leads from anywhere pass straight on.
      message: `${Number(recipeRow.total) - Number(recipeRow.withCountry)} of ${recipeRow.total} recipes have no target country — the geography gate is off for them, so leads from any country pass review and can be emailed.`,
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

/** A mailbox as the rule check reads it. */
export type MailboxFindingRow = Pick<
  Mailbox,
  | 'id'
  | 'name'
  | 'status'
  | 'lastError'
  | 'lastErrorAt'
  | 'failingSince'
  | 'smtpHost'
  | 'smtpPort'
  | 'imapHost'
  | 'imapPort'
>;

/**
 * Mailbox findings (AP-01 wording, flow:F-04 behaviour). The statuses
 * behave differently, so the copy says what each one really does:
 *   - none connected (archived ones do not count): nothing is sent and
 *     no replies are read;
 *   - each FAILING mailbox, by name and linking to its page (I095): its
 *     queued outreach and follow-ups are HELD, not sent and not failed;
 *     replies to it are not read (and nothing is sent from it when SMTP
 *     is the broken side); the advice is the mailbox page's own
 *     (summarizeMailboxFailure — e.g. "use port 465 with TLS on connect"
 *     when a server refuses 587), plus the last error;
 *   - no ACTIVE mailbox left: noActiveMailboxMessage — failing and paused
 *     ones both hold their queue (PC-05).
 * A paused mailbox next to an active one is the operator's choice, not
 * a finding.
 */
export function mailboxFindings(rows: ReadonlyArray<MailboxFindingRow>): HealthFinding[] {
  const live = rows.filter((m) => m.status !== 'archived');
  const out: HealthFinding[] = [];
  for (const mb of live.filter((m) => m.status === 'failing')) {
    const summary = summarizeMailboxFailure(mb);
    const since = mb.failingSince ? ` since ${formatUtc(mb.failingSince)}` : '';
    const when = mb.lastErrorAt ? ` (${formatUtc(mb.lastErrorAt)})` : '';
    out.push({
      severity: 'warning',
      code: 'mailbox.failing',
      message:
        `Mailbox "${mb.name}" has been failing${since}. ${summary.impact} ${summary.advice}` +
        ` Last error${when}: ${(mb.lastError ?? 'unknown').slice(0, 300)}`,
      href: `/mailbox/${mb.id}`,
    });
  }
  if (!live.some((m) => m.status === 'active')) {
    out.push(
      live.length === 0
        ? {
            severity: 'warning',
            code: 'mailbox.none',
            message: 'No mailbox is connected — nothing can be sent and no replies are read.',
            href: '/mailbox/new',
          }
        : {
            severity: 'warning',
            code: 'mailbox.none',
            message: noActiveMailboxMessage(
              live.some((m) => m.status === 'failing'),
              live.some((m) => m.status === 'paused'),
            ),
            href: '/mailbox',
          },
    );
  }
  return out;
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

  const findings = await collectRuleFindings(ctx);

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
  const report = await runWorkspaceHealthCheck(ctx, { manual: true });
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
 *
 * PC-07: the observer hears each claimed workspace's outcome (the tick
 * turns a failure into an ops incident and a later success resolves it).
 * A claim that throws counts as that workspace's failure instead of
 * aborting the whole tick.
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
}> {
  if (options.workspaceIds && options.workspaceIds.length === 0) return { checked: 0, failed: 0 };
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
  const now = Date.now();
  for (const ws of due) {
    const intervalMs = ws.intervalDays * 24 * 60 * 60 * 1000;
    if (ws.lastAt && now - ws.lastAt.getTime() < intervalMs) continue;
    // Atomic claim (same pattern as auto top-up): only one tick wins.
    const cutoff = new Date(now - intervalMs);
    try {
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
      await runWorkspaceHealthCheck({ workspaceId: ws.id }, { manual: false });
      checked++;
    } catch (err) {
      failed++;
      console.error(
        `[health.tick] workspace=${ws.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      await options.onWorkspaceFailed?.(ws.id, err);
      continue;
    }
    await options.onWorkspaceSucceeded?.(ws.id);
  }
  return { checked, failed };
}
