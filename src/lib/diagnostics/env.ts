// AP-06: what one evaluation of the engine shares between rules.
//
// Several rules read the same rows (the workspace's mailboxes, its
// automation policy, its billing columns). The environment loads each of
// them at most once per evaluation, lazily: a rule that needs the policy
// pays for it, and when the loader throws, only the rules that asked for it
// fail (each one degrades to `diagnostics.partial` on its own).

import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { mailboxes, type Mailbox } from '@/lib/db/schema/mailing';
import { workspaces } from '@/lib/db/schema/workspaces';
import {
  resolveAutomationPolicy,
  type AutomationPolicy,
} from '@/lib/services/automation-policy';
import type { WorkspaceContext } from '@/lib/services/context';

/** The workspace columns rules read. */
export interface DiagnosticsWorkspaceRow {
  id: bigint;
  status: string;
  tokenBalance: bigint;
  billingExempt: boolean;
  plan: string;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
}

/** A non-archived mailbox as the mailbox rules read it. */
export type DiagnosticsMailboxRow = Pick<
  Mailbox,
  | 'id'
  | 'name'
  | 'status'
  | 'lastError'
  | 'lastErrorAt'
  | 'failingSince'
  | 'imapConsecutiveFailures'
  | 'failureClass'
  | 'nextProbeAt'
  | 'probeAttempts'
  | 'smtpHost'
  | 'smtpPort'
  | 'imapHost'
  | 'imapPort'
>;

export interface DiagnosticsEnv {
  readonly ctx: Pick<WorkspaceContext, 'workspaceId'>;
  /** The evaluation's clock: every time window is measured from it. */
  readonly now: Date;
  workspace(): Promise<DiagnosticsWorkspaceRow>;
  /** The automation policy (gate state + configuration), PC-13. */
  policy(): Promise<AutomationPolicy>;
  /** Mailboxes that are not archived, oldest first. */
  mailboxes(): Promise<DiagnosticsMailboxRow[]>;
}

export class DiagnosticsWorkspaceNotFoundError extends Error {
  public readonly code = 'not_found' as const;
  constructor(workspaceId: bigint) {
    super(`workspace ${workspaceId} not found`);
    this.name = 'DiagnosticsWorkspaceNotFoundError';
  }
}

/** Memoise a loader: the first call starts it, later calls share it. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load();
    return pending;
  };
}

export function createDiagnosticsEnv(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  now: Date,
): DiagnosticsEnv {
  const wsId = ctx.workspaceId;
  return {
    ctx: { workspaceId: wsId },
    now,
    workspace: once(async () => {
      const [row] = await db
        .select({
          id: workspaces.id,
          status: workspaces.status,
          tokenBalance: workspaces.tokenBalance,
          billingExempt: workspaces.billingExempt,
          plan: workspaces.plan,
          subscriptionStatus: workspaces.subscriptionStatus,
          trialEndsAt: workspaces.trialEndsAt,
        })
        .from(workspaces)
        .where(eq(workspaces.id, wsId))
        .limit(1);
      if (!row) throw new DiagnosticsWorkspaceNotFoundError(wsId);
      return row;
    }),
    policy: once(() => resolveAutomationPolicy({ workspaceId: wsId }, { now })),
    mailboxes: once(() =>
      db
        .select({
          id: mailboxes.id,
          name: mailboxes.name,
          status: mailboxes.status,
          lastError: mailboxes.lastError,
          lastErrorAt: mailboxes.lastErrorAt,
          failingSince: mailboxes.failingSince,
          imapConsecutiveFailures: mailboxes.imapConsecutiveFailures,
          failureClass: mailboxes.failureClass,
          nextProbeAt: mailboxes.nextProbeAt,
          probeAttempts: mailboxes.probeAttempts,
          smtpHost: mailboxes.smtpHost,
          smtpPort: mailboxes.smtpPort,
          imapHost: mailboxes.imapHost,
          imapPort: mailboxes.imapPort,
        })
        .from(mailboxes)
        .where(and(eq(mailboxes.workspaceId, wsId), ne(mailboxes.status, 'archived')))
        .orderBy(asc(mailboxes.id)),
    ),
  };
}

/** `now - days` (every rule window is [since, now)). */
export function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export function hoursBefore(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
