// Confirm-dialog copy for the one-click high-impact actions (DS-04).
//
// Every message names the workspace, user or product it acts on and says
// what happens next, so a misclick on the wrong row is caught before the
// request leaves the browser. A workspace is named by name AND slug
// (workspaceLabel): names are not unique — every self-signup workspace is
// called "Personal" — so the name alone would not catch the wrong row.
// Pure and browser-safe: server pages build the static messages,
// ConfirmTokenAdjustButton builds the token one from what the operator
// typed.

const numberFormat = new Intl.NumberFormat('en-US');

/** 1234567n → "1,234,567". */
export function formatTokens(value: bigint): string {
  return numberFormat.format(value);
}

/**
 * The token delta a grant form will submit, or null when the server
 * would reject it anyway (empty, zero, fractional, not a number). Mirrors
 * the Number()/isInteger check in the grant server actions.
 */
export function parseTokenDelta(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n === 0) return null;
  return BigInt(n);
}

/** A workspace as the confirms name it. */
export interface WorkspaceRef {
  name: string;
  /** Unique; shown next to the name. Omit only where it is not loaded. */
  slug?: string | null;
}

/**
 * `Personal (personal-1a2b3c4d)`, or `"Personal" (personal-1a2b3c4d)`
 * with `quoted`. The slug is left out when it is missing or equals the
 * name.
 */
export function workspaceLabel(ws: WorkspaceRef, opts: { quoted?: boolean } = {}): string {
  const name = opts.quoted ? `"${ws.name}"` : ws.name;
  const slug = ws.slug?.trim();
  return slug && slug !== ws.name ? `${name} (${slug})` : name;
}

function parseBalance(raw: string | null | undefined): bigint | null {
  if (raw === null || raw === undefined || !/^-?\d+$/.test(raw.trim())) return null;
  return BigInt(raw.trim());
}

/**
 * Confirm text for a token grant or deduction:
 *
 *   +1,000 tokens to Acme Ltd (acme-ltd)
 *   Balance: 5,000 → 6,000 tokens.
 *
 * Returns null when the typed amount is not a valid adjustment — the
 * form then submits without a dialog and the server flashes the error.
 */
export function tokenAdjustmentConfirm(input: {
  raw: string;
  workspaceName: string;
  workspaceSlug?: string | null;
  /** Current balance as a decimal string. */
  balance?: string | null;
  billingExempt?: boolean;
  reason?: string;
}): string | null {
  const delta = parseTokenDelta(input.raw);
  if (delta === null) return null;
  const ws = workspaceLabel({ name: input.workspaceName, slug: input.workspaceSlug });
  const lines = [
    delta > 0n
      ? `+${formatTokens(delta)} tokens to ${ws}`
      : `-${formatTokens(-delta)} tokens from ${ws}`,
  ];
  const balance = parseBalance(input.balance);
  if (balance !== null) {
    const after = balance + delta;
    lines.push(`Balance: ${formatTokens(balance)} → ${formatTokens(after)} tokens.`);
    if (!input.billingExempt && after <= 0n) {
      lines.push(
        'At zero or below, metered work in this workspace (discovery, qualification, drafting) pauses until tokens are added.',
      );
    }
  }
  const reason = input.reason?.trim();
  if (reason) lines.push(`Reason: ${reason}`);
  lines.push('', 'Apply this adjustment?');
  return lines.join('\n');
}

/** "Its 1 member loses access …" / "Its 3 members lose access …". */
function membersAccess(n: number, oneVerb: string, manyVerb: string, rest: string): string {
  if (n === 0) return 'It has no members yet.';
  return n === 1 ? `Its 1 member ${oneVerb} ${rest}` : `Its ${n} members ${manyVerb} ${rest}`;
}

/** "Ada Lovelace <ada@example.com>", or just the email. */
export function userLabel(user: { name: string | null; email: string | null }): string {
  const email = user.email ?? 'this user';
  return user.name ? `${user.name} <${email}>` : email;
}

// ---- workspaces (console) -------------------------------------------------

export function archiveWorkspaceConfirm(ws: WorkspaceRef & { memberCount: number }): string {
  const members = membersAccess(ws.memberCount, 'loses', 'lose', 'access on their next page load.');
  return `Archive the workspace ${workspaceLabel(ws, { quoted: true })}?\n\n${members} Its scheduled jobs stop until a super-admin restores it. Nothing is deleted.`;
}

export function restoreWorkspaceConfirm(ws: WorkspaceRef & { memberCount: number }): string {
  const members = membersAccess(
    ws.memberCount,
    'gets',
    'get',
    'access back on their next page load.',
  );
  return `Restore the workspace ${workspaceLabel(ws, { quoted: true })}?\n\n${members} Its scheduled jobs resume.`;
}

export function billingExemptOnConfirm(ws: WorkspaceRef): string {
  return `Make ${workspaceLabel(ws, { quoted: true })} billing exempt?\n\nUsage stops debiting its token balance, it gets Pro plan limits whatever it pays for, and auto top-up stops. The platform pays its provider costs from now on.`;
}

export function billingExemptOffConfirm(
  ws: WorkspaceRef & {
    balance: string;
    plan: string;
    subscriptionStatus: string;
  },
): string {
  const balance = parseBalance(ws.balance);
  const shown = balance === null ? ws.balance : formatTokens(balance);
  const empty =
    balance !== null && balance <= 0n
      ? ' Its wallet is empty, so metered work (discovery, qualification, drafting) pauses until tokens are added.'
      : '';
  return `End the billing exemption for ${workspaceLabel(ws, { quoted: true })}?\n\nUsage debits its token balance again (${shown} tokens now) and its own plan limits apply (${ws.plan}, ${ws.subscriptionStatus}).${empty}`;
}

export function removeMemberConfirm(
  user: { name: string | null; email: string | null },
  workspace?: WorkspaceRef | string,
): string {
  const ws = typeof workspace === 'string' ? { name: workspace } : workspace;
  const where = ws ? workspaceLabel(ws, { quoted: true }) : 'this workspace';
  return `Remove ${userLabel(user)} from ${where}?\n\nThey lose access to it on their next page load. What they created stays in the workspace.`;
}

// ---- users (console) ------------------------------------------------------

export function promoteSuperAdminConfirm(user: { name: string | null; email: string }): string {
  return `Promote ${userLabel(user)} to super-admin?\n\nThey get full platform access: every workspace and user, billing, provider keys, god mode and this console.`;
}

export function demoteSuperAdminConfirm(user: { name: string | null; email: string }): string {
  return `Demote ${userLabel(user)} to a standard user?\n\nThey lose this console and god mode at once. Their workspace memberships stay as they are.`;
}

export const ACCOUNT_STATUSES = ['active', 'pending', 'suspended', 'rejected'] as const;
export type AccountStatusValue = (typeof ACCOUNT_STATUSES)[number];

/**
 * One confirm per status the user could be moved to (their current status
 * has none — re-applying it only updates the reason). Feed it to
 * ConfirmFormButton's messageByValue on the status select.
 */
export function accountStatusConfirms(
  user: {
    name: string | null;
    email: string;
    role: string;
    accountStatus: string;
  },
  /** PC-06: workspaces this user is the accountable owner of. */
  ownedWorkspaces: readonly WorkspaceRef[] = [],
): Partial<Record<AccountStatusValue, string>> {
  const who = userLabel(user);
  const superNote =
    user.role === 'super_admin'
      ? `\n\nNote: ${user.email} is a super-admin, and account status does not lock super-admins out. Demote them first.`
      : '';
  const stopNote = ownerStopNote(ownedWorkspaces);
  const resumeNote =
    ownedWorkspaces.length > 0
      ? `\n\nAutomatic work resumes in the workspace${ownedWorkspaces.length === 1 ? '' : 's'} they own: ${ownedWorkspaces.map((w) => workspaceLabel(w)).join(', ')}.`
      : '';
  const all: Record<AccountStatusValue, string> = {
    active: `Set ${who} to active?\n\nThey get access to their workspaces on their next page load.${resumeNote}`,
    pending: `Set ${who} back to pending?\n\nThey lose access on their next page load and wait on the pending screen until someone approves them.${stopNote}${superNote}`,
    suspended: `Suspend ${who}?\n\nThey lose access to every workspace on their next page load, until a super-admin sets them back to active.${stopNote}${superNote}`,
    rejected: `Reject ${who}?\n\nThey lose access to every workspace on their next page load and see an "Account rejected" notice.${stopNote}${superNote}`,
  };
  const out: Partial<Record<AccountStatusValue, string>> = {};
  for (const status of ACCOUNT_STATUSES) {
    if (status !== user.accountStatus) out[status] = all[status];
  }
  return out;
}

/**
 * PC-06 accountable-owner rule, said where an owner is suspended:
 * automation acts only as an active owner, so their workspaces stop all
 * automatic work (members can still work by hand).
 */
export function ownerStopNote(ownedWorkspaces: readonly WorkspaceRef[]): string {
  if (ownedWorkspaces.length === 0) return '';
  const names = ownedWorkspaces.map((w) => workspaceLabel(w, { quoted: true })).join(', ');
  return `\n\nThey own ${names}. Automation only ever acts as an active owner, so all automatic work there stops (sending, inbox sync, discovery, autopilot, CRM sync, background AI) until they are active again or ownership moves. Members can still work by hand.`;
}

// ---- holds (console, PC-06) -------------------------------------------------

export function placeHoldConfirm(ws: WorkspaceRef): string {
  return `Put a hold on ${workspaceLabel(ws, { quoted: true })}?\n\nThe work you picked stops there for automatic and manual use alike until the platform releases it (or it expires). Its owners and admins are notified, every member sees a banner, and they cannot release it.`;
}

export function releaseHoldConfirm(ws: WorkspaceRef, scopeLabel: string): string {
  return `Release the hold on ${scopeLabel.toLowerCase()} for ${workspaceLabel(ws, { quoted: true })}?\n\nThat work can run again at once, including anything that was waiting. Its owners and admins are notified.`;
}

export function confirmLegacyHoldConfirm(
  ws: WorkspaceRef,
  flagKey: string,
  scopeLabel: string,
): string {
  return `Enforce the legacy flag ${flagKey} as a hold on ${scopeLabel.toLowerCase()} for ${workspaceLabel(ws, { quoted: true })}?\n\nIt was never enforced before: from now on that work stops there, manual and automatic, until the platform releases it. Its owners and admins are notified.`;
}

export function discardLegacyHoldConfirm(ws: WorkspaceRef, flagKey: string): string {
  return `Discard the legacy flag ${flagKey} for ${workspaceLabel(ws, { quoted: true })}?\n\nIt was never enforced, so nothing changes for the workspace. The row stays in its hold history as discarded.`;
}

export function revokePreauthConfirm(p: {
  email: string;
  role: string;
  workspaceName: string | null;
  workspaceSlug?: string | null;
}): string {
  const effect = p.workspaceName
    ? `They will no longer join ${workspaceLabel({ name: p.workspaceName, slug: p.workspaceSlug }, { quoted: true })} as ${p.role} automatically: if they sign in, they wait in pending review.`
    : 'If they sign in, they wait in pending review instead of being let straight in.';
  return `Revoke the pre-authorisation for ${p.email}?\n\n${effect}`;
}

// ---- support (console) ----------------------------------------------------

export function closeSupportThreadConfirm(t: {
  subject: string;
  workspaceName: string;
  workspaceSlug?: string | null;
}): string {
  return `Close the support thread "${t.subject}" from ${workspaceLabel({ name: t.workspaceName, slug: t.workspaceSlug })}?\n\nThe customer sees it as closed. Their next reply reopens it.`;
}

// ---- providers (console) --------------------------------------------------

export function removeConsoleKeyConfirm(p: {
  vendorName: string;
  envVar: string;
  envSet: boolean;
}): string {
  const effect = p.envSet
    ? `Workspaces without their own key fall back to the ${p.envVar} server env var.`
    : `${p.envVar} is not set on the server, so every workspace without its own ${p.vendorName} key loses ${p.vendorName} at once: anything that runs on it fails until a key is added.`;
  return `Remove the platform ${p.vendorName} key?\n\n${effect} The key cannot be shown again.`;
}

export function savePlatformDefaultsConfirm(): string {
  return 'Save the platform default providers and models?\n\nThey apply immediately to every workspace that has not picked its own, including workspaces running jobs right now.';
}

// ---- workspace settings ---------------------------------------------------

export function switchToSimpleSetupConfirm(workspace: WorkspaceRef | string): string {
  const ws = typeof workspace === 'string' ? { name: workspace } : workspace;
  return `Switch ${workspaceLabel(ws, { quoted: true })} to Simple setup?\n\nEvery provider and model choice on this page goes back to the platform defaults. Stored workspace API keys are kept. Switching back to Advanced later does not restore your choices.`;
}

export function clearWorkspaceKeyConfirm(p: {
  vendorName: string;
  workspaceName: string;
  workspaceSlug?: string | null;
}): string {
  return `Delete the ${p.vendorName} key stored for ${workspaceLabel({ name: p.workspaceName, slug: p.workspaceSlug }, { quoted: true })}?\n\n${p.vendorName} calls fall back to the platform key, if one is configured, and are billed from your token balance. The key cannot be shown again, so keep a copy if you plan to re-add it.`;
}

export function archiveCrmConnectionConfirm(c: { name: string; system: string }): string {
  return `Archive the CRM connection "${c.name}" (${c.system})?\n\nLeads and contacts stop syncing to it until an admin restores it on this page.`;
}

// ---- autopilot ------------------------------------------------------------

/** The per-product override columns (NULL = inherit). */
export interface AutopilotOverlayLike {
  autopilotEnabled: boolean | null;
  emergencyPause: boolean | null;
  enableAutoApproveProjects: boolean | null;
  autoApproveThreshold: number | null;
  enableAutoEnqueueOutreach: boolean | null;
  enableAutoCrmContactSync: boolean | null;
  enableAutoCrmDealOnQualified: boolean | null;
  defaultMailboxId: bigint | null;
}

/** The workspace defaults those columns fall back to. (PC-05: there is
 *  no workspace emergency pause any more — stopping everything is the
 *  workspace pause, see resumeAutomationConfirm.) */
export interface AutopilotBaseLike {
  autopilotEnabled: boolean;
  enableAutoApproveProjects: boolean;
  autoApproveThreshold: number;
  enableAutoEnqueueOutreach: boolean;
  enableAutoCrmContactSync: boolean;
  enableAutoCrmDealOnQualified: boolean;
}

/** Same labels as the toggles on /autopilot. */
const AUTOPILOT_STEP_LABELS = {
  autopilotEnabled: 'Autopilot (master)',
  enableAutoApproveProjects: 'Auto-approve relevant review items',
  enableAutoEnqueueOutreach: 'Auto-generate + enqueue outreach drafts',
  enableAutoCrmContactSync: "Auto-sync qualified leads' contacts to CRM",
  enableAutoCrmDealOnQualified: 'Auto-create CRM deals on qualified state',
} as const;

/**
 * Confirm text for "Clear all overrides for <product>": spells out what
 * the product actually starts doing once it inherits the workspace
 * defaults — above all automation that turns ON.
 */
export function clearAutopilotOverridesConfirm(
  productName: string,
  overlay: AutopilotOverlayLike,
  base: AutopilotBaseLike,
): string {
  const turnsOn: string[] = [];
  const turnsOff: string[] = [];
  for (const key of Object.keys(AUTOPILOT_STEP_LABELS) as Array<
    keyof typeof AUTOPILOT_STEP_LABELS
  >) {
    const override = overlay[key];
    if (override === null || override === base[key]) continue;
    (base[key] ? turnsOn : turnsOff).push(AUTOPILOT_STEP_LABELS[key]);
  }
  const effects: string[] = [];
  if (overlay.emergencyPause !== null) {
    // PC-05 / I020: a saved per-product pause override was never applied;
    // clearing it changes nothing that runs, so say so.
    effects.push(
      `- Removes ${productName}'s old per-product pause setting (it was saved but never applied; pausing is for the whole workspace).`,
    );
  }
  if (turnsOn.length > 0) effects.push(`- Turns ON: ${turnsOn.join('; ')}.`);
  if (turnsOff.length > 0) effects.push(`- Turns off: ${turnsOff.join('; ')}.`);
  if (
    overlay.autoApproveThreshold !== null &&
    overlay.autoApproveThreshold !== base.autoApproveThreshold
  ) {
    effects.push(
      `- Approval threshold: ${overlay.autoApproveThreshold} → ${base.autoApproveThreshold}.`,
    );
  }
  if (overlay.defaultMailboxId !== null) {
    effects.push('- Sends from the workspace default mailbox again.');
  }
  const body =
    effects.length > 0
      ? effects.join('\n')
      : 'Nothing changes in practice: every override matches the workspace default.';
  return `Clear all autopilot overrides for "${productName}"?\n\nEvery step for this product goes back to the workspace default.\n${body}`;
}

// ---- workspace pause (PC-05) ------------------------------------------------

export interface PauseImpactLike {
  queued: number;
  queuedDue: number;
  /** Already formatted for the reader (UTC), or null when nothing is queued. */
  nextSendAt: string | null;
  pendingFollowUps: number;
  awaitingApprovalFollowUps: number;
  enabledCrawlPlans: number;
  autopilotEnabled: boolean;
  heldInboundActions: number;
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Resume asks first: everything that waited starts again at once. */
export function resumeAutomationConfirm(impact: PauseImpactLike): string {
  const lines = [
    `- Send queue: ${plural(impact.queued, 'queued email')}${
      impact.queued > 0
        ? ` (${impact.queuedDue} already due${impact.nextSendAt ? `, next ${impact.nextSendAt}` : ''})`
        : ''
    }, within the daily limit and sending windows.`,
    `- Follow-ups: ${plural(impact.pendingFollowUps, 'pending step')} composed by AI and sent on schedule${
      impact.awaitingApprovalFollowUps > 0
        ? ` (${impact.awaitingApprovalFollowUps} more wait for your approval)`
        : ''
    }.`,
    `- Scheduled crawls: ${plural(impact.enabledCrawlPlans, 'enabled plan')}.`,
    `- Autopilot: ${impact.autopilotEnabled ? 'on — its next run starts within 5 minutes' : 'off (stays off)'}.`,
    '- Reply auto-actions, background AI, auto top-up and the trash purge.',
  ];
  const held =
    impact.heldInboundActions > 0
      ? `\n\n${plural(impact.heldInboundActions, 'reply auto-action')} waited while paused. They are not applied on resume — check those replies yourself.`
      : '';
  return `Resume all automation in this workspace?\n\nWhat starts again at once:\n${lines.join('\n')}${held}`;
}

/** The go-live release (console, flow:F-07). */
export function releaseGoLiveConfirm(ws: WorkspaceRef): string {
  return `Release ${workspaceLabel(ws, { quoted: true })} for outreach?\n\nIts cold emails, follow-ups and AI reply drafts start sending on their schedule — anything held in its queue goes out within the daily limit. Its owners and admins are notified.`;
}

export function revokeGoLiveConfirm(ws: WorkspaceRef): string {
  return `Put ${workspaceLabel(ws, { quoted: true })} back on the go-live hold?\n\nIts cold emails, follow-ups and AI reply drafts stop and wait in the queue (not failed) until it is released again. Email its members write themselves still sends. Its owners and admins are notified.`;
}
