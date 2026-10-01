// Platform (super-admin console) context.
//
// A super-admin working in /admin acts on the PLATFORM, not inside a
// tenant. The old console resolved a WorkspaceContext for every action,
// so audit rows were filed into whatever workspace the admin's switcher
// happened to point at — in god mode, a tenant the admin is not even a
// member of, whose own admins then read another customer's name and email
// on /settings/audit (I051).
//
// PlatformContext deliberately carries NO workspace. Platform services
// take it first, plus an explicit target workspace id wherever they touch
// a tenant, and audit either at platform scope (workspace_id NULL) or
// against that explicit target — never against an ambient workspace.
//
// Minting: requirePlatformAdmin() / getPlatformContext() in
// auth-context.ts derive it from the signed-in session (database
// sessions, so the role is read fresh on every request). Tests and
// scripts use makePlatformContext().

export interface PlatformContext {
  /** Discriminant: lets platform services reject a WorkspaceContext at runtime. */
  readonly scope: 'platform';
  /** The super-admin performing the operation (Auth.js user id). */
  readonly actorUserId: string;
}

export class PlatformContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformContextError';
  }
}

/** Build a PlatformContext. The caller is responsible for having verified
 *  that `actorUserId` is a platform super-admin (the session layer does). */
export function makePlatformContext(actorUserId: unknown): PlatformContext {
  if (typeof actorUserId !== 'string' || actorUserId.length === 0) {
    throw new PlatformContextError('actorUserId is required and must be a non-empty string');
  }
  return Object.freeze({ scope: 'platform', actorUserId });
}

/** Runtime guard used by every platform service before doing anything.
 *  A WorkspaceContext (even one with role super_admin) is NOT a
 *  PlatformContext — that confusion is exactly what misfiled the audit. */
export function isPlatformContext(value: unknown): value is PlatformContext {
  if (!value || typeof value !== 'object') return false;
  const v = value as { scope?: unknown; actorUserId?: unknown; workspaceId?: unknown };
  return (
    v.scope === 'platform' &&
    typeof v.actorUserId === 'string' &&
    v.actorUserId.length > 0 &&
    v.workspaceId === undefined
  );
}
