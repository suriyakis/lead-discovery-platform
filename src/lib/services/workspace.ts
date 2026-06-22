import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import {
  workspaceMembers,
  workspaceSettings,
  workspaces,
  type NewWorkspace,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceMemberRole,
  type WorkspaceStatus,
} from '@/lib/db/schema/workspaces';
import { isEnabledLanguage } from '@/lib/i18n/language';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, canOwnWorkspace, type WorkspaceContext } from './context';

export class WorkspaceServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'WorkspaceServiceError';
    this.code = code;
  }
}

const permissionDenied = (op: string) =>
  new WorkspaceServiceError(`Permission denied: ${op}`, 'permission_denied');
const notFound = (kind: string) => new WorkspaceServiceError(`${kind} not found`, 'not_found');
const conflict = (msg: string) => new WorkspaceServiceError(msg, 'conflict');
const invariant = (msg: string) => new WorkspaceServiceError(msg, 'invariant_violation');

// ---- creation -----------------------------------------------------------

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  ownerUserId: string;
}

/**
 * Create a fresh workspace and seat its owner as the first member. Also
 * provisions an empty `workspace_settings` row.
 *
 * Not workspace-scoped (the caller doesn't have a workspaceId yet). The
 * authorization gate is "you must be authenticated"; that's enforced at
 * the route handler.
 */
export async function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<{ workspace: Workspace; member: WorkspaceMember }> {
  if (!input.name.trim()) throw conflict('name is required');
  if (!input.slug.trim()) throw conflict('slug is required');

  return db.transaction(async (tx) => {
    // Verify the owner exists. Don't surface the user table in errors.
    const ownerRows = await tx.select().from(users).where(eq(users.id, input.ownerUserId));
    if (!ownerRows[0]) throw notFound('user');

    const newWs: NewWorkspace = {
      name: input.name.trim(),
      slug: input.slug.trim(),
      ownerUserId: input.ownerUserId,
    };
    const insertedWs = await tx.insert(workspaces).values(newWs).returning();
    const ws = insertedWs[0];
    if (!ws) throw invariant('workspace insert returned no row');

    const insertedMember = await tx
      .insert(workspaceMembers)
      .values({
        workspaceId: ws.id,
        userId: input.ownerUserId,
        role: 'owner',
      })
      .returning();
    const member = insertedMember[0];
    if (!member) throw invariant('workspace_members insert returned no row');

    await tx.insert(workspaceSettings).values({ workspaceId: ws.id });

    return { workspace: ws, member };
  });
}

// ---- read --------------------------------------------------------------

export async function getWorkspace(ctx: WorkspaceContext): Promise<Workspace> {
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
  const ws = rows[0];
  if (!ws) throw notFound('workspace');
  return ws;
}

// ---- Phase A: outreach defaults --------------------------------------

export interface UpdateOutreachDefaultsInput {
  autoDraftReplies?: boolean;
  autoSendReplies?: boolean;
}

/** Update workspace-level outreach automation toggles. Workspace-admin
 *  only. autoSendReplies forces autoDraftReplies on (auto-send without
 *  auto-draft is meaningless). */
export async function updateOutreachDefaults(
  ctx: WorkspaceContext,
  input: UpdateOutreachDefaultsInput,
): Promise<Workspace> {
  if (!canAdminWorkspace(ctx)) {
    throw permissionDenied('workspace.update_outreach_defaults');
  }
  const updates: Partial<Workspace> & { updatedAt: Date } = { updatedAt: new Date() };
  if (input.autoDraftReplies !== undefined) {
    updates.autoDraftReplies = input.autoDraftReplies;
  }
  if (input.autoSendReplies !== undefined) {
    updates.autoSendReplies = input.autoSendReplies;
    // Auto-send implies auto-draft (you can't send what wasn't drafted).
    if (input.autoSendReplies) updates.autoDraftReplies = true;
  }
  const [updated] = await db
    .update(workspaces)
    .set(updates)
    .where(eq(workspaces.id, ctx.workspaceId))
    .returning();
  if (!updated) throw notFound('workspace');
  await recordAuditEvent(ctx, {
    kind: 'workspace.update_outreach_defaults',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: {
      autoDraftReplies: updated.autoDraftReplies,
      autoSendReplies: updated.autoSendReplies,
    },
  });
  return updated;
}

// ---- Phase 63: multi-language / translation -------------------------

/**
 * Typed view of the `workspace_settings.settings` jsonb blob. This blob is
 * the home for free-form, migration-free workspace preferences; today it
 * holds the operator's native language, with room to grow.
 */
export interface WorkspaceSettingsData {
  /** Operator's native language (ISO 639-1). Inbound foreign replies are
   *  translated INTO this language, and every outbound email shows its
   *  native-language reference in it. Absent ⇒ 'en'. */
  nativeLanguage?: string;
  /** Workspace default OUTBOUND (communication) language. When set, outreach
   *  is written/sent in this language unless a discovery recipe or a per-lead
   *  override says otherwise. Absent ⇒ fall through the recipe/product
   *  cascade. */
  outreachLanguage?: string;
}

/** Read the workspace settings blob. Returns `{}` when the row or blob is
 *  absent (older workspaces predating a given setting). Not gated — every
 *  member may read workspace preferences. */
export async function getWorkspaceSettings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<WorkspaceSettingsData> {
  const rows = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, ctx.workspaceId))
    .limit(1);
  return (rows[0]?.settings as WorkspaceSettingsData | undefined) ?? {};
}

/** Normalise an ISO tag to its base, lowercased code ('en-GB' → 'en'). */
function baseLang(iso: string): string {
  return iso.toLowerCase().split('-')[0] ?? iso.toLowerCase();
}

/**
 * The workspace's native language — the language inbound replies are
 * translated into and that the reference side of every email is rendered
 * in. Falls back to 'en' when unset or set to something no longer enabled.
 */
export async function getWorkspaceNativeLanguage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<string> {
  const settings = await getWorkspaceSettings(ctx);
  const lang = settings.nativeLanguage;
  return lang && isEnabledLanguage(lang) ? baseLang(lang) : 'en';
}

/**
 * Set the workspace native language. Admin-gated, validated against the
 * curated ENABLED_LANGUAGES set, merged into the settings jsonb (upsert so
 * it works even for a workspace whose settings row was never provisioned),
 * and audit-logged. Returns the normalised code that was stored.
 */
export async function updateWorkspaceNativeLanguage(
  ctx: WorkspaceContext,
  language: string,
): Promise<string> {
  if (!canAdminWorkspace(ctx)) {
    throw permissionDenied('workspace.update_native_language');
  }
  const normalized = baseLang(language ?? '');
  if (!isEnabledLanguage(normalized)) {
    throw new WorkspaceServiceError(
      `unsupported native language: ${language}`,
      'invalid_input',
    );
  }
  const current = await getWorkspaceSettings(ctx);
  const next: WorkspaceSettingsData = { ...current, nativeLanguage: normalized };
  await db
    .insert(workspaceSettings)
    .values({ workspaceId: ctx.workspaceId, settings: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: workspaceSettings.workspaceId,
      set: { settings: next, updatedAt: new Date() },
    });
  await recordAuditEvent(ctx, {
    kind: 'workspace.update_native_language',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: { nativeLanguage: normalized },
  });
  return normalized;
}

/**
 * The workspace default OUTBOUND language, or null when unset (the
 * recipe → product → native cascade decides). Drives the outbound-language
 * cascade just below per-lead and recipe overrides.
 */
export async function getWorkspaceOutreachLanguage(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<string | null> {
  const settings = await getWorkspaceSettings(ctx);
  const lang = settings.outreachLanguage;
  return lang && isEnabledLanguage(lang) ? baseLang(lang) : null;
}

/**
 * Set the workspace default outbound language. Pass '' (or 'auto') to clear
 * it and fall back to the cascade. Admin-gated, validated, audit-logged.
 * Returns the stored code, or null when cleared.
 */
export async function updateWorkspaceOutreachLanguage(
  ctx: WorkspaceContext,
  language: string,
): Promise<string | null> {
  if (!canAdminWorkspace(ctx)) {
    throw permissionDenied('workspace.update_outreach_language');
  }
  const current = await getWorkspaceSettings(ctx);
  const trimmed = (language ?? '').trim().toLowerCase();
  let next: WorkspaceSettingsData;
  let stored: string | null;
  if (trimmed === '' || trimmed === 'auto') {
    const rest = { ...current };
    delete rest.outreachLanguage;
    next = rest;
    stored = null;
  } else {
    const normalized = baseLang(trimmed);
    if (!isEnabledLanguage(normalized)) {
      throw new WorkspaceServiceError(
        `unsupported outreach language: ${language}`,
        'invalid_input',
      );
    }
    next = { ...current, outreachLanguage: normalized };
    stored = normalized;
  }
  await db
    .insert(workspaceSettings)
    .values({ workspaceId: ctx.workspaceId, settings: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: workspaceSettings.workspaceId,
      set: { settings: next, updatedAt: new Date() },
    });
  await recordAuditEvent(ctx, {
    kind: 'workspace.update_outreach_language',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: { outreachLanguage: stored },
  });
  return stored;
}

/** Phase 50: workspace-level cap on bytes uploaded per product to the
 *  active vector-storage provider. Admin-only. Clamped to [1, 4096] MB
 *  so an operator can't accidentally zero the cap or push past OpenAI's
 *  per-file storage budget. */
export async function updateWorkspaceVectorStorageQuota(
  ctx: WorkspaceContext,
  quotaMb: number,
): Promise<Workspace> {
  if (!canAdminWorkspace(ctx)) {
    throw permissionDenied('workspace.update_vector_storage_quota');
  }
  if (!Number.isFinite(quotaMb) || quotaMb < 1 || quotaMb > 4096) {
    throw new WorkspaceServiceError(
      `quotaMb must be in [1, 4096], got ${quotaMb}`,
      'invalid_input',
    );
  }
  const [updated] = await db
    .update(workspaces)
    .set({
      vectorStorageQuotaMbPerProduct: Math.floor(quotaMb),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, ctx.workspaceId))
    .returning();
  if (!updated) throw notFound('workspace');
  await recordAuditEvent(ctx, {
    kind: 'workspace.update_vector_storage_quota',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: { quotaMb: updated.vectorStorageQuotaMbPerProduct },
  });
  return updated;
}

export interface MemberWithUser {
  member: WorkspaceMember;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

export async function listMembers(ctx: WorkspaceContext): Promise<MemberWithUser[]> {
  const rows = await db
    .select({
      member: workspaceMembers,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      },
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, ctx.workspaceId));
  return rows.map((r) => ({ member: r.member, user: r.user }));
}

// ---- mutations ---------------------------------------------------------

export interface AddMemberInput {
  userId: string;
  role: WorkspaceMemberRole;
}

export async function addMember(
  ctx: WorkspaceContext,
  input: AddMemberInput,
): Promise<WorkspaceMember> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('add member');
  if (input.role === 'owner') {
    throw conflict('cannot add a member as owner directly; transfer ownership instead');
  }

  return db.transaction(async (tx) => {
    const userRows = await tx.select().from(users).where(eq(users.id, input.userId));
    if (!userRows[0]) throw notFound('user');

    const existing = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, input.userId),
        ),
      );
    if (existing[0]) throw conflict('user is already a member of this workspace');

    const inserted = await tx
      .insert(workspaceMembers)
      .values({
        workspaceId: ctx.workspaceId,
        userId: input.userId,
        role: input.role,
      })
      .returning();
    const member = inserted[0];
    if (!member) throw invariant('workspace_members insert returned no row');

    await recordAuditEvent(ctx, {
      kind: 'workspace.member.add',
      entityType: 'workspace_member',
      entityId: member.id,
      payload: { addedUserId: input.userId, role: input.role },
    });

    return member;
  });
}

export async function removeMember(ctx: WorkspaceContext, userId: string): Promise<void> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('remove member');

  return db.transaction(async (tx) => {
    const targetRows = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      );
    const target = targetRows[0];
    if (!target) throw notFound('workspace member');
    if (target.role === 'owner') {
      throw conflict('cannot remove the workspace owner; transfer ownership first');
    }

    await tx
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      );

    await recordAuditEvent(ctx, {
      kind: 'workspace.member.remove',
      entityType: 'workspace_member',
      entityId: target.id,
      payload: { removedUserId: userId, formerRole: target.role },
    });
  });
}

export async function setMemberRole(
  ctx: WorkspaceContext,
  userId: string,
  role: WorkspaceMemberRole,
): Promise<WorkspaceMember> {
  if (!canAdminWorkspace(ctx)) throw permissionDenied('set member role');
  // Promoting someone to owner is a separate, ownership-transferring operation
  // (not implemented in Phase 1). Demoting the owner needs canOwnWorkspace.
  if (role === 'owner' && !canOwnWorkspace(ctx)) {
    throw permissionDenied('promote to owner (only owner/super_admin can transfer)');
  }

  return db.transaction(async (tx) => {
    const targetRows = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      );
    const target = targetRows[0];
    if (!target) throw notFound('workspace member');

    // Don't let the last owner be demoted.
    if (target.role === 'owner' && role !== 'owner') {
      const owners = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ctx.workspaceId),
            eq(workspaceMembers.role, 'owner'),
          ),
        );
      if (owners.length <= 1) {
        throw conflict('cannot demote the only owner; assign another owner first');
      }
    }

    const updated = await tx
      .update(workspaceMembers)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .returning();
    const member = updated[0];
    if (!member) throw invariant('workspace_members update returned no row');

    await recordAuditEvent(ctx, {
      kind: 'workspace.member.role_change',
      entityType: 'workspace_member',
      entityId: member.id,
      payload: { userId, previousRole: target.role, newRole: role },
    });

    return member;
  });
}

// ---- Phase 28: active workspace + multi-workspace switching --------

export interface MyWorkspaceRow {
  workspace: {
    id: bigint;
    name: string;
    slug: string;
    status: WorkspaceStatus;
    isDefault: boolean;
  };
  /** Workspace role when the user is a member; 'super_admin' for god-mode rows. */
  role: WorkspaceMemberRole | 'super_admin';
  isActive: boolean;
  /**
   * Phase 29: true when the row exists because the caller is super_admin
   * and this workspace is NOT one they're a member of. False for genuine
   * memberships. Used by the UI to put god-mode workspaces in their
   * own optgroup.
   */
  isGodMode: boolean;
}

/**
 * List every workspace the user belongs to, marking which one is currently
 * active. Used by the header switcher dropdown.
 *
 * When `includeAllForSuperAdmin: true`, the result also contains every
 * other workspace on the platform with `role='super_admin'` and
 * `isGodMode=true`. The caller must actually be a super-admin — this
 * function does not check; it just opts in to the wider listing.
 */
export async function listMyWorkspaces(
  userId: string,
  options: { includeAllForSuperAdmin?: boolean } = {},
): Promise<MyWorkspaceRow[]> {
  const userRows = await db
    .select({ activeWorkspaceId: users.activeWorkspaceId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const activeId = userRows[0]?.activeWorkspaceId ?? null;

  const memberRows = await db
    .select({
      workspace: {
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        status: workspaces.status,
        isDefault: workspaces.isDefault,
      },
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.name));

  const memberships: MyWorkspaceRow[] = memberRows.map((r) => ({
    workspace: r.workspace,
    role: r.role as WorkspaceMemberRole,
    isActive: activeId !== null && r.workspace.id === activeId,
    isGodMode: false,
  }));

  if (!options.includeAllForSuperAdmin) return memberships;

  const memberIds = new Set(memberships.map((m) => m.workspace.id.toString()));
  const allOthers = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      status: workspaces.status,
      isDefault: workspaces.isDefault,
    })
    .from(workspaces)
    .orderBy(asc(workspaces.name));

  const godModeRows: MyWorkspaceRow[] = allOthers
    .filter((w) => !memberIds.has(w.id.toString()))
    .map((w) => ({
      workspace: w,
      role: 'super_admin' as const,
      isActive: activeId !== null && w.id === activeId,
      isGodMode: true,
    }));

  return [...memberships, ...godModeRows];
}

/**
 * Switch the user's active workspace. Verifies the user is actually a
 * member; super_admin can pass `allowAnyAsSuperAdmin` to bypass the check
 * (god-mode can land anywhere). Returns the resolved workspace.
 *
 * Every god-mode switch into a non-member workspace is audit-logged into
 * the target workspace so the trail is visible from /admin/audit and
 * /settings/audit.
 */
export async function setActiveWorkspace(
  userId: string,
  workspaceId: bigint,
  options: { allowAnyAsSuperAdmin?: boolean } = {},
): Promise<Workspace> {
  const wsRows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!wsRows[0]) throw notFound('workspace');

  // Verify membership unless caller has explicitly opted into super-admin
  // bypass. Track whether this counts as a god-mode switch for audit.
  const member = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  const isMember = Boolean(member[0]);
  if (!isMember) {
    if (!options.allowAnyAsSuperAdmin) {
      throw new WorkspaceServiceError(
        'not a member of that workspace',
        'permission_denied',
      );
    }
  }

  await db
    .update(users)
    .set({ activeWorkspaceId: workspaceId })
    .where(eq(users.id, userId));

  if (!isMember && options.allowAnyAsSuperAdmin) {
    // God-mode switch — log it under the TARGET workspace so anyone
    // reviewing that workspace's audit can see the super-admin entered.
    await recordAuditEvent(
      { workspaceId, userId },
      {
        kind: 'workspace.god_mode_switch',
        entityType: 'workspace',
        entityId: workspaceId,
        payload: { actorUserId: userId },
      },
    );
  }

  return wsRows[0];
}

/**
 * Clear users.activeWorkspaceId on every user pointing at the given
 * workspace. Used when a workspace is deleted or a member is removed
 * from it — without this, getWorkspaceContext would resolve to a stale
 * workspace they can no longer access.
 */
export async function clearActiveWorkspaceForUsers(
  workspaceId: bigint,
): Promise<void> {
  await db
    .update(users)
    .set({ activeWorkspaceId: null })
    .where(eq(users.activeWorkspaceId, workspaceId));
}
