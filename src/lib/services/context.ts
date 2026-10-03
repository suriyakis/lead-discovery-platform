import type { WorkspaceMemberRole } from '@/lib/db/schema/workspaces';

/**
 * The full set of roles that can act on a workspace.
 *
 * - `owner | admin | manager | member | viewer` come from `workspace_member_role`
 *   and are the per-workspace roles a user holds via `workspace_members`.
 * - `super_admin` is platform-wide and lives on `users.role`. A super admin
 *   can act on any workspace (with audit). They are not in `workspace_members`.
 */
export type WorkspaceRole = WorkspaceMemberRole | 'super_admin';

/** Every role. The client-safe navigation tests loop over it. */
export const WORKSPACE_ROLES = [
  'owner',
  'admin',
  'manager',
  'member',
  'viewer',
  'super_admin',
] as const satisfies ReadonlyArray<WorkspaceRole>;

const ALL_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>(WORKSPACE_ROLES);

/**
 * The runtime context every service function receives as its first argument.
 * There is no global default workspace — services must always know on whose
 * behalf and inside which workspace they are running.
 */
export interface WorkspaceContext {
  /** Tenant boundary. Required on every tenant-scoped operation. */
  workspaceId: bigint;
  /** ID of the user performing the operation (Auth.js text ID). */
  userId: string;
  /** Role of the user inside this workspace, or `super_admin` for platform admins. */
  role: WorkspaceRole;
  /**
   * PC-06: who started the work. Absent = a person, through a request.
   * 'automation' = background work acting as the workspace's accountable
   * owner (makeAutomationContext). The automation gate reads it: the
   * accountable-owner rule applies to automatic work only; holds apply to
   * both.
   */
  trigger?: WorkTrigger;
}

/** See WorkspaceContext.trigger. */
export type WorkTrigger = 'user' | 'automation';

export class WorkspaceContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceContextError';
  }
}

/**
 * Validate raw input and produce a `WorkspaceContext`. Throws if any required
 * field is missing or the wrong type.
 *
 * Use this at the boundary between route handlers and services. Services
 * trust the context they receive — they do not re-validate it.
 */
export function makeWorkspaceContext(input: {
  workspaceId: unknown;
  userId: unknown;
  role: unknown;
}): WorkspaceContext {
  if (typeof input.workspaceId !== 'bigint') {
    throw new WorkspaceContextError('workspaceId is required and must be a bigint');
  }
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    throw new WorkspaceContextError('userId is required and must be a non-empty string');
  }
  if (typeof input.role !== 'string' || !ALL_ROLES.has(input.role as WorkspaceRole)) {
    throw new WorkspaceContextError(
      `role must be one of owner|admin|manager|member|viewer|super_admin, got ${String(input.role)}`,
    );
  }
  return {
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role as WorkspaceRole,
  };
}

/**
 * PC-06: the context background work runs under. Automation acts as the
 * workspace's accountable owner (workspaces.owner_user_id) — never as a
 * fallback member — and is marked as automatic so the gate applies the
 * accountable-owner rule (services/automation-gate.ts).
 */
export function makeAutomationContext(workspaceId: bigint, ownerUserId: string): WorkspaceContext {
  return {
    ...makeWorkspaceContext({ workspaceId, userId: ownerUserId, role: 'owner' }),
    trigger: 'automation',
  };
}

/** True when the work was started by automation rather than a person. */
export function isAutomatic(ctx: Pick<WorkspaceContext, 'trigger'>): boolean {
  return ctx.trigger === 'automation';
}

// ---- role-based authorization helpers ----------------------------------
//
// These are deliberately small. Service functions call them by intent
// (`canWrite`, `canAdminWorkspace`) rather than checking role names inline.
// When the role matrix grows, the change is local.
//
// The role* predicates take a bare role, so code without a context reads
// the same matrix: the navigation (src/lib/nav/resolve.ts) shows or hides
// admin-only entries with them. This module has type imports only, so
// client components can import it.

// Every workspace role, viewer included, may read the workspace's data.
// Spelled out (not ALL_ROLES) so a future role has to be added here on
// purpose before it can read anything.
const READ_ROLES: ReadonlySet<WorkspaceRole> = new Set([
  'owner',
  'admin',
  'manager',
  'member',
  'viewer',
  'super_admin',
]);

const WRITE_ROLES: ReadonlySet<WorkspaceRole> = new Set([
  'owner',
  'admin',
  'manager',
  'member',
  'super_admin',
]);

const ADMIN_ROLES: ReadonlySet<WorkspaceRole> = new Set(['owner', 'admin', 'super_admin']);

const OWNER_ROLES: ReadonlySet<WorkspaceRole> = new Set(['owner', 'super_admin']);

export function roleCanRead(role: WorkspaceRole): boolean {
  return READ_ROLES.has(role);
}

export function roleCanWrite(role: WorkspaceRole): boolean {
  return WRITE_ROLES.has(role);
}

export function roleCanAdminWorkspace(role: WorkspaceRole): boolean {
  return ADMIN_ROLES.has(role);
}

/** True if the role can read tenant data (pages, document downloads). */
export function canRead(ctx: WorkspaceContext): boolean {
  return roleCanRead(ctx.role);
}

/** True if the role can write tenant data (drafts, comments, approvals). */
export function canWrite(ctx: WorkspaceContext): boolean {
  return roleCanWrite(ctx.role);
}

/** True if the role can manage workspace settings, members, and connectors. */
export function canAdminWorkspace(ctx: WorkspaceContext): boolean {
  return roleCanAdminWorkspace(ctx.role);
}

/** True if the role can transfer ownership or delete the workspace. */
export function canOwnWorkspace(ctx: WorkspaceContext): boolean {
  return OWNER_ROLES.has(ctx.role);
}

/** True if the actor is a platform super admin (god-mode). */
export function isSuperAdmin(ctx: WorkspaceContext): boolean {
  return ctx.role === 'super_admin';
}
