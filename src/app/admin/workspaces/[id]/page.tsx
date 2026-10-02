import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq, inArray } from 'drizzle-orm';
import { requirePlatformAdmin } from '@/lib/services/auth-context';
import {
  AdminServiceError,
  adminAddUserToWorkspace,
  adminRemoveUserFromWorkspace,
  adminSetMemberRole,
  archiveWorkspace,
  deleteWorkspace,
  restoreWorkspace,
  setBillingExempt,
  setWorkspaceDefault,
  updateWorkspaceProfile,
} from '@/lib/services/admin';
import {
  AUTOMATION_CAPABILITIES,
  CAPABILITY_LABELS,
  loadAutomationState,
  ownerProblemMessage,
  type AutomationCapability,
} from '@/lib/services/automation-gate';
import {
  HOLD_REASON_MAX,
  HoldServiceError,
  confirmLegacyHold,
  discardLegacyHold,
  listHoldsForPlatform,
  placePlatformHold,
  releasePlatformHold,
} from '@/lib/services/holds';
import { formatUtc } from '@/lib/format-utc';
import {
  GO_LIVE_REASON_MAX,
  GoLiveError,
  releaseOutreachLive,
  revokeOutreachLive,
} from '@/lib/services/go-live';
import {
  TokenError,
  adjustTokens,
  listTokenTransactions,
} from '@/lib/services/token-ledger';
import { summarizeUsage } from '@/lib/services/usage';
import type { WorkspaceMemberRole } from '@/lib/db/schema/workspaces';
import { db } from '@/lib/db/client';
import { workspaces, workspaceMembers } from '@/lib/db/schema/workspaces';
import { users } from '@/lib/db/schema/auth';
import { isNextRedirectError } from '@/lib/server-redirect';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { ConfirmTokenAdjustButton } from '@/components/ConfirmTokenAdjustButton';
import { TableScroll } from '@/components/TableScroll';
import {
  archiveWorkspaceConfirm,
  billingExemptOffConfirm,
  billingExemptOnConfirm,
  confirmLegacyHoldConfirm,
  discardLegacyHoldConfirm,
  placeHoldConfirm,
  releaseGoLiveConfirm,
  releaseHoldConfirm,
  removeMemberConfirm,
  restoreWorkspaceConfirm,
  revokeGoLiveConfirm,
} from '@/lib/confirm-copy';

/** PC-06: how long a new hold lasts (the place-hold form's select). */
const HOLD_DURATIONS: ReadonlyArray<{ value: string; label: string; ms: number | null }> = [
  { value: '', label: 'Until released', ms: null },
  { value: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { value: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
];

function holdExpiry(value: string): Date | null {
  const ms = HOLD_DURATIONS.find((d) => d.value === value)?.ms ?? null;
  return ms === null ? null : new Date(Date.now() + ms);
}

function isCapability(value: string): value is AutomationCapability {
  return (AUTOMATION_CAPABILITIES as readonly string[]).includes(value);
}

function parseHoldId(raw: FormDataEntryValue | null): bigint | null {
  return typeof raw === 'string' && /^\d{1,19}$/.test(raw) ? BigInt(raw) : null;
}

function holdErrorMessage(err: unknown): string {
  return err instanceof HoldServiceError ? err.message : 'failed';
}

function goLiveErrorMessage(err: unknown): string {
  return err instanceof GoLiveError ? err.message : 'failed';
}

export default async function AdminWorkspaceDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const pctx = await requirePlatformAdmin();
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/admin');
  const targetWorkspaceId = BigInt(idStr);
  const sp = await searchParams;

  const wsRows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, targetWorkspaceId))
    .limit(1);
  if (!wsRows[0]) redirect('/admin');
  const ws = wsRows[0];

  const members = await db
    .select({ member: workspaceMembers, user: users })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, targetWorkspaceId));

  // PC-06: holds (the repurposed "Feature flags" section) and what the
  // automation gate sees for this tenant.
  const holds = await listHoldsForPlatform(pctx, targetWorkspaceId);
  const activeHolds = holds.filter((h) => h.kind === 'hold' && h.state === 'active');
  const pendingReview = holds.filter((h) => h.state === 'pending_review');
  const endedHolds = holds.filter((h) => h.state === 'released' || h.state === 'discarded');
  const automation = await loadAutomationState(targetWorkspaceId);
  const holdActorIds = [
    ...new Set(
      holds
        .flatMap((h) => [h.placedByUserId, h.confirmedByUserId, h.endedByUserId])
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const holdActors =
    holdActorIds.length > 0
      ? await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, holdActorIds))
      : [];
  const actorEmail = new Map(holdActors.map((u) => [u.id, u.email]));
  // PC-05 / flow:F-07: who released the workspace for outreach, and who
  // paused it.
  const stateActorIds = [automation.live?.byUserId, automation.pause?.byUserId].filter(
    (x): x is string => Boolean(x) && !actorEmail.has(x as string),
  );
  if (stateActorIds.length > 0) {
    const more = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, stateActorIds));
    for (const u of more) actorEmail.set(u.id, u.email);
  }

  // Billing + usage snapshot for THIS workspace. Both reads are
  // workspace-scoped services aimed at the target tenant — legitimate
  // here because the whole page is super-admin gated above.
  const targetScope = { workspaceId: targetWorkspaceId };
  const usage30d = await summarizeUsage(targetScope, {
    since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });
  const usageTotalCents = usage30d.reduce((acc, r) => acc + r.totalCostCents, 0);
  const tokenTx = await listTokenTransactions(targetScope, { limit: 20 });

  async function grantTokens(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const raw = String(formData.get('tokens') ?? '').trim();
    const reason = String(formData.get('reason') ?? '').trim() || 'manual adjustment';
    const tokens = Number(raw);
    if (!Number.isFinite(tokens) || !Number.isInteger(tokens) || tokens === 0) {
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent('tokens must be a non-zero integer (negative = deduct)')}`);
    }
    try {
      await adjustTokens(c, targetWorkspaceId, tokens, reason);
      redirect(
        `/admin/workspaces/${idStr}?message=${encodeURIComponent(`${tokens > 0 ? '+' : ''}${tokens} tokens applied`)}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof TokenError ? err.message : err instanceof Error ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function setExemptState(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    // The state the operator confirmed, not a flip of whatever the row
    // holds now: on a stale page a flip would undo what they asked for.
    const target = String(formData.get('exempt') ?? '');
    if (target !== 'on' && target !== 'off') {
      redirect(`/admin/workspaces/${idStr}?error=Invalid+billing+exemption+state`);
    }
    try {
      await setBillingExempt(c, targetWorkspaceId, target === 'on');
      redirect(`/admin/workspaces/${idStr}?message=Billing+exemption+updated`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AdminServiceError ? err.message : err instanceof Error ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function releaseLive(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    try {
      await releaseOutreachLive(c, targetWorkspaceId, String(formData.get('reason') ?? ''));
      redirect(`/admin/workspaces/${idStr}?message=Workspace+released+for+outreach#go-live`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(goLiveErrorMessage(err))}#go-live`);
    }
  }

  async function revokeLive(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    try {
      await revokeOutreachLive(c, targetWorkspaceId, String(formData.get('reason') ?? ''));
      redirect(`/admin/workspaces/${idStr}?message=Workspace+back+on+the+go-live+hold#go-live`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(goLiveErrorMessage(err))}#go-live`);
    }
  }

  async function placeHold(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const scope = formData.get('scope') === 'all' ? 'all' : 'capabilities';
    const capabilities = formData.getAll('capability').map(String).filter(isCapability);
    try {
      await placePlatformHold(c, targetWorkspaceId, {
        scope,
        capabilities,
        reason: String(formData.get('reason') ?? ''),
        expiresAt: holdExpiry(String(formData.get('expires') ?? '')),
      });
      redirect(`/admin/workspaces/${idStr}?message=Hold+placed#holds`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(holdErrorMessage(err))}#holds`);
    }
  }

  async function releaseHold(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const holdId = parseHoldId(formData.get('holdId'));
    if (holdId === null) redirect(`/admin/workspaces/${idStr}?error=Invalid+hold#holds`);
    try {
      await releasePlatformHold(c, targetWorkspaceId, holdId, String(formData.get('reason') ?? ''));
      redirect(`/admin/workspaces/${idStr}?message=Hold+released#holds`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(holdErrorMessage(err))}#holds`);
    }
  }

  async function confirmHold(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const holdId = parseHoldId(formData.get('holdId'));
    if (holdId === null) redirect(`/admin/workspaces/${idStr}?error=Invalid+hold#holds`);
    try {
      await confirmLegacyHold(c, targetWorkspaceId, holdId);
      redirect(`/admin/workspaces/${idStr}?message=Legacy+flag+confirmed+as+a+hold#holds`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(holdErrorMessage(err))}#holds`);
    }
  }

  async function discardHold(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const holdId = parseHoldId(formData.get('holdId'));
    if (holdId === null) redirect(`/admin/workspaces/${idStr}?error=Invalid+hold#holds`);
    try {
      await discardLegacyHold(c, targetWorkspaceId, holdId, null);
      redirect(`/admin/workspaces/${idStr}?message=Legacy+flag+discarded#holds`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(holdErrorMessage(err))}#holds`);
    }
  }

  async function saveProfile(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const name = String(formData.get('name') ?? '').trim();
    const slug = String(formData.get('slug') ?? '').trim().toLowerCase();
    try {
      await updateWorkspaceProfile(c, targetWorkspaceId, {
        name: name || undefined,
        slug: slug || undefined,
      });
      redirect(`/admin/workspaces/${idStr}?message=Profile+saved`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function archive(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const reason = String(formData.get('reason') ?? '').trim() || null;
    try {
      await archiveWorkspace(c, targetWorkspaceId, reason);
      redirect(`/admin/workspaces/${idStr}?message=Workspace+archived`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function restore() {
    'use server';
    const c = await requirePlatformAdmin();
    try {
      await restoreWorkspace(c, targetWorkspaceId);
      redirect(`/admin/workspaces/${idStr}?message=Workspace+restored`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function toggleDefault(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const isDefault = formData.get('isDefault') === 'on';
    try {
      await setWorkspaceDefault(c, targetWorkspaceId, isDefault);
      redirect(
        `/admin/workspaces/${idStr}?message=${
          isDefault ? 'Marked+as+default' : 'Unmarked+default'
        }`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function destroy(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const confirm = String(formData.get('confirm') ?? '').trim();
    if (confirm !== ws.slug) {
      redirect(
        `/admin/workspaces/${idStr}?error=${encodeURIComponent(
          `Type the slug "${ws.slug}" to confirm`,
        )}`,
      );
    }
    try {
      await deleteWorkspace(c, targetWorkspaceId);
      redirect('/admin/workspaces?message=Workspace+deleted');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function addUser(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const targetUserId = String(formData.get('targetUserId') ?? '');
    const role = String(formData.get('role') ?? 'member') as WorkspaceMemberRole;
    try {
      await adminAddUserToWorkspace(c, targetUserId, targetWorkspaceId, role);
      redirect(`/admin/workspaces/${idStr}?message=Member+added`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function removeUser(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const targetUserId = String(formData.get('targetUserId') ?? '');
    try {
      await adminRemoveUserFromWorkspace(c, targetUserId, targetWorkspaceId);
      redirect(`/admin/workspaces/${idStr}?message=Member+removed`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  async function changeRole(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
    const targetUserId = String(formData.get('targetUserId') ?? '');
    const role = String(formData.get('role') ?? 'member') as WorkspaceMemberRole;
    try {
      await adminSetMemberRole(c, targetWorkspaceId, targetUserId, role);
      redirect(`/admin/workspaces/${idStr}?message=Role+updated`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      redirect(`/admin/workspaces/${idStr}?error=${encodeURIComponent(m)}`);
    }
  }

  // Users not yet in this workspace, for the add-member dropdown.
  const memberIds = new Set(members.map((m) => m.user.id));
  const candidateUsers = (
    await db.select().from(users).where(eq(users.accountStatus, 'active'))
  ).filter((u) => !memberIds.has(u.id));

  return (
    <div className="dashboard-wrap">
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/admin">Admin</Link> /{' '}
          <Link href="/admin/workspaces">Workspaces</Link> / {ws.name}
        </p>
        <h1>
          {ws.name}{' '}
          <span className={ws.status === 'active' ? 'badge badge-good' : 'badge badge-bad'}>
            {ws.status}
          </span>
          {ws.isDefault ? <span className="badge"> 🔒 default</span> : null}
        </h1>
        <p className="muted">
          /{ws.slug} · created {ws.createdAt.toLocaleString()}
          {ws.archivedAt
            ? ` · archived ${ws.archivedAt.toLocaleString()}${ws.archivedReason ? ` (${ws.archivedReason})` : ''}`
            : ''}
        </p>
        {sp.message ? <p className="form-message">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <section>
          <h2>Profile</h2>
          <form action={saveProfile} className="inline-form">
            <label>
              <span>Name</span>
              <input type="text" name="name" defaultValue={ws.name} maxLength={120} />
            </label>
            <label>
              <span>Slug</span>
              <input
                type="text"
                name="slug"
                defaultValue={ws.slug}
                maxLength={64}
                pattern="[a-z0-9][a-z0-9-]{0,62}[a-z0-9]"
                title="lowercase letters, numbers, hyphens"
              />
            </label>
            <button type="submit" className="primary-btn">
              Save
            </button>
          </form>
        </section>

        <section>
          <h2>Billing &amp; tokens</h2>
          <p>
            Plan: <strong>{ws.plan}</strong>{' '}
            <span className={ws.subscriptionStatus === 'active' ? 'badge badge-good' : 'badge'}>
              {ws.subscriptionStatus}
            </span>
            {' · '}Stripe:{' '}
            {ws.stripeCustomerId ? <code>{ws.stripeCustomerId}</code> : <span className="muted">none</span>}
            {' · '}Balance:{' '}
            <strong>{ws.tokenBalance.toLocaleString()}</strong> tokens
            {ws.billingExempt ? (
              <span className="badge" style={{ marginLeft: '0.5rem' }}>billing exempt</span>
            ) : null}
          </p>
          <p className="muted">
            Usage last 30 days: <strong>€{(usageTotalCents / 100).toFixed(2)}</strong> estimated
            provider cost across {usage30d.reduce((a, r) => a + r.eventCount, 0)} events.
          </p>

          <div className="action-row" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <form action={grantTokens} className="inline-form">
              <label>
                <span>Tokens (negative = deduct)</span>
                <input type="number" name="tokens" step={1} required placeholder="e.g. 1000" />
              </label>
              <label>
                <span>Reason</span>
                <input type="text" name="reason" maxLength={200} placeholder="promo / support credit / correction" />
              </label>
              <ConfirmTokenAdjustButton
                className="primary-btn"
                workspaceName={ws.name}
                workspaceSlug={ws.slug}
                balance={ws.tokenBalance.toString()}
                billingExempt={ws.billingExempt}
              >
                Apply
              </ConfirmTokenAdjustButton>
            </form>
            <form action={setExemptState}>
              <input type="hidden" name="exempt" value={ws.billingExempt ? 'off' : 'on'} />
              {ws.billingExempt ? (
                <ConfirmFormButton
                  className="ghost-btn"
                  message={billingExemptOffConfirm({
                    name: ws.name,
                    slug: ws.slug,
                    balance: ws.tokenBalance.toString(),
                    plan: ws.plan,
                    subscriptionStatus: ws.subscriptionStatus,
                  })}
                >
                  Disable billing exemption
                </ConfirmFormButton>
              ) : (
                <ConfirmFormButton
                  className="ghost-btn"
                  message={billingExemptOnConfirm({ name: ws.name, slug: ws.slug })}
                  confirmPhrase={ws.slug}
                >
                  Make billing exempt
                </ConfirmFormButton>
              )}
            </form>
          </div>

          {usage30d.length > 0 ? (
            <details style={{ marginTop: '0.75rem' }}>
              <summary>Usage breakdown (30d)</summary>
              <TableScroll label="Usage breakdown, last 30 days">
                <table className="data-table" style={{ marginTop: '0.5rem' }}>
                  <thead>
                    <tr><th>Kind</th><th>Provider</th><th>Events</th><th>Est. cost</th></tr>
                  </thead>
                  <tbody>
                    {usage30d.map((r) => (
                      <tr key={`${r.kind}-${r.provider}`}>
                        <td><code>{r.kind}</code></td>
                        <td>{r.provider}</td>
                        <td>{r.eventCount}</td>
                        <td>€{(r.totalCostCents / 100).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </details>
          ) : null}

          {tokenTx.length > 0 ? (
            <details style={{ marginTop: '0.5rem' }}>
              <summary>Token ledger (last {tokenTx.length})</summary>
              <TableScroll label="Token ledger">
                <table className="data-table" style={{ marginTop: '0.5rem' }}>
                  <thead>
                    <tr><th>When</th><th>Change</th><th>Balance after</th><th>Kind</th><th>Reason</th></tr>
                  </thead>
                  <tbody>
                    {tokenTx.map((t) => (
                      <tr key={t.id.toString()}>
                        <td>{t.createdAt.toLocaleString()}</td>
                        <td className={t.delta > 0n ? 'delta-good' : 'delta-bad'}>
                          {t.delta > 0n ? '+' : ''}{t.delta.toLocaleString()}
                        </td>
                        <td>{t.balanceAfter.toLocaleString()}</td>
                        <td><code>{t.kind}</code></td>
                        <td>{t.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </details>
          ) : null}
        </section>

        <section>
          <h2>Lifecycle</h2>
          <p className="muted">
            Archiving the workspace turns it &ldquo;off&rdquo; — its members
            lose access on next sign-in. Super-admins can still see and
            restore it.
          </p>
          <form action={toggleDefault} className="inline-form">
            <label className="checkbox-row">
              <input
                type="checkbox"
                name="isDefault"
                defaultChecked={ws.isDefault}
              />
              <span>
                🔒 Mark as default — protects from archive + delete
              </span>
            </label>
            <button type="submit">Save</button>
          </form>
          {ws.isDefault ? (
            <p className="muted">
              This workspace is the default — archive and delete are
              disabled. Unmark it first to remove either.
            </p>
          ) : ws.status === 'active' ? (
            <form action={archive} className="inline-form">
              <label>
                <span>Reason (optional)</span>
                <input type="text" name="reason" maxLength={200} />
              </label>
              <ConfirmFormButton
                className="ghost-btn"
                message={archiveWorkspaceConfirm({
                  name: ws.name,
                  slug: ws.slug,
                  memberCount: members.length,
                })}
              >
                Archive workspace
              </ConfirmFormButton>
            </form>
          ) : (
            <>
              <form action={restore}>
                <ConfirmFormButton
                  className="primary-btn"
                  message={restoreWorkspaceConfirm({
                    name: ws.name,
                    slug: ws.slug,
                    memberCount: members.length,
                  })}
                >
                  Restore workspace
                </ConfirmFormButton>
              </form>
              <p
                className="muted"
                style={{ marginTop: '1.5rem', borderTop: '1px solid var(--brand-border)', paddingTop: '1rem' }}
              >
                <strong>Danger zone.</strong> Permanent delete cascades
                across every workspace-scoped table — leads, drafts,
                threads, contacts, knowledge, etc. This cannot be undone.
                Type the workspace slug to confirm.
              </p>
              <form action={destroy} className="inline-form">
                <label>
                  <span>Confirm slug</span>
                  <input
                    type="text"
                    name="confirm"
                    placeholder={ws.slug}
                    autoComplete="off"
                    required
                  />
                </label>
                <button type="submit" className="ghost-btn">
                  Permanently delete
                </button>
              </form>
            </>
          )}
        </section>

        <section>
          <h2>Members ({members.length})</h2>
          <p className="muted">
            To see this workspace the way its members do, leave the console
            and pick &ldquo;{ws.name}&rdquo; under <strong>god mode</strong> in
            the workspace switcher. Whatever you do there is logged in this
            workspace under your own user id.
          </p>
          <ul className="profile-list">
            {members.map(({ member, user }) => (
              <li key={member.id.toString()}>
                <div className="lead-row">
                  <strong>
                    <Link href={`/admin/users/${user.id}`}>
                      {user.name ?? user.email ?? user.id}
                    </Link>
                  </strong>
                  <span className="badge">
                    {roleIcon(member.role)} {member.role}
                  </span>
                </div>
                <div className="meta">
                  <span>{user.email}</span>
                  <span>added {member.createdAt.toLocaleDateString()}</span>
                </div>
                <div
                  style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
                >
                  <form action={changeRole} className="inline-form">
                    <input type="hidden" name="targetUserId" value={user.id} />
                    <label>
                      <span>Role</span>
                      <select name="role" defaultValue={member.role}>
                        <option value="owner">👑 owner</option>
                        <option value="admin">🛡 admin</option>
                        <option value="manager">⭐ manager</option>
                        <option value="member">👤 member</option>
                        <option value="viewer">👁 viewer</option>
                      </select>
                    </label>
                    <button type="submit">Apply</button>
                  </form>
                  {member.role !== 'owner' || members.filter((m) => m.member.role === 'owner').length > 1 ? (
                    <form action={removeUser}>
                      <input type="hidden" name="targetUserId" value={user.id} />
                      <ConfirmFormButton
                        className="ghost-btn"
                        message={removeMemberConfirm(user, { name: ws.name, slug: ws.slug })}
                      >
                        Remove from workspace
                      </ConfirmFormButton>
                    </form>
                  ) : (
                    <span className="muted">last owner — cannot remove</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {candidateUsers.length > 0 ? (
            <form action={addUser} className="inline-form" style={{ marginTop: '1rem' }}>
              <label>
                <span>Add user</span>
                <select name="targetUserId" required>
                  {candidateUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name ? `${u.name} <${u.email}>` : u.email}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Role</span>
                <select name="role" defaultValue="member">
                  <option value="owner">owner</option>
                  <option value="admin">admin</option>
                  <option value="manager">manager</option>
                  <option value="member">member</option>
                  <option value="viewer">viewer</option>
                </select>
              </label>
              <button type="submit" className="primary-btn">
                Add member
              </button>
            </form>
          ) : (
            <p className="muted">All active users are already members.</p>
          )}
        </section>

        <section id="go-live">
          <h2>Outreach go-live</h2>
          <p className="muted">
            Every workspace starts not live: its cold emails, follow-ups and AI reply drafts
            wait in the queue (never failed) while email its members write themselves sends
            normally. Release it once it is ready to send on its own; the reason is audited
            against the workspace and its owners and admins are notified.
          </p>
          <p>
            {automation.live ? (
              <>
                <span className="badge badge-good">live</span> since{' '}
                {formatUtc(automation.live.since)}
                {automation.live.byUserId
                  ? ` (released by ${actorEmail.get(automation.live.byUserId) ?? automation.live.byUserId})`
                  : ''}
              </>
            ) : (
              <span className="badge badge-bad">not live</span>
            )}
          </p>
          <p className="muted">
            Workspace pause:{' '}
            {automation.pause
              ? `paused since ${formatUtc(automation.pause.since)}${
                  automation.pause.byUserId
                    ? ` by ${actorEmail.get(automation.pause.byUserId) ?? automation.pause.byUserId}`
                    : ''
                }${automation.pause.reason ? ` (${automation.pause.reason})` : ''} — its owners and admins resume it.`
              : 'running.'}
          </p>
          <form action={automation.live ? revokeLive : releaseLive} className="inline-form">
            <label>
              <span>Reason (audited)</span>
              <input type="text" name="reason" required minLength={3} maxLength={GO_LIVE_REASON_MAX} />
            </label>
            <ConfirmFormButton
              className={automation.live ? 'ghost-btn' : 'primary-btn'}
              message={
                automation.live
                  ? revokeGoLiveConfirm({ name: ws.name, slug: ws.slug })
                  : releaseGoLiveConfirm({ name: ws.name, slug: ws.slug })
              }
            >
              {automation.live ? 'Put back on hold' : 'Release for outreach'}
            </ConfirmFormButton>
          </form>
        </section>

        <section id="holds">
          <h2>Holds</h2>
          <p className="muted">
            A hold stops the work it names in this workspace, automatic and
            manual alike, until you release it or it expires. Every member
            sees it on a banner, its owners and admins are notified, and they
            cannot release a platform hold. Separately, automatic work stops
            by itself while the owner is not active or no longer a member.
          </p>
          {automation.platformOutboundStop ? (
            <p className="form-error">
              Outbound email is stopped for every workspace by the platform
              since {formatUtc(automation.platformOutboundStop.since)}:{' '}
              {automation.platformOutboundStop.reason}
            </p>
          ) : null}
          {automation.ownerProblem ? (
            <p className="form-error">{ownerProblemMessage(automation)}</p>
          ) : null}
          <ul className="profile-list">
            {activeHolds.length === 0 ? (
              <li className="muted">No holds — nothing is held in this workspace.</li>
            ) : (
              activeHolds.map((h) => (
                <li key={h.id.toString()}>
                  <div className="lead-row">
                    <code>{h.scopeLabel}</code>
                    <span className={h.enforced ? 'badge badge-bad' : 'badge'}>
                      {h.enforced ? 'on hold' : 'expired'}
                    </span>
                    <span className="badge">
                      {h.source === 'platform' ? 'placed by the platform' : 'placed by the workspace'}
                    </span>
                    <form action={releaseHold} className="inline-form" style={{ marginLeft: 'auto' }}>
                      <input type="hidden" name="holdId" value={h.id.toString()} />
                      <label>
                        <span>Reason</span>
                        <input type="text" name="reason" required minLength={3} maxLength={HOLD_REASON_MAX} />
                      </label>
                      <ConfirmFormButton
                        className="ghost-btn"
                        message={releaseHoldConfirm({ name: ws.name, slug: ws.slug }, h.scopeLabel)}
                      >
                        Release
                      </ConfirmFormButton>
                    </form>
                  </div>
                  <div className="meta">
                    <span>{h.reason}</span>
                    <span>
                      placed {formatUtc(h.placedAt)}
                      {h.placedByUserId ? ` by ${actorEmail.get(h.placedByUserId) ?? h.placedByUserId}` : ''}
                    </span>
                    <span>
                      {h.expiresAt
                        ? `${h.expired ? 'expired' : 'until'} ${formatUtc(h.expiresAt)}`
                        : 'until released'}
                    </span>
                  </div>
                </li>
              ))
            )}
          </ul>
          <form action={placeHold} className="inline-form" style={{ marginTop: '1rem' }}>
            <label className="checkbox-row">
              <input type="radio" name="scope" value="all" />
              <span>All automation and capability work</span>
            </label>
            <label className="checkbox-row">
              <input type="radio" name="scope" value="capabilities" defaultChecked />
              <span>Only:</span>
            </label>
            {AUTOMATION_CAPABILITIES.map((cap) => (
              <label key={cap} className="checkbox-row">
                <input type="checkbox" name="capability" value={cap} />
                <span>{CAPABILITY_LABELS[cap]}</span>
              </label>
            ))}
            <label>
              <span>Reason (the tenant sees it)</span>
              <input type="text" name="reason" required minLength={3} maxLength={HOLD_REASON_MAX} />
            </label>
            <label>
              <span>Lasts</span>
              <select name="expires" defaultValue="">
                {HOLD_DURATIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <ConfirmFormButton
              className="primary-btn"
              message={placeHoldConfirm({ name: ws.name, slug: ws.slug })}
            >
              Place hold
            </ConfirmFormButton>
          </form>

          <h3>Legacy flags to review ({pendingReview.length})</h3>
          <p className="muted">
            Imported from the old feature flags, which nothing ever read.
            None of these stops anything until you confirm it; a note stops
            nothing at all and is only discarded once read.
          </p>
          <ul className="profile-list">
            {pendingReview.length === 0 ? (
              <li className="muted">Nothing to review.</li>
            ) : (
              pendingReview.map((h) => (
                <li key={h.id.toString()}>
                  <div className="lead-row">
                    <code>{h.legacyFlagKey ?? 'legacy flag'}</code>
                    <span className="badge">{h.kind === 'note' ? 'note' : h.scopeLabel}</span>
                    <span className="badge">pending review</span>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
                      {h.kind === 'hold' ? (
                        <form action={confirmHold}>
                          <input type="hidden" name="holdId" value={h.id.toString()} />
                          <ConfirmFormButton
                            className="primary-btn"
                            message={confirmLegacyHoldConfirm(
                              { name: ws.name, slug: ws.slug },
                              h.legacyFlagKey ?? 'legacy flag',
                              h.scopeLabel,
                            )}
                          >
                            Confirm
                          </ConfirmFormButton>
                        </form>
                      ) : null}
                      <form action={discardHold}>
                        <input type="hidden" name="holdId" value={h.id.toString()} />
                        <ConfirmFormButton
                          className="ghost-btn"
                          message={discardLegacyHoldConfirm(
                            { name: ws.name, slug: ws.slug },
                            h.legacyFlagKey ?? 'legacy flag',
                          )}
                        >
                          Discard
                        </ConfirmFormButton>
                      </form>
                    </span>
                  </div>
                  <div className="meta">
                    <span>{h.reason}</span>
                  </div>
                </li>
              ))
            )}
          </ul>

          {endedHolds.length > 0 ? (
            <details>
              <summary>Ended holds ({endedHolds.length})</summary>
              <ul className="profile-list">
                {endedHolds.map((h) => (
                  <li key={h.id.toString()}>
                    <div className="lead-row">
                      <code>{h.legacyFlagKey ?? h.scopeLabel}</code>
                      <span className="badge">{h.state}</span>
                    </div>
                    <div className="meta">
                      <span>{h.reason}</span>
                      {h.endedAt ? (
                        <span>
                          {h.state} {formatUtc(h.endedAt)}
                          {h.endedByUserId ? ` by ${actorEmail.get(h.endedByUserId) ?? h.endedByUserId}` : ''}
                          {h.endReason ? `: ${h.endReason}` : ''}
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      </div>
  );
}

function roleIcon(role: string): string {
  switch (role) {
    case 'owner':
      return '👑';
    case 'admin':
      return '🛡';
    case 'manager':
      return '⭐';
    case 'member':
      return '👤';
    case 'viewer':
      return '👁';
    default:
      return '';
  }
}
