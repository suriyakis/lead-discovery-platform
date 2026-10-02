// AP-06: the free notify sweep. Every 6 hours the health tick evaluates
// every rule for every active workspace — no AI, no tokens — and raises
// in-app notifications by each finding's policy (types.ts NotifyPolicy):
//
//   never              not announced (most findings: /health, Today and
//                      the assistant show them)
//   on_appear          once per episode
//   max_once_per_days  at most every n days while present
//
// and, whatever the policy, at most ONE notification per rule per
// workspace per 24 hours: several findings of one rule that are due
// together are folded into one notification.
//
// The ledger (diagnostic_notices) remembers episodes: a finding that
// disappears closes its episode (cleared_at, and its unread notification
// is resolved: the alarm is over); when it comes back, a new episode
// starts. A finding whose rule THREW this time is unknown, not gone: its
// episode stays open. Each workspace's pass runs under a transaction-scoped
// advisory lock, so two sweeps (two processes, an overlapping tick) never
// announce the same thing twice.
//
// Recipients: the workspace's owners and admins (notifyWorkspaceAdmins:
// they can fix what a finding names), one deduplicated row each. A
// finding with a source-side alert uses the same key (a failing mailbox:
// its incident fingerprint, mailboxFailingDedupeKey)
// so an alert the IMAP tick raised and nobody read yet is not repeated.

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { diagnosticNotices, type DiagnosticNotice } from '@/lib/db/schema/diagnostics';
import { notifications } from '@/lib/db/schema/notifications';
import { workspaces } from '@/lib/db/schema/workspaces';
import type { NotificationKind } from '@/lib/kinds/notification';
import {
  adminDedupeKey,
  notifyWorkspaceAdmins,
  resolveNotifications,
} from '@/lib/services/notifications';
import { getWorkspaceDiagnostics, type DiagnosticsReport } from './engine';
import { fixHref } from './hrefs';
import type { Finding } from './types';

/** At most one notification per rule per workspace in this window. */
export const RULE_NOTIFY_CAP_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SentDiagnosticNotice {
  rule: string;
  /** The notification's dedupe key (the finding's, or the rule id for a
   *  folded notification). */
  dedupeKey: string;
  /** Findings it covers. */
  findings: number;
  /** Notification rows created (one per owner / admin). */
  rows: number;
}

export interface DiagnosticsNotifyResult {
  workspaceId: bigint;
  /** Notifications created this pass. */
  sent: SentDiagnosticNotice[];
  /** Due, but an unread notification with the same key already exists
   *  (e.g. the source's own alert): recorded as announced, nothing new. */
  alreadyOpen: string[];
  /** Due, but the rule already notified this workspace in the last 24 h. */
  capped: string[];
  /** Episodes that ended this pass (their unread alerts resolved). */
  cleared: string[];
  /** Another pass held this workspace's lock; nothing was done. */
  skipped: boolean;
}

function kindFor(f: Finding): NotificationKind {
  return f.notify.kind ?? (f.severity === 'critical' ? 'health.critical' : 'health.finding');
}

/** Is this tracked finding due by its own policy? */
export function isDue(
  f: Pick<Finding, 'notify'>,
  state: Pick<DiagnosticNotice, 'firstSeenAt' | 'lastNotifiedAt'>,
  now: Date,
): boolean {
  const p = f.notify.policy;
  const last = state.lastNotifiedAt;
  switch (p.kind) {
    case 'never':
      return false;
    case 'on_appear':
      return last === null || last.getTime() < state.firstSeenAt.getTime();
    case 'max_once_per_days':
      return last === null || last.getTime() <= now.getTime() - p.days * DAY_MS;
  }
}

/** An unread notification with this dedupe key exists: the workspace-wide
 *  row or any admin's copy (notifications.ts adminDedupeKey). */
async function hasUnreadNotice(workspaceId: bigint, dedupeKey: string): Promise<boolean> {
  const adminPrefix = adminDedupeKey(dedupeKey, '');
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        isNull(notifications.readAt),
        or(
          eq(notifications.dedupeKey, dedupeKey),
          // A prefix match without LIKE: a key may contain '_'.
          sql`left(${notifications.dedupeKey}, ${adminPrefix.length}) = ${adminPrefix}`,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The one notification for a rule's due findings. */
function noticeFor(rule: string, due: readonly Finding[]): {
  kind: NotificationKind;
  title: string;
  body: string;
  href: string | null;
  dedupeKey: string;
} {
  const first = due[0]!;
  if (due.length === 1) {
    return {
      kind: kindFor(first),
      title: first.title,
      body: first.detail,
      href: first.href,
      dedupeKey: first.notify.dedupeKey,
    };
  }
  const hrefs = new Set(due.map((f) => f.href));
  return {
    kind: kindFor(first),
    title: `${first.title} (and ${due.length - 1} more)`,
    body: due.map((f) => f.title).join(' · '),
    href: hrefs.size === 1 ? first.href : fixHref.health(),
    dedupeKey: rule,
  };
}

/**
 * Announce a workspace's findings by policy and update the ledger. The
 * report is usually a fresh one from the sweep; `now` defaults to the
 * report's evaluation time.
 */
export async function notifyDiagnostics(
  report: DiagnosticsReport,
  options: { now?: Date } = {},
): Promise<DiagnosticsNotifyResult> {
  const now = options.now ?? report.evaluatedAt;
  const workspaceId = report.workspaceId;
  const result: DiagnosticsNotifyResult = {
    workspaceId,
    sent: [],
    alreadyOpen: [],
    capped: [],
    cleared: [],
    skipped: false,
  };
  const failedRules = new Set(report.failedRules);
  const resolvedRules: string[] = [];
  const tracked = report.findings.filter((f) => f.notify.policy.kind !== 'never');
  // One finding per key (two findings with one key would be one episode).
  const byKey = new Map<string, Finding>();
  for (const f of tracked) if (!byKey.has(f.notify.dedupeKey)) byKey.set(f.notify.dedupeKey, f);

  await db.transaction(async (tx) => {
    // Serialise passes over one workspace; a pass that finds the lock taken
    // leaves the work to the one holding it.
    // Raw SQL: advisory locks have no builder form.
    const lockKey = `diagnostic_notices:${workspaceId}`;
    const [lock] = (await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtext(${lockKey})) as locked`,
    )) as unknown as Array<{ locked: boolean }>;
    if (!lock?.locked) {
      result.skipped = true;
      return;
    }

    const rows = await tx
      .select()
      .from(diagnosticNotices)
      .where(eq(diagnosticNotices.workspaceId, workspaceId));
    const state = new Map(rows.map((r) => [r.noticeKey, r]));

    // 1. Observe: start, continue or restart each tracked finding's episode.
    for (const [key, f] of byKey) {
      const prior = state.get(key);
      if (!prior) {
        const [inserted] = await tx
          .insert(diagnosticNotices)
          .values({
            workspaceId,
            noticeKey: key,
            ruleCode: f.rule,
            firstSeenAt: now,
            lastSeenAt: now,
          })
          .returning();
        if (inserted) state.set(key, inserted);
        continue;
      }
      const restarted = prior.clearedAt !== null;
      const [updated] = await tx
        .update(diagnosticNotices)
        .set({
          ruleCode: f.rule,
          lastSeenAt: now,
          ...(restarted ? { firstSeenAt: now, clearedAt: null } : {}),
        })
        .where(
          and(eq(diagnosticNotices.workspaceId, workspaceId), eq(diagnosticNotices.noticeKey, key)),
        )
        .returning();
      if (updated) state.set(key, updated);
    }

    // 2. Clear: episodes whose finding is gone — unless its rule threw.
    const goneRows = rows.filter(
      (r) => r.clearedAt === null && !byKey.has(r.noticeKey) && !failedRules.has(r.ruleCode),
    );
    const gone = goneRows.map((r) => r.noticeKey);
    // A rule with nothing left also ends its folded notification (keyed
    // by the rule id).
    const rulesPresent = new Set([...byKey.values()].map((f) => f.rule));
    for (const rule of new Set(goneRows.map((r) => r.ruleCode))) {
      if (!rulesPresent.has(rule)) resolvedRules.push(rule);
    }
    if (gone.length > 0) {
      await tx
        .update(diagnosticNotices)
        .set({ clearedAt: now })
        .where(
          and(
            eq(diagnosticNotices.workspaceId, workspaceId),
            inArray(diagnosticNotices.noticeKey, gone),
          ),
        );
      result.cleared.push(...gone);
    }

    // 3. Due findings, grouped by rule; the per-rule 24 h cap.
    const dueByRule = new Map<string, Finding[]>();
    for (const [key, f] of byKey) {
      const st = state.get(key);
      if (!st || !isDue(f, st, now)) continue;
      dueByRule.set(f.rule, [...(dueByRule.get(f.rule) ?? []), f]);
    }
    const lastByRule = new Map<string, number>();
    for (const r of state.values()) {
      if (!r.lastNotifiedAt) continue;
      const t = r.lastNotifiedAt.getTime();
      lastByRule.set(r.ruleCode, Math.max(lastByRule.get(r.ruleCode) ?? 0, t));
    }

    // 4. One notification per rule.
    for (const [rule, due] of dueByRule) {
      const last = lastByRule.get(rule);
      if (last !== undefined && last > now.getTime() - RULE_NOTIFY_CAP_MS) {
        result.capped.push(...due.map((f) => f.notify.dedupeKey));
        continue;
      }
      const notice = noticeFor(rule, due);
      const created = await notifyWorkspaceAdmins(workspaceId, notice);
      if (created.length > 0) {
        result.sent.push({
          rule,
          dedupeKey: notice.dedupeKey,
          findings: due.length,
          rows: created.length,
        });
      } else if (await hasUnreadNotice(workspaceId, notice.dedupeKey)) {
        result.alreadyOpen.push(notice.dedupeKey);
      } else {
        // notify() swallows its errors: nothing was written and nothing is
        // open, so leave the ledger alone and let the next sweep try again.
        continue;
      }
      // Announced: a new notification, or one still unread.
      await tx
        .update(diagnosticNotices)
        .set({
          lastNotifiedAt: now,
          notifyCount: sql`${diagnosticNotices.notifyCount} + 1`,
        })
        .where(
          and(
            eq(diagnosticNotices.workspaceId, workspaceId),
            inArray(
              diagnosticNotices.noticeKey,
              due.map((f) => f.notify.dedupeKey),
            ),
          ),
        );
    }
  });

  // The condition an unread alert announced is over: resolve it, so the
  // bell stops showing it and the next episode can notify again.
  for (const key of [...result.cleared, ...resolvedRules]) {
    await resolveNotifications(workspaceId, key);
  }
  return result;
}

export interface DiagnosticsSweepObserver {
  /** Best-effort; must not throw. */
  onWorkspaceFailed?: (workspaceId: bigint, err: unknown) => Promise<void> | void;
  /** Best-effort; must not throw. */
  onWorkspaceSucceeded?: (workspaceId: bigint) => Promise<void> | void;
}

export interface DiagnosticsSweepSummary {
  workspaces: number;
  /** Notifications created (one per rule announced). */
  notified: number;
  /** Workspaces whose evaluation had a rule throw. */
  partial: number;
  failed: number;
}

/**
 * The 6-hourly sweep (health.check.tick): every active workspace, or the
 * given ones. Free: rules only. One workspace failing does not stop the
 * others; the observer turns it into an ops incident (PC-07).
 */
export async function runDiagnosticsSweep(
  options: DiagnosticsSweepObserver & { workspaceIds?: readonly bigint[]; now?: Date } = {},
): Promise<DiagnosticsSweepSummary> {
  const ids =
    options.workspaceIds ??
    (
      await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.status, 'active'))
        .orderBy(workspaces.id)
    ).map((w) => w.id);
  const summary: DiagnosticsSweepSummary = {
    workspaces: ids.length,
    notified: 0,
    partial: 0,
    failed: 0,
  };
  for (const workspaceId of ids) {
    try {
      const report = await getWorkspaceDiagnostics(
        { workspaceId },
        options.now ? { now: options.now } : { fresh: true },
      );
      if (report.partial) summary.partial++;
      const r = await notifyDiagnostics(report);
      summary.notified += r.sent.length;
    } catch (err) {
      summary.failed++;
      console.error(
        `[diagnostics.sweep] workspace=${workspaceId} failed:`,
        err instanceof Error ? err.message : err,
      );
      await options.onWorkspaceFailed?.(workspaceId, err);
      continue;
    }
    await options.onWorkspaceSucceeded?.(workspaceId);
  }
  return summary;
}
