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
import { canAdminWorkspace, canOwnWorkspace, isSuperAdmin, type WorkspaceContext } from './context';
import { NoWorkspaceError, resolveWorkspaceContextForUser } from './workspace-resolution';

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

export interface ActiveWorkspaceSummary {
  workspace: Workspace;
  /** The caller's own membership role, or null when a super-admin is
   *  inside a workspace they are not a member of (god mode). */
  memberRole: WorkspaceMemberRole | null;
  /** True when the caller is in this workspace through god mode. */
  isGodMode: boolean;
  /** How many workspaces the caller belongs to, counted the way the
   *  switcher lists them (archived ones only for super-admins). */
  membershipCount: number;
}

/**
 * What the dashboard's "Active workspace" card shows: the workspace the
 * context resolved to, the caller's role in it, and their membership
 * count. Reading it from the resolved context (not a separate membership
 * lookup) keeps the card on the same tenant as the rest of the app.
 */
export async function getActiveWorkspaceSummary(
  ctx: WorkspaceContext,
): Promise<ActiveWorkspaceSummary> {
  const workspace = await getWorkspace(ctx);
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
        eq(workspaceMembers.userId, ctx.userId),
      ),
    )
    .limit(1);
  const memberships = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      isSuperAdmin(ctx)
        ? eq(workspaceMembers.userId, ctx.userId)
        : and(eq(workspaceMembers.userId, ctx.userId), eq(workspaces.status, 'active')),
    );
  return {
    workspace,
    memberRole: member?.role ?? null,
    isGodMode: !member && isSuperAdmin(ctx),
    membershipCount: memberships.length,
  };
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
  /** KL-02: whether classified replies may teach the learning layer
   *  (learnFromReplyOutcome). Absent ⇒ off. An owner switch; reply classes
   *  are still keyword guesses (I088), so it stays off until KL-15 adds the
   *  outbound-thread and classifier-version gates. */
  learnFromReplies?: boolean;
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

/** KL-02: may reply outcomes teach? Default off (absent or not `true`). */
export async function getLearnFromReplies(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<boolean> {
  const settings = await getWorkspaceSettings(ctx);
  return settings.learnFromReplies === true;
}

/** KL-02: switch reply learning on or off. Owner-only, audit-logged. */
export async function updateLearnFromReplies(
  ctx: WorkspaceContext,
  enabled: boolean,
): Promise<boolean> {
  if (!canOwnWorkspace(ctx)) {
    throw permissionDenied('workspace.update_learn_from_replies');
  }
  const current = await getWorkspaceSettings(ctx);
  const next: WorkspaceSettingsData = { ...current, learnFromReplies: enabled === true };
  await db
    .insert(workspaceSettings)
    .values({ workspaceId: ctx.workspaceId, settings: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: workspaceSettings.workspaceId,
      set: { settings: next, updatedAt: new Date() },
    });
  await recordAuditEvent(ctx, {
    kind: 'workspace.update_learn_from_replies',
    entityType: 'workspace',
    entityId: ctx.workspaceId,
    payload: { learnFromReplies: enabled === true },
  });
  return enabled === true;
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

// Member mutations (add, remove, change role) live only in users.ts,
// the single guarded implementation behind /settings/members. The
// weaker copies that used to sit here were removed (audit I043,
// deliverable ia:F-04).

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
 * List every workspace the user can switch to, marking the one their
 * requests actually operate in. Used by the header switcher dropdown and
 * the account page.
 *
 * - Archived workspaces are left out for normal users: the resolver
 *   ignores them, so listing one only let the switcher show a workspace
 *   as current while every page read another (audit I174). Super-admins
 *   still see them, so the restore action stays reachable.
 * - `isActive` marks the workspace resolveWorkspaceContextForUser picks
 *   (including its oldest-membership fallback and the god-mode branch),
 *   not the raw users.activeWorkspaceId pointer, so the switcher always
 *   names the workspace the dashboard and every other page show.
 *
 * When `includeAllForSuperAdmin: true` and the user really is a
 * super-admin (checked against users.role), the result also contains
 * every other workspace on the platform with `role='super_admin'` and
 * `isGodMode=true`. The flag is ignored for everyone else.
 */
export async function listMyWorkspaces(
  userId: string,
  options: { includeAllForSuperAdmin?: boolean } = {},
): Promise<MyWorkspaceRow[]> {
  const userRows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const isSuperAdminUser = userRows[0]?.role === 'super_admin';

  let activeId: bigint | null = null;
  try {
    const resolved = await resolveWorkspaceContextForUser(userId, isSuperAdminUser);
    activeId = resolved.workspaceId;
  } catch (err) {
    if (!(err instanceof NoWorkspaceError)) throw err;
  }

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
    .where(
      isSuperAdminUser
        ? eq(workspaceMembers.userId, userId)
        : and(eq(workspaceMembers.userId, userId), eq(workspaces.status, 'active')),
    )
    .orderBy(asc(workspaces.name));

  const memberships: MyWorkspaceRow[] = memberRows.map((r) => ({
    workspace: r.workspace,
    role: r.role as WorkspaceMemberRole,
    isActive: activeId !== null && r.workspace.id === activeId,
    isGodMode: false,
  }));

  if (!options.includeAllForSuperAdmin || !isSuperAdminUser) return memberships;

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
 * An archived workspace is refused unless `allowAnyAsSuperAdmin` is set:
 * the resolver ignores archived workspaces for normal users, so accepting
 * the pointer made the switcher claim a workspace the pages never showed
 * (audit I174). Super-admins may still enter one to inspect or restore it.
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
  if (wsRows[0].status !== 'active' && !options.allowAnyAsSuperAdmin) {
    throw new WorkspaceServiceError(
      'that workspace is archived',
      'workspace_archived',
    );
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
