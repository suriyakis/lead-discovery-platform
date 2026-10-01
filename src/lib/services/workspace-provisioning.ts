// How a signed-in user gets their first workspace (audit I117,
// deliverable ia:F-07). Every path that hands someone a workspace of
// their own goes through provisionOwnedWorkspace:
//   - the very first sign-in by OWNER_EMAIL (bootstrap super-admin);
//   - a plain self-signup;
//   - a pre-authorisation for "their own new workspace", at first sign-in
//     or when a super-admin pre-authorises someone who already has an
//     account (applyPreauthorization);
//   - the "Create your workspace" form on the no-workspace screen
//     (createFirstWorkspace), allowed once, for a user with no workspace.
//
// Before this module a pre-authorisation without a workspace activated
// the user and then returned before the Personal-workspace provisioning,
// so they landed active with zero memberships, and nothing outside
// /admin could create a workspace. Pre-authorising someone who already
// had an account activated them but never added the membership, and the
// entry was never consumed.
//
// None of these functions take a WorkspaceContext: the caller has no
// workspace yet (same as workspace.ts createWorkspace). Each authorises
// from the user row it is given or locks.

import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { preauthorizedEmails, users, type PreauthorizedEmail } from '@/lib/db/schema/auth';
import {
  workspaceMemberRole,
  workspaceMembers,
  workspaceSettings,
  workspaces,
  type Workspace,
  type WorkspaceMemberRole,
} from '@/lib/db/schema/workspaces';
import { WorkspaceServiceError } from './workspace';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** db or an open transaction; reads only need select(). */
type Reader = Pick<typeof db, 'select'>;

/** Why a workspace was provisioned; stored in the workspace.bootstrap audit row. */
export type WorkspaceBootstrapReason =
  | 'owner_email_first_login'
  | 'self_signup'
  | 'preauthorized_own_workspace'
  | 'self_service_create';

/** Longest workspace name the self-service form accepts (same as /admin). */
export const WORKSPACE_NAME_MAX = 120;

/**
 * A slug for a new workspace: the name in lowercase a-z0-9 words joined
 * by hyphens (at most 40 characters, 'workspace' when nothing is left),
 * plus 8 random hex characters so two users can both call theirs
 * 'Personal'. Matches admin.ts SLUG_RE.
 */
export function workspaceSlugFor(name: string): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'workspace';
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Create a workspace owned by `userId`: the workspace (onboarding
 * 'pending', so its owner gets the first-run wizard once), the owner
 * membership, the workspace_settings row and a workspace.bootstrap
 * audit row. Runs inside the caller's transaction; the audit row is
 * written on that transaction too, because it references the new
 * workspace, which another connection cannot see before commit.
 */
export async function provisionOwnedWorkspace(
  tx: Tx,
  input: {
    userId: string;
    email: string;
    name: string;
    reason: WorkspaceBootstrapReason;
    /** Extra audit payload, e.g. who pre-authorised the user. */
    details?: Record<string, unknown>;
  },
): Promise<Workspace> {
  const [ws] = await tx
    .insert(workspaces)
    .values({
      name: input.name,
      slug: workspaceSlugFor(input.name),
      ownerUserId: input.userId,
      onboardingStatus: 'pending',
    })
    .returning();
  if (!ws) {
    throw new WorkspaceServiceError('workspace insert returned no row', 'invariant_violation');
  }
  await tx.insert(workspaceMembers).values({
    workspaceId: ws.id,
    userId: input.userId,
    role: 'owner',
  });
  await tx.insert(workspaceSettings).values({ workspaceId: ws.id }).onConflictDoNothing();
  await tx.insert(auditLog).values({
    workspaceId: ws.id,
    userId: input.userId,
    kind: 'workspace.bootstrap',
    entityType: 'workspace',
    entityId: String(ws.id),
    payload: { reason: input.reason, email: input.email, ...input.details },
  });
  return ws;
}

// ---- who may create a workspace ---------------------------------------

export interface WorkspaceStartState {
  /** True when the user may create their own workspace right now. */
  canCreate: boolean;
  /**
   * Why they may not: they belong to a workspace (for someone who still
   * reaches the no-workspace screen, every one of those is archived),
   * or they already own one they are no longer a member of.
   */
  blockedBy: 'membership' | 'owned_workspace' | null;
  /** Names of the archived workspaces the user belongs to. */
  archivedWorkspaces: string[];
}

async function readStartState(reader: Reader, userId: string): Promise<WorkspaceStartState> {
  const memberships = await reader
    .select({ name: workspaces.name, status: workspaces.status })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.id));
  const [owned] = await reader
    .select({ n: count() })
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, userId));
  const ownsAny = (owned?.n ?? 0) > 0;
  const blockedBy =
    memberships.length > 0 ? 'membership' : ownsAny ? 'owned_workspace' : null;
  return {
    canCreate: blockedBy === null,
    blockedBy,
    archivedWorkspaces: memberships.filter((m) => m.status === 'archived').map((m) => m.name),
  };
}

/**
 * What the no-workspace screen offers this user. Creating a workspace is
 * allowed once: only while they belong to no workspace (of any status)
 * and own none.
 */
export async function getWorkspaceStartState(userId: string): Promise<WorkspaceStartState> {
  return readStartState(db, userId);
}

const FirstWorkspaceInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give your workspace a name.')
    .max(WORKSPACE_NAME_MAX, `Keep the name to ${WORKSPACE_NAME_MAX} characters or fewer.`),
});

/**
 * Self-service: a signed-in, active user with no workspace creates one
 * and becomes its owner. A second attempt, or any attempt by someone who
 * already belongs to or owns a workspace, is refused with
 * 'permission_denied'. The user row is locked for the check, so two
 * submits at once still create only one workspace. FOR NO KEY UPDATE, not
 * FOR UPDATE: the membership and audit inserts take FOR KEY SHARE on the
 * same row, which FOR UPDATE would block.
 */
export async function createFirstWorkspace(
  userId: string,
  input: { name: string },
): Promise<Workspace> {
  const parsed = FirstWorkspaceInput.safeParse(input);
  if (!parsed.success) {
    throw new WorkspaceServiceError(
      parsed.error.issues[0]?.message ?? 'Invalid workspace name.',
      'invalid_input',
    );
  }
  const { name } = parsed.data;
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ email: users.email, role: users.role, accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, userId))
      .for('no key update');
    if (!user) throw new WorkspaceServiceError('user not found', 'not_found');
    if (user.accountStatus !== 'active' && user.role !== 'super_admin') {
      throw new WorkspaceServiceError('Your account is not active yet.', 'permission_denied');
    }
    const state = await readStartState(tx, userId);
    if (!state.canCreate) {
      throw new WorkspaceServiceError(
        state.blockedBy === 'membership'
          ? 'You already belong to a workspace, so you cannot create another one here.'
          : 'You have already created a workspace. Ask an admin to restore it or add you to one.',
        'permission_denied',
      );
    }
    const ws = await provisionOwnedWorkspace(tx, {
      userId,
      email: user.email,
      name,
      reason: 'self_service_create',
    });
    await tx.update(users).set({ activeWorkspaceId: ws.id }).where(eq(users.id, userId));
    return ws;
  });
}

// ---- pre-authorisation ------------------------------------------------

/**
 * True when the user already has somewhere to work: a membership of an
 * active workspace, or an active workspace they own.
 *
 * Archived workspaces do not count here, unlike in readStartState. The
 * self-service rule ("create a workspace once") treats an archived
 * workspace as used up, so a user cannot route around an archive by
 * creating a new one. A super-admin who explicitly pre-authorises
 * "their own new workspace" for that same user means to unblock them,
 * and must not get an entry that is consumed with nothing granted.
 */
async function hasLiveWorkspace(reader: Reader, userId: string): Promise<boolean> {
  const [membership] = await reader
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.status, 'active')))
    .limit(1);
  if (membership) return true;
  const [owned] = await reader
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.ownerUserId, userId), eq(workspaces.status, 'active')))
    .limit(1);
  return owned !== undefined;
}

export type PreauthorizationOutcome =
  /** Added to the named workspace (or already a member of it). */
  | { kind: 'joined'; workspaceId: bigint }
  /** Given a workspace of their own. */
  | { kind: 'own_workspace'; workspaceId: bigint }
  /** Asked for their own workspace but already has an active one; nothing added. */
  | { kind: 'kept_existing' };

function parseRole(role: string): WorkspaceMemberRole {
  return workspaceMemberRole.enumValues.find((r) => r === role) ?? 'member';
}

/**
 * Grant what a pre-authorisation entry promises to an account that now
 * exists, and mark the entry consumed. The caller activates the account.
 *
 * - A named workspace that still exists and is active: add the user at
 *   the entry's role (an existing membership is left as it is) and audit
 *   user.preauthorize_consumed in that workspace.
 * - No workspace ("their own new workspace"), or a named one deleted or
 *   archived since: provision a workspace they own, unless they already
 *   belong to or own an active one (hasLiveWorkspace). Archived ones do
 *   not block: the entry is an explicit grant.
 */
export async function applyPreauthorization(
  tx: Tx,
  input: {
    userId: string;
    email: string;
    entry: PreauthorizedEmail;
    /** Who the membership audit row is attributed to. */
    actorUserId: string;
  },
): Promise<PreauthorizationOutcome> {
  const { entry } = input;
  let outcome: PreauthorizationOutcome | null = null;

  const requestedId = entry.workspaceId && /^\d+$/.test(entry.workspaceId)
    ? BigInt(entry.workspaceId)
    : null;
  if (requestedId !== null) {
    const [target] = await tx
      .select({ id: workspaces.id, status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, requestedId))
      .limit(1);
    if (target && target.status === 'active') {
      const role = parseRole(entry.role);
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: target.id, userId: input.userId, role })
        .onConflictDoNothing();
      await tx.insert(auditLog).values({
        workspaceId: target.id,
        userId: input.actorUserId,
        kind: 'user.preauthorize_consumed',
        entityType: 'user',
        entityId: input.userId,
        payload: { email: input.email, role },
      });
      outcome = { kind: 'joined', workspaceId: target.id };
    }
  }

  if (outcome === null) {
    if (!(await hasLiveWorkspace(tx, input.userId))) {
      const ws = await provisionOwnedWorkspace(tx, {
        userId: input.userId,
        email: input.email,
        name: 'Personal',
        reason: 'preauthorized_own_workspace',
        details: {
          preauthorizedBy: entry.createdBy ?? null,
          ...(requestedId !== null ? { requestedWorkspaceId: requestedId.toString() } : {}),
        },
      });
      outcome = { kind: 'own_workspace', workspaceId: ws.id };
    } else {
      outcome = { kind: 'kept_existing' };
    }
  }

  await tx
    .update(preauthorizedEmails)
    .set({ consumedAt: new Date() })
    .where(eq(preauthorizedEmails.id, entry.id));
  return outcome;
}

// ---- sign-in ----------------------------------------------------------

export type SignInProvisioning =
  | 'returning'
  | 'owner_bootstrap'
  | 'preauthorized'
  | 'self_signup';

/**
 * The Auth.js signIn event (auth.ts). Records the sign-in time, and on a
 * first sign-in makes sure the new account ends up active with a
 * workspace:
 *   1. OWNER_EMAIL: promoted to super_admin, with a Personal workspace.
 *   2. Pre-authorised: activated, then applyPreauthorization (the named
 *      workspace, or their own one when the entry names none).
 *   3. Anyone else: activated with a Personal workspace (self-signup).
 */
export async function provisionOnSignIn(
  user: { id: string; email: string },
  options: { isNewUser: boolean; ownerEmail: string | null },
): Promise<SignInProvisioning> {
  const email = user.email.toLowerCase().trim();

  await db.update(users).set({ lastSignedInAt: new Date() }).where(eq(users.id, user.id));
  if (!options.isNewUser) return 'returning';

  if (options.ownerEmail !== null && email === options.ownerEmail) {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          role: 'super_admin',
          accountStatus: 'active',
          accountStatusUpdatedAt: new Date(),
          accountStatusUpdatedBy: user.id,
        })
        .where(eq(users.id, user.id));
      await provisionOwnedWorkspace(tx, {
        userId: user.id,
        email,
        name: 'Personal',
        reason: 'owner_email_first_login',
      });
    });
    return 'owner_bootstrap';
  }

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(preauthorizedEmails)
      .where(and(eq(preauthorizedEmails.email, email), isNull(preauthorizedEmails.consumedAt)))
      .limit(1)
      .for('update');

    await tx
      .update(users)
      .set({
        accountStatus: 'active',
        accountStatusUpdatedAt: new Date(),
        accountStatusUpdatedBy: entry ? (entry.createdBy ?? null) : user.id,
      })
      .where(eq(users.id, user.id));

    if (entry) {
      // The admin who pre-authorised them, while that account exists
      // (audit_log.user_id is a foreign key); otherwise the user.
      const [admin] = entry.createdBy
        ? await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, entry.createdBy))
            .limit(1)
        : [];
      await applyPreauthorization(tx, {
        userId: user.id,
        email,
        entry,
        actorUserId: admin?.id ?? user.id,
      });
      return 'preauthorized';
    }

    await provisionOwnedWorkspace(tx, {
      userId: user.id,
      email,
      name: 'Personal',
      reason: 'self_signup',
    });
    return 'self_signup';
  });
}
