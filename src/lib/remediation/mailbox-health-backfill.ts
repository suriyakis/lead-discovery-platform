// PC-09 (X7): the reviewed backfill of mailboxes that were already failing
// before mailbox health shipped.
//
// Prod had two (workspace 1's since 2026-05-08 on a refused SMTP 587,
// workspace 2's after 13 failed syncs), and nobody was told. PC-09 does not
// announce or probe them on its own: a mailbox whose failure_class is NULL
// is never probed (services/mailbox-health.ts), and the IMAP tick no longer
// adopts failing rows (flow:F-04's interim pass is gone). Instead:
//
//   1. a dry run (read only) lists every failing mailbox with no class:
//      ids, failing since, consecutive failures, the failing side, the
//      class it would get and the endpoint — no addresses, names or error
//      text, so the report can go into a ticket;
//   2. the owner reviews it; --apply --expect <fingerprint> then gives each
//      listed mailbox its class, its incident (ops_event, PC-08 alerts the
//      platform owner) and its owners' / admins' notification
//      (services/mailbox.ts trackPreexistingFailingMailbox) — and leaves
//      next_probe_at NULL: a backfilled mailbox is not probed
//      automatically. It recovers when a person fixes the settings (one
//      scheduled check), clicks Test again or Reactivate.
//
// --apply refuses when the candidate set is not the one the reviewed dry
// run fingerprinted, and is idempotent (a tracked mailbox has a class and
// drops out of the plan).

import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { db as appDb } from '@/lib/db/client';
import { mailboxes } from '@/lib/db/schema/mailing';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  classifyConnectionFailure,
  classifyMailboxFailure,
  parseStoredMailboxError,
  type ConnectionFailureCause,
  type MailboxFailureClass,
  type MailProtocol,
} from '@/lib/mail/connection-errors';
import { trackPreexistingFailingMailbox } from '@/lib/services/mailbox';

// Accepts the app client, a script's own client, or a transaction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BackfillDb = PgDatabase<PgQueryResultHKT, any, any>;

export const BACKFILL_TAG = 'PC-09 mailbox health backfill';

export class MailboxBackfillError extends Error {
  public readonly code: 'drift' | 'no_owner';
  constructor(message: string, code: 'drift' | 'no_owner') {
    super(message);
    this.name = 'MailboxBackfillError';
    this.code = code;
  }
}

export interface MailboxBackfillRow {
  workspaceId: string;
  workspaceStatus: string;
  mailboxId: string;
  /** failing_since, else last_error_at, else updated_at (ISO). */
  failingSince: string;
  consecutiveFailures: number;
  /** The side the stored error names. */
  protocol: MailProtocol;
  /** What the stored error says, in one word. */
  cause: ConnectionFailureCause;
  /** The class --apply gives it. */
  failureClass: MailboxFailureClass;
  /** host:port of the failing side. */
  endpoint: string;
}

export interface MailboxBackfillPlan {
  tag: string;
  rows: MailboxBackfillRow[];
  /** sha256 over the rows: --apply must be given this. */
  fingerprint: string;
  totals: { mailboxes: number; workspaces: number; byClass: Record<MailboxFailureClass, number> };
}

/** What --apply would do. Read only. */
export async function planMailboxHealthBackfill(db: BackfillDb): Promise<MailboxBackfillPlan> {
  const found = await db
    .select({
      id: mailboxes.id,
      workspaceId: mailboxes.workspaceId,
      workspaceStatus: workspaces.status,
      lastError: mailboxes.lastError,
      lastErrorAt: mailboxes.lastErrorAt,
      failingSince: mailboxes.failingSince,
      updatedAt: mailboxes.updatedAt,
      imapConsecutiveFailures: mailboxes.imapConsecutiveFailures,
      smtpHost: mailboxes.smtpHost,
      smtpPort: mailboxes.smtpPort,
      imapHost: mailboxes.imapHost,
      imapPort: mailboxes.imapPort,
    })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(eq(mailboxes.status, 'failing'), isNull(mailboxes.failureClass)))
    .orderBy(asc(mailboxes.workspaceId), asc(mailboxes.id));

  const rows: MailboxBackfillRow[] = found.map((m) => {
    const stored = parseStoredMailboxError(m.lastError);
    const since = m.failingSince ?? m.lastErrorAt ?? m.updatedAt;
    return {
      workspaceId: m.workspaceId.toString(),
      workspaceStatus: m.workspaceStatus,
      mailboxId: m.id.toString(),
      failingSince: since.toISOString(),
      consecutiveFailures: m.imapConsecutiveFailures,
      protocol: stored.protocol,
      cause: classifyConnectionFailure(stored.message),
      failureClass: classifyMailboxFailure({ message: stored.message }),
      endpoint:
        stored.protocol === 'smtp'
          ? `${m.smtpHost}:${m.smtpPort}`
          : `${m.imapHost ?? '(no IMAP host)'}:${m.imapPort ?? '-'}`,
    };
  });
  const byClass: Record<MailboxFailureClass, number> = { auth: 0, connection: 0, ambiguous: 0 };
  for (const r of rows) byClass[r.failureClass]++;
  return {
    tag: BACKFILL_TAG,
    rows,
    fingerprint: createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16),
    totals: {
      mailboxes: rows.length,
      workspaces: new Set(rows.map((r) => r.workspaceId)).size,
      byClass,
    },
  };
}

/** The dry-run report (plain text, safe for a ticket). */
export function renderMailboxHealthBackfillReport(plan: MailboxBackfillPlan): string {
  const lines = [
    `${plan.tag} — ${plan.totals.mailboxes} failing mailbox(es) without a failure class in ${plan.totals.workspaces} workspace(s)`,
    `by class: auth ${plan.totals.byClass.auth} · connection ${plan.totals.byClass.connection} · ambiguous ${plan.totals.byClass.ambiguous}`,
    `fingerprint: ${plan.fingerprint}`,
    '',
  ];
  if (plan.rows.length === 0) {
    lines.push('Nothing to backfill.');
    return lines.join('\n');
  }
  lines.push('workspace  mailbox  failing since              failures  side  cause    class       endpoint');
  for (const r of plan.rows) {
    lines.push(
      [
        r.workspaceId.padEnd(9),
        r.mailboxId.padEnd(7),
        r.failingSince.padEnd(25),
        String(r.consecutiveFailures).padEnd(8),
        r.protocol.padEnd(4),
        r.cause.padEnd(7),
        r.failureClass.padEnd(10),
        `${r.endpoint}${r.workspaceStatus === 'active' ? '' : ` (workspace ${r.workspaceStatus})`}`,
      ].join('  '),
    );
  }
  lines.push(
    '',
    '--apply gives each mailbox its class, opens its incident and notifies its',
    "workspace's owners and admins. None of them is probed automatically afterwards.",
  );
  return lines.join('\n');
}

export interface MailboxBackfillResult {
  plan: MailboxBackfillPlan;
  tracked: number;
  notified: number;
  /** Rows that changed between the plan and their turn (left alone). */
  skipped: number;
}

/**
 * Apply exactly the reviewed plan, through the app's database client (the
 * incident and notification writers use it). Refuses on drift.
 */
export async function applyMailboxHealthBackfill(options: {
  expectFingerprint: string;
  now?: Date;
}): Promise<MailboxBackfillResult> {
  const plan = await planMailboxHealthBackfill(appDb);
  if (plan.fingerprint !== options.expectFingerprint) {
    throw new MailboxBackfillError(
      `the failing mailboxes changed since the reviewed dry run (expected ${options.expectFingerprint}, now ${plan.fingerprint}); run the dry run again`,
      'drift',
    );
  }
  const now = options.now ?? new Date();
  const wsIds = [...new Set(plan.rows.map((r) => BigInt(r.workspaceId)))];
  const owners =
    wsIds.length > 0
      ? await appDb
          .select({ id: workspaces.id, ownerUserId: workspaces.ownerUserId })
          .from(workspaces)
          .where(inArray(workspaces.id, wsIds))
      : [];
  const ownerOf = new Map(owners.map((o) => [o.id.toString(), o.ownerUserId]));
  let tracked = 0;
  let notified = 0;
  let skipped = 0;
  for (const r of plan.rows) {
    const ownerUserId = ownerOf.get(r.workspaceId);
    if (!ownerUserId) {
      throw new MailboxBackfillError(
        `workspace ${r.workspaceId} has no owner to record the audit row against`,
        'no_owner',
      );
    }
    const res = await trackPreexistingFailingMailbox(
      { workspaceId: BigInt(r.workspaceId), userId: ownerUserId },
      BigInt(r.mailboxId),
      now,
    );
    if (res.tracked) {
      tracked++;
      if (res.notified) notified++;
    } else {
      skipped++;
    }
  }
  return { plan, tracked, notified, skipped };
}
