// PC-06: the accountable-owner rule's pre-deploy check.
//
// From this release on, automation only ever acts as an active owner: an
// active workspace whose owner account is not 'active', or whose owner has
// no workspace_members row, runs NO automatic work (inbox sync included)
// from the first tick after the deploy (automation-gate.ts, ownerProblem).
// Nothing in the migration checks that the existing workspaces pass, so
// this lists the ones that would stop, BEFORE the deploy, from the base
// tables (the workspace_automation_state view does not exist until the
// migration has run). Same rule as stateFromRow: an account that is not
// 'active' (or missing) first, then a missing member row.
//
// Read-only. Reports carry workspace ids and names, the owner's user id
// and account status only (no email addresses).

import { and, asc, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { users } from '@/lib/db/schema/auth';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';

// Accepts the app client, a script's own client, or a transaction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AccountableOwnersDb = PgDatabase<PgQueryResultHKT, any, any>;

export type OwnerProblemKind = 'owner_inactive' | 'owner_not_member';

export interface UnaccountableWorkspace {
  workspaceId: bigint;
  name: string;
  ownerUserId: string;
  /** users.accountStatus, or null when the owner row is missing. */
  ownerAccountStatus: string | null;
  problem: OwnerProblemKind;
}

/** Active workspaces whose automation the accountable-owner rule stops. */
export async function findWorkspacesWithoutAccountableOwner(
  db: AccountableOwnersDb,
): Promise<UnaccountableWorkspace[]> {
  const rows = await db
    .select({
      workspaceId: workspaces.id,
      name: workspaces.name,
      ownerUserId: workspaces.ownerUserId,
      ownerAccountStatus: users.accountStatus,
      memberId: workspaceMembers.id,
    })
    .from(workspaces)
    .leftJoin(users, eq(users.id, workspaces.ownerUserId))
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, workspaces.ownerUserId),
      ),
    )
    .where(eq(workspaces.status, 'active'))
    .orderBy(asc(workspaces.id));
  const out: UnaccountableWorkspace[] = [];
  for (const r of rows) {
    const problem: OwnerProblemKind | null =
      r.ownerAccountStatus !== 'active'
        ? 'owner_inactive'
        : r.memberId === null
          ? 'owner_not_member'
          : null;
    if (!problem) continue;
    out.push({
      workspaceId: r.workspaceId,
      name: r.name,
      ownerUserId: r.ownerUserId,
      ownerAccountStatus: r.ownerAccountStatus ?? null,
      problem,
    });
  }
  return out;
}

/** The plain-text report the CLI prints. */
export function renderAccountableOwnersReport(found: readonly UnaccountableWorkspace[]): string {
  if (found.length === 0) {
    return 'OK: every active workspace has an active owner who is a member. Automation keeps running after the deploy.';
  }
  const lines = [
    `STOP: ${found.length} active workspace(s) would run NO automatic work (inbox sync included) from the first tick after the deploy:`,
    '',
  ];
  for (const w of found) {
    const why =
      w.problem === 'owner_not_member'
        ? 'the owner has no workspace_members row'
        : `the owner account is ${w.ownerAccountStatus ?? 'missing'}`;
    lines.push(`  workspace ${w.workspaceId} "${w.name}" (owner ${w.ownerUserId}): ${why}`);
  }
  lines.push(
    '',
    'Before deploying, reactivate each owner or transfer ownership to an active member (super-admin console), or accept that these workspaces stop.',
  );
  return lines.join('\n');
}
