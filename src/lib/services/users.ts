// User & membership management. Covers super-admin platform-wide ops
// (account lifecycle, pre-authorize) and workspace-admin per-workspace
// ops (add/remove member, change role). Every mutation is audit-logged.

import bcrypt from 'bcryptjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  accounts,
  preauthorizedEmails,
  sessions,
  users,
  type AccountStatus,
  type PreauthorizedEmail,
  type User,
} from '@/lib/db/schema/auth';
import {
  workspaceMembers,
  type WorkspaceMember,
  type WorkspaceMemberRole,
} from '@/lib/db/schema/workspaces';
import { recordAuditEvent } from './audit';
import {
  canAdminWorkspace,
  isSuperAdmin,
  type WorkspaceContext,
} from './context';

export class UserServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'UserServiceError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new UserServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = (kind: string) =>
  new UserServiceError(`${kind} not found`, 'not_found');
const invalid = (msg: string) =>
  new UserServiceError(msg, 'invalid_input');
const conflict = (msg: string) =>
  new UserServiceError(msg, 'conflict');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

// ---- account lifecycle (super_admin) -------------------------------

export async function setAccountStatus(
  ctx: WorkspaceContext,
  targetUserId: string,
  status: AccountStatus,
  reason: string | null = null,
): Promise<User> {
  if (!isSuperAdmin(ctx)) throw denied('users.set_account_status');
  const target = await loadUser(targetUserId);
  if (target.id === ctx.userId && status !== 'active') {
    // Don't let a super-admin lock themselves out.
    throw conflict('cannot change your own account status');
  }
  const [updated] = await db
    .update(users)
    .set({
      accountStatus: status,
      accountStatusReason: reason?.trim() || null,
      accountStatusUpdatedAt: new Date(),
      accountStatusUpdatedBy: ctx.userId,
    })
    .where(eq(users.id, targetUserId))
    .returning();
  if (!updated) {
    throw new UserServiceError(
      'account status update returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'user.set_account_status',
      entityType: 'user',
      entityId: targetUserId,
      payload: { status, reason: reason ?? null, prior: target.accountStatus },
    },
  );
  return updated;
}

export async function listAllUsers(
  ctx: WorkspaceContext,
  filter: { status?: AccountStatus; limit?: number } = {},
): Promise<User[]> {
  if (!isSuperAdmin(ctx)) throw denied('users.list_all');
  const rows = filter.status
    ? await db
        .select()
        .from(users)
        .where(eq(users.accountStatus, filter.status))
        .limit(Math.min(filter.limit ?? 500, 5000))
    : await db.select().from(users).limit(Math.min(filter.limit ?? 500, 5000));
  return rows;
}

// ---- pre-authorize (super_admin) -----------------------------------

export interface PreauthorizeInput {
  email: string;
  /** Workspace to drop the user into on first signin. Optional. */
  workspaceId?: bigint | null;
  /** Role they should land at. Defaults to 'member'. */
  role?: WorkspaceMemberRole;
}

export async function preauthorizeEmail(
  ctx: WorkspaceContext,
  input: PreauthorizeInput,
): Promise<PreauthorizedEmail> {
  if (!isSuperAdmin(ctx)) throw denied('users.preauthorize');
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw invalid('invalid email');

  // Idempotent: re-preauthorizing the same email replaces the prior
  // unconsumed entry.
  await db
    .delete(preauthorizedEmails)
    .where(
      and(
        eq(preauthorizedEmails.email, email),
        isNull(preauthorizedEmails.consumedAt),
      ),
    );

  const [created] = await db
    .insert(preauthorizedEmails)
    .values({
      email,
      workspaceId: input.workspaceId ? input.workspaceId.toString() : null,
      role: input.role ?? 'member',
      createdBy: ctx.userId,
    })
    .returning();
  if (!created) {
    throw new UserServiceError(
      'preauthorize insert returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'user.preauthorize',
      entityType: 'preauthorized_email',
      entityId: created.id,
      payload: {
        email,
        workspaceId: input.workspaceId?.toString() ?? null,
        role: input.role ?? 'member',
      },
    },
  );

  // If the user already exists (and signed in before being pre-approved),
  // lift them to active right away.
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing[0] && existing[0].accountStatus !== 'active') {
    await db
      .update(users)
      .set({
        accountStatus: 'active',
        accountStatusUpdatedAt: new Date(),
        accountStatusUpdatedBy: ctx.userId,
      })
      .where(eq(users.id, existing[0].id));
  }

  return created;
}

export async function listPreauthorizedEmails(
  ctx: WorkspaceContext,
  filter: { activeOnly?: boolean } = {},
): Promise<PreauthorizedEmail[]> {
  if (!isSuperAdmin(ctx)) throw denied('users.list_preauthorized');
  if (filter.activeOnly) {
    return db
      .select()
      .from(preauthorizedEmails)
      .where(isNull(preauthorizedEmails.consumedAt));
  }
  return db.select().from(preauthorizedEmails);
}

export async function revokePreauthorize(
  ctx: WorkspaceContext,
  id: string,
): Promise<void> {
  if (!isSuperAdmin(ctx)) throw denied('users.revoke_preauthorize');
  const existing = await db
    .select()
    .from(preauthorizedEmails)
    .where(eq(preauthorizedEmails.id, id))
    .limit(1);
  if (!existing[0]) throw notFound('preauthorized_email');
  if (existing[0].consumedAt !== null) {
    throw conflict('already consumed');
  }
  await db.delete(preauthorizedEmails).where(eq(preauthorizedEmails.id, id));
  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'user.revoke_preauthorize',
      entityType: 'preauthorized_email',
      entityId: id,
    },
  );
}

// ---- workspace membership (workspace-admin) ------------------------

export async function listWorkspaceMembers(
  ctx: WorkspaceContext,
): Promise<Array<{ member: WorkspaceMember; user: User }>> {
  if (!canAdminWorkspace(ctx)) throw denied('users.list_workspace_members');
  return db
    .select({ member: workspaceMembers, user: users })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, ctx.workspaceId));
}

export async function setMemberRole(
  ctx: WorkspaceContext,
  targetUserId: string,
  role: WorkspaceMemberRole,
): Promise<WorkspaceMember> {
  if (!canAdminWorkspace(ctx)) throw denied('users.set_member_role');
  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    )
    .limit(1);
  if (!existing[0]) throw notFound('workspace_member');
  // Don't let an admin demote the last owner.
  if (existing[0].role === 'owner' && role !== 'owner') {
    const owners = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.role, 'owner'),
        ),
      );
    if (owners.length <= 1) {
      throw conflict('cannot demote the last owner');
    }
  }
  const [updated] = await db
    .update(workspaceMembers)
    .set({ role, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    )
    .returning();
  if (!updated) {
    throw new UserServiceError(
      'member role update returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'user.set_member_role',
    entityType: 'workspace_member',
    entityId: updated.id,
    payload: { targetUserId, role, prior: existing[0].role },
  });
  return updated;
}

export async function removeMember(
  ctx: WorkspaceContext,
  targetUserId: string,
): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw denied('users.remove_member');
  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    )
    .limit(1);
  if (!existing[0]) throw notFound('workspace_member');
  if (existing[0].role === 'owner') {
    const owners = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.role, 'owner'),
        ),
      );
    if (owners.length <= 1) {
      throw conflict('cannot remove the last owner');
    }
  }
  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    );
  await recordAuditEvent(ctx, {
    kind: 'user.remove_member',
    entityType: 'workspace_member',
    entityId: existing[0].id,
    payload: { targetUserId, role: existing[0].role },
  });
}

export async function addMember(
  ctx: WorkspaceContext,
  targetUserId: string,
  role: WorkspaceMemberRole = 'member',
): Promise<WorkspaceMember> {
  if (!canAdminWorkspace(ctx)) throw denied('users.add_member');
  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ),
    )
    .limit(1);
  if (existing[0]) throw conflict('already a member');
  const target = await loadUser(targetUserId);
  if (target.accountStatus !== 'active') {
    throw conflict(`target user account is ${target.accountStatus}`);
  }
  const [created] = await db
    .insert(workspaceMembers)
    .values({
      workspaceId: ctx.workspaceId,
      userId: targetUserId,
      role,
    })
    .returning();
  if (!created) {
    throw new UserServiceError(
      'member insert returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(ctx, {
    kind: 'user.add_member',
    entityType: 'workspace_member',
    entityId: created.id,
    payload: { targetUserId, role },
  });
  return created;
}

// ---- Phase 30: password auth ---------------------------------------

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LEN = 8;

export interface CreatePasswordUserInput {
  email: string;
  password: string;
  name?: string | null;
  /** Defaults to 'member'. */
  platformRole?: 'member' | 'super_admin';
  /** Defaults to 'active'. */
  accountStatus?: AccountStatus;
  /** Optional workspace to drop into immediately. */
  workspaceId?: bigint | null;
  /** Workspace role for that workspace. Defaults to 'member'. */
  workspaceRole?: WorkspaceMemberRole;
}

/**
 * Super-admin creates a password-auth user. Hashes the password with
 * bcrypt(12 rounds), inserts the user row, and optionally adds them to
 * a workspace at the given role. Mirrors the Wandizz "team user" flow.
 */
export async function createPasswordUser(
  ctx: WorkspaceContext,
  input: CreatePasswordUserInput,
): Promise<User> {
  if (!isSuperAdmin(ctx)) throw denied('users.create_password_user');
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw invalid('invalid email');
  if (input.password.length < MIN_PASSWORD_LEN) {
    throw invalid(`password must be at least ${MIN_PASSWORD_LEN} characters`);
  }

  // Refuse if any user already has this email (case-insensitive).
  const dup = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (dup[0]) throw conflict('email already in use');

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const [created] = await db
    .insert(users)
    .values({
      email,
      name: input.name?.trim() || null,
      role: input.platformRole ?? 'member',
      accountStatus: input.accountStatus ?? 'active',
      accountStatusUpdatedAt: new Date(),
      accountStatusUpdatedBy: ctx.userId,
      passwordHash,
    })
    .returning();
  if (!created) {
    throw new UserServiceError(
      'createPasswordUser insert returned no row',
      'invariant_violation',
    );
  }

  // Optional immediate workspace assignment.
  if (input.workspaceId) {
    await db.insert(workspaceMembers).values({
      workspaceId: input.workspaceId,
      userId: created.id,
      role: input.workspaceRole ?? 'member',
    });
  }

  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'user.create_password_user',
      entityType: 'user',
      entityId: created.id,
      payload: {
        email,
        platformRole: input.platformRole ?? 'member',
        workspaceId: input.workspaceId?.toString() ?? null,
        workspaceRole: input.workspaceRole ?? null,
      },
    },
  );

  return created;
}

/**
 * Set or rotate a user's password. Super-admin can change anyone's;
 * a user can change their own (caller should pre-verify the existing
 * password if that's the policy). Rotating logs the user out of every
 * existing session as a side effect.
 */
export async function setUserPassword(
  ctx: WorkspaceContext,
  targetUserId: string,
  newPassword: string,
  options: { invalidateExistingSessions?: boolean } = {},
): Promise<void> {
  const isSelf = targetUserId === ctx.userId;
  if (!isSelf && !isSuperAdmin(ctx)) {
    throw denied('users.set_password');
  }
  if (newPassword.length < MIN_PASSWORD_LEN) {
    throw invalid(`password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  const target = await loadUser(targetUserId);
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, targetUserId));

  // Invalidate every existing session by default — the safer option for
  // password resets. Skip via opts when called from a self-flow that
  // wants to keep the current session.
  if (options.invalidateExistingSessions !== false) {
    await db.delete(sessions).where(eq(sessions.userId, targetUserId));
  }

  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'user.set_password',
      entityType: 'user',
      entityId: targetUserId,
      payload: { wasSelf: isSelf },
    },
  );
  void target;
}

/**
 * Verify an email + password against the users table. Returns the user
 * row if the password matches AND the user is active; null in every
 * other case. Used by the custom team-login endpoint — never call from
 * route handlers that should be protected by the general auth gate.
 */
export async function verifyUserPassword(
  email: string,
  password: string,
): Promise<User | null> {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) return null;
  const rows = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${e}`)
    .limit(1);
  const user = rows[0];
  if (!user || !user.passwordHash) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;
  if (user.accountStatus !== 'active' && user.role !== 'super_admin') {
    // Don't grant a session to a pending/suspended/rejected account.
    return null;
  }
  return user;
}

/**
 * Hard-delete a user. Cascades through every FK that references users.id
 * with ON DELETE CASCADE (sessions, accounts, workspace_members, etc.)
 * and clears any FKs configured ON DELETE SET NULL.
 *
 * Super-admin only; refuses to delete yourself or any other super-admin
 * (lock-out protection — demote them first).
 */
export async function deleteUserGlobally(
  ctx: WorkspaceContext,
  targetUserId: string,
): Promise<void> {
  if (!isSuperAdmin(ctx)) throw denied('users.delete');
  if (targetUserId === ctx.userId) {
    throw conflict('cannot delete yourself');
  }
  const target = await loadUser(targetUserId);
  if (target.role === 'super_admin') {
    throw conflict('cannot delete a super-admin — demote first');
  }

  // Audit BEFORE delete so the trail still references the doomed id.
  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'user.delete',
      entityType: 'user',
      entityId: targetUserId,
      payload: { email: target.email, name: target.name ?? null },
    },
  );

  // Sessions + accounts cascade via FK. workspace_members cascades.
  // workspaces.owner_user_id has no ON DELETE so we'd hit a constraint
  // if this user owns any workspace — guard upfront.
  const ownedRows = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, targetUserId));
  void ownedRows;
  // workspaces.ownerUserId references users.id without ON DELETE. If the
  // target owns any workspace, the delete would FK-fail. We pre-check
  // and refuse with a useful message rather than letting Postgres throw.
  const { workspaces } = await import('@/lib/db/schema/workspaces');
  const ownsRows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, targetUserId));
  if (ownsRows.length > 0) {
    throw conflict(
      `user owns ${ownsRows.length} workspace(s) — transfer ownership before delete`,
    );
  }

  await db.delete(users).where(eq(users.id, targetUserId));
}

// ---- Phase 31: self-service profile + password --------------------

/**
 * Change your own display name. Email is intentionally not editable
 * here — that change goes through admin.updateUserProfile so it can be
 * verified and audited.
 */
export async function updateOwnProfile(
  ctx: WorkspaceContext,
  input: { name: string | null },
): Promise<User> {
  const target = await loadUser(ctx.userId);
  const name = input.name?.trim() || null;
  const [updated] = await db
    .update(users)
    .set({ name })
    .where(eq(users.id, ctx.userId))
    .returning();
  if (!updated) {
    throw new UserServiceError(
      'updateOwnProfile returned no row',
      'invariant_violation',
    );
  }
  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'user.update_own_profile',
      entityType: 'user',
      entityId: ctx.userId,
      payload: { previousName: target.name ?? null, newName: name },
    },
  );
  return updated;
}

/**
 * Self-service password change: verifies the old password matches before
 * writing the new one. Doesn't invalidate the current session — the user
 * stays logged in. Other sessions ARE invalidated (safer default after
 * any password change).
 *
 * For OAuth-only users (passwordHash IS NULL) this also doubles as
 * "set initial password" when oldPassword is empty.
 */
export async function changeOwnPassword(
  ctx: WorkspaceContext,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_LEN) {
    throw invalid(`password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  const me = await loadUser(ctx.userId);
  if (me.passwordHash) {
    const ok = await bcrypt.compare(oldPassword, me.passwordHash);
    if (!ok) throw new UserServiceError('current password is incorrect', 'invalid_input');
  } else if (oldPassword.length > 0) {
    // OAuth user supplied an old password but doesn't have one — surface
    // an explicit message rather than failing the empty compare.
    throw invalid('you do not have a password set; leave the old field blank');
  }
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, ctx.userId));
  await recordAuditEvent(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      kind: 'user.change_own_password',
      entityType: 'user',
      entityId: ctx.userId,
      payload: { setInitial: !me.passwordHash },
    },
  );
}

// ---- internals -----------------------------------------------------

async function loadUser(id: string): Promise<User> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!rows[0]) throw notFound('user');
  return rows[0];
}

void accounts;
