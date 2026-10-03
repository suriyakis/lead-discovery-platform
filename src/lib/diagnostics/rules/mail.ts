// AP-06 rules: mailboxes, suppressions and the send queue.

import { and, count, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { formatUtc } from '@/lib/format-utc';
import { mailMessages } from '@/lib/db/schema/mailing';
import { outreachQueue } from '@/lib/db/schema/outreach';
import { mailboxFailingDedupeKey, summarizeMailboxFailure } from '@/lib/services/mailbox';
import { getSendCapUsage } from '@/lib/services/outreach-queue';
import {
  REPLY_AUTO_ACTIONS_IMPACT_DAYS,
  getReplyAutoActionsImpact,
} from '@/lib/services/reply-auto-actions';
import { daysBefore, hoursBefore, plural, type DiagnosticsMailboxRow } from '../env';
import { fixHref } from '../hrefs';
import { defineRule } from '../rule';
import { NOTIFY_ON_APPEAR, type FindingDraft } from '../types';

// ---- mailboxes -------------------------------------------------------------

/**
 * flow:F-04 + PC-05: what "no active mailbox" means depends on why. Both a
 * FAILING and a PAUSED mailbox hold their queue (the automation gate defers
 * due entries and follow-ups instead of failing them), but a failing one
 * also stops reading replies, while a paused one is the operator's choice.
 */
export function noActiveMailboxDetail(anyFailing: boolean, anyPaused: boolean): string {
  const why = anyFailing && anyPaused ? 'failing or paused' : anyFailing ? 'failing' : 'paused';
  const parts = [`Nothing can be sent or received: no mailbox is active (each one is ${why}).`];
  if (anyFailing) {
    parts.push('Outreach and follow-ups queued on a failing mailbox are held until it works again.');
  }
  if (anyPaused) {
    parts.push(
      'Outreach and follow-ups that come due on a paused mailbox are held (not sent, not failed) ' +
        'until you re-enable it.',
    );
  }
  return parts.join(' ');
}

/**
 * One finding per failing mailbox (I095, X7). The copy says what really
 * happens: its queue is held (PC-05), and — the part operators miss —
 * replies, unsubscribe requests and bounces sent to it are no longer
 * received, so nothing it should learn from the inbox arrives. PC-09: the
 * copy ends with what re-checks it on its own (describeRecoveryPlan: by
 * failure class — a refused login is never retried automatically), and
 * the facts carry the class and the probe schedule. `unprobed` marks a row
 * that was failing before PC-09 (failure_class NULL): nothing probes it
 * until a person tests it or the reviewed backfill classifies it.
 */
export function mailboxFailingFindings(
  rows: ReadonlyArray<DiagnosticsMailboxRow>,
  workspaceId: bigint,
): FindingDraft[] {
  return rows
    .filter((m) => m.status === 'failing')
    .map((mb) => {
      const summary = summarizeMailboxFailure(mb);
      const since = mb.failingSince ?? mb.lastErrorAt ?? null;
      const when = mb.lastErrorAt ? ` (${formatUtc(mb.lastErrorAt)})` : '';
      const sentences = [
        since ? `It has been failing since ${formatUtc(since)}.` : 'It is failing.',
        summary.protocol === 'smtp' ? 'Nothing can be sent from it.' : null,
        'Its queued outreach and follow-ups are held, and replies, unsubscribe requests and ' +
          'bounces sent to it are no longer received.',
        summary.advice,
        summary.recovery || null,
        `Last error${when}: ${(mb.lastError ?? 'unknown').slice(0, 300)}`,
      ];
      return {
        code: 'mailbox.failing',
        severity: 'critical' as const,
        title: `Mailbox "${mb.name}" is failing`,
        detail: sentences.filter((s): s is string => Boolean(s)).join(' '),
        facts: {
          mailboxId: mb.id.toString(),
          protocol: summary.protocol,
          failureClass: mb.failureClass,
          unprobed: mb.failureClass === null,
          probeAttempts: mb.probeAttempts,
          nextProbeAt: mb.nextProbeAt?.toISOString() ?? null,
          consecutiveFailures: mb.imapConsecutiveFailures,
        },
        href: fixHref.mailbox(mb.id),
        entity: { type: 'mailbox', id: mb.id.toString(), label: mb.name },
        since,
        actionKinds: ['open'],
        // The same key the mailbox service raises at the source
        // (markMailboxFailing, PC-09: the incident's fingerprint), so the
        // sweep never doubles that alert.
        notify: {
          policy: NOTIFY_ON_APPEAR,
          dedupeKey: mailboxFailingDedupeKey(workspaceId, mb.id),
          kind: 'mailbox.failing',
        },
      };
    });
}

export const mailboxFailingRule = defineRule({
  id: 'mailbox.failing',
  owner: 'diagnostics',
  summary: 'Each failing mailbox: its queue is held and its inbox is not read.',
  async evaluate(env) {
    return mailboxFailingFindings(await env.mailboxes(), env.ctx.workspaceId);
  },
});

export function mailboxNoneFindings(rows: ReadonlyArray<DiagnosticsMailboxRow>): FindingDraft[] {
  const live = rows.filter((m) => m.status !== 'archived');
  if (live.some((m) => m.status === 'active')) return [];
  if (live.length === 0) {
    return [
      {
        code: 'mailbox.none',
        severity: 'warning',
        title: 'No mailbox connected',
        detail: 'Nothing can be sent or received until you connect one.',
        href: fixHref.newMailbox(),
      },
    ];
  }
  return [
    {
      code: 'mailbox.none',
      severity: 'warning',
      title: 'No active mailbox',
      detail: noActiveMailboxDetail(
        live.some((m) => m.status === 'failing'),
        live.some((m) => m.status === 'paused'),
      ),
      href: fixHref.mailboxes(),
    },
  ];
}

export const mailboxNoneRule = defineRule({
  id: 'mailbox.none',
  owner: 'diagnostics',
  summary: 'No mailbox connected, or none of them active.',
  async evaluate(env) {
    return mailboxNoneFindings(await env.mailboxes());
  },
});

export const mailboxPausedRule = defineRule({
  id: 'mailbox.paused',
  owner: 'diagnostics',
  summary: 'Each paused mailbox (the operator’s choice): context, not a problem.',
  async evaluate(env) {
    return (await env.mailboxes())
      .filter((m) => m.status === 'paused')
      .map((mb) => ({
        code: 'mailbox.paused',
        severity: 'info' as const,
        title: `Mailbox "${mb.name}" is paused`,
        detail:
          'It sends nothing and its replies are not read. Outreach and follow-ups that come due ' +
          'on it are held (not sent, not failed) until you re-enable it.',
        facts: { mailboxId: mb.id.toString() },
        href: fixHref.mailbox(mb.id),
        entity: { type: 'mailbox', id: mb.id.toString(), label: mb.name },
      }));
  },
});

// ---- suppressions ------------------------------------------------------------

/** suppression.spike fires above max(SPIKE_FLOOR, SPIKE_SHARE × senders). */
export const SUPPRESSION_SPIKE_FLOOR = 10;
export const SUPPRESSION_SPIKE_SHARE = 0.2;

export function suppressionSpikeThreshold(distinctInboundSenders: number): number {
  return Math.max(
    SUPPRESSION_SPIKE_FLOOR,
    Math.ceil(SUPPRESSION_SPIKE_SHARE * distinctInboundSenders),
  );
}

/**
 * X1: the reply classifier's auto-actions suppressed far more addresses
 * than people who wrote in could plausibly have asked for — the shape of
 * newsletters being read as "unsubscribe" (141 addresses in production,
 * colleagues included). Counts the automatic suppressions of the last 30
 * days that still suppress (getReplyAutoActionsImpact, the same numbers
 * /settings/outreach shows) against distinct inbound senders.
 */
export const suppressionSpikeRule = defineRule({
  id: 'suppression.spike',
  owner: 'diagnostics',
  summary: 'Automatic suppressions in 30 days above max(10, 20% of distinct inbound senders).',
  async evaluate(env) {
    const days = REPLY_AUTO_ACTIONS_IMPACT_DAYS;
    const since = daysBefore(env.now, days);
    const [impact, sendersRow] = await Promise.all([
      getReplyAutoActionsImpact(env.ctx, { days, now: env.now }),
      db
        .select({
          n: sql<number>`count(distinct lower(${mailMessages.fromAddress}))::int`,
        })
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.workspaceId, env.ctx.workspaceId),
            eq(mailMessages.direction, 'inbound'),
            gte(mailMessages.createdAt, since),
          ),
        ),
    ]);
    const senders = Number(sendersRow[0]?.n ?? 0);
    const threshold = suppressionSpikeThreshold(senders);
    const auto = impact.stillSuppressed;
    if (auto <= threshold) return [];
    return [
      {
        code: 'suppression.spike',
        severity: 'critical',
        title: `${plural(auto, 'address was', 'addresses were')} suppressed automatically in ${days} days`,
        detail:
          `That is more than ${senders === 0 ? 'expected with no inbound mail at all' : `expected from ${plural(senders, 'distinct sender')} who wrote in`}: ` +
          'replies read as "unsubscribe" or "bounce" may have blocked real contacts, so they will never be emailed. ' +
          'Review the automatic entries on the suppression list and revoke the wrong ones, and keep the reply ' +
          'auto-actions off until then.',
        facts: {
          autoSuppressed: auto,
          suppressedInWindow: impact.suppressedAddresses,
          distinctInboundSenders: senders,
          threshold,
          windowDays: days,
        },
        href: fixHref.suppression(),
        actionKinds: ['open', 'pause_automation'],
        notify: { policy: NOTIFY_ON_APPEAR, dedupeKey: 'suppression.spike' },
      },
    ];
  },
});

// ---- the send queue ----------------------------------------------------------

export const queueFailedRule = defineRule({
  id: 'queue.failed_24h',
  owner: 'outreach',
  summary: 'Queued emails that failed in the last 24 hours.',
  async evaluate(env) {
    const [row] = await db
      .select({ n: count() })
      .from(outreachQueue)
      .where(
        and(
          eq(outreachQueue.workspaceId, env.ctx.workspaceId),
          eq(outreachQueue.status, 'failed'),
          gte(outreachQueue.updatedAt, hoursBefore(env.now, 24)),
        ),
      );
    const n = Number(row?.n ?? 0);
    if (n === 0) return [];
    return [
      {
        code: 'queue.failed_24h',
        severity: 'warning',
        title: `${plural(n, 'queued email')} failed in the last 24 hours`,
        detail:
          'Each entry on the send queue says why it failed; retry it once the cause is fixed, or cancel it.',
        facts: { failed: n },
        href: fixHref.sendQueue(),
      },
    ];
  },
});

/**
 * The daily cap is full and due emails wait (I070). Reads the same usage
 * the drain applies (getSendCapUsage), so the two can never disagree.
 */
export const sendCapRule = defineRule({
  id: 'send.cap_exhausted',
  owner: 'ops',
  summary: 'The daily sending limit is used up while due emails wait.',
  async evaluate(env) {
    const usage = await getSendCapUsage(env.ctx, env.now);
    if (usage.remaining > 0) return [];
    const [row] = await db
      .select({ n: count() })
      .from(outreachQueue)
      .where(
        and(
          eq(outreachQueue.workspaceId, env.ctx.workspaceId),
          eq(outreachQueue.status, 'queued'),
          lte(outreachQueue.scheduledSendAt, env.now),
        ),
      );
    const waiting = Number(row?.n ?? 0);
    if (waiting === 0) return [];
    return [
      {
        code: 'send.cap_exhausted',
        severity: 'info',
        title: 'Daily sending limit reached',
        detail:
          `${usage.used} of ${usage.cap} emails went out in the last 24 hours, so ` +
          `${plural(waiting, 'due email waits', 'due emails wait')} until the window frees up. ` +
          'The limit is in the sending settings on the send queue page.',
        facts: { used: usage.used, cap: usage.cap, waiting },
        href: fixHref.sendQueue(),
      },
    ];
  },
});
