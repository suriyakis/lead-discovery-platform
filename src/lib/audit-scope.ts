// Where an audit row is filed, as the super-admin console shows it (PC-03).
//
// audit_log.workspace_id is NULL for two different reasons:
//   1. platform-scope events: recordPlatformAuditEvent() and the
//      remediation scripts (the PC-03 refile, the F-06 mail repair's
//      auditInTx) write them with no workspace on purpose (users,
//      pre-authorisations, platform roles, keys, settings, background
//      jobs, remediation runs);
//   2. tenant events whose workspace was deleted later: the FK is
//      ON DELETE SET NULL, so those rows survive but lose their pointer
//      (see admin.deleteWorkspace, which files an admin.workspace.delete
//      row with the workspace's name and slug first).
// The two are told apart by kind. Every kind written at platform scope
// must be listed here; src/tests/admin-console-static.test.ts fails when
// a recordPlatformAuditEvent() call, or any object literal with
// `workspaceId: null` and a literal `kind` (an insert(auditLog) row, an
// auditInTx() event, a seeded row), uses a kind that is missing. Keep the
// list append-only: rows of a kind the code no longer writes still exist
// and must keep reading as platform events.
//
// Pure module (no DB), so pages, services and tests can share it.

export const PLATFORM_AUDIT_KINDS = [
  // Users, pre-authorisations, platform roles (services/users.ts, admin.ts)
  'user.set_account_status',
  'user.preauthorize',
  'user.revoke_preauthorize',
  'user.create_password_user',
  'user.set_platform_role',
  'user.set_password',
  'user.delete',
  'admin.user.update_profile',
  // Workspace lifecycle at platform level (admin.deleteWorkspace)
  'admin.workspace.delete',
  // Platform keys and settings (services/secrets.ts, platform-settings.ts)
  'platform_secret.set',
  'platform_secret.delete',
  'platform_settings.update',
  // Background jobs with no single workspace
  'knowledge.compaction.run',
  'knowledge.compaction.retire_stale',
  'knowledge.compaction.merge',
  'learning.synthesis.run',
  'learning.lesson.reinforce',
  // PC-03 remediation runs (src/lib/remediation/refile-platform-audit.ts)
  'admin.audit.refile',
  'admin.audit.refile_revert',
  // flow:F-06 mail remediation runs: the platform-scope row of each
  // --apply category and of each --revert (scripts/remediation/lib/
  // engine.ts auditInTx). Their per-workspace summary rows of the same
  // kinds carry a workspace and read as workspace rows.
  'remediation.apply',
  'remediation.revert',
  // PC-06: the platform-wide outbound stop (services/holds.ts) and the
  // summary row of the legacy feature_flags import
  // (src/lib/remediation/legacy-feature-flags.ts; its per-workspace
  // workspace.hold.import rows carry their workspace).
  'platform.outbound_stop.set',
  'platform.outbound_stop.clear',
  'admin.legacy_flags.import',
  // PC-08: 'Send test alert' in the platform console (services/ops-alerts.ts)
  'ops.alert.test',
  // PC-35: a daily retention run that deleted log rows (services/retention.ts)
  'ops.retention.run',
] as const;

export type PlatformAuditKind = (typeof PLATFORM_AUDIT_KINDS)[number];

const PLATFORM_KIND_SET: ReadonlySet<string> = new Set(PLATFORM_AUDIT_KINDS);

export function isPlatformAuditKind(kind: string): kind is PlatformAuditKind {
  return PLATFORM_KIND_SET.has(kind);
}

/**
 * Narrows rows with no workspace:
 *   platform          — a platform-scope event (kind in PLATFORM_AUDIT_KINDS)
 *   deleted_workspace — any other kind: a tenant row whose workspace was
 *                       deleted
 */
export type NoWorkspaceOrigin = 'platform' | 'deleted_workspace';

export type AuditRowOrigin = 'workspace' | NoWorkspaceOrigin;

export function auditRowOrigin(row: { workspaceId: bigint | null; kind: string }): AuditRowOrigin {
  if (row.workspaceId !== null) return 'workspace';
  return isPlatformAuditKind(row.kind) ? 'platform' : 'deleted_workspace';
}

/**
 * Short label for a row's filing place in console lists:
 * `ws:<name>` (or `ws:<id>` when the name is unknown), `platform`, or
 * `no workspace` for a row orphaned by a workspace delete.
 */
export function auditRowScopeLabel(
  row: { workspaceId: bigint | null; kind: string },
  workspaceName?: string | null,
): string {
  const origin = auditRowOrigin(row);
  if (origin === 'platform') return 'platform';
  if (origin === 'deleted_workspace') return 'no workspace';
  return `ws:${workspaceName ?? row.workspaceId!.toString()}`;
}

/** Tooltip for the label above; null when the label says it all. */
export function auditRowScopeHint(row: {
  workspaceId: bigint | null;
  kind: string;
}): string | null {
  const origin = auditRowOrigin(row);
  if (origin === 'platform') return 'Platform-level event: filed in no workspace on purpose.';
  if (origin === 'deleted_workspace') {
    return 'Its workspace was deleted. Audit rows outlive their workspace; the admin.workspace.delete row names it.';
  }
  return null;
}
