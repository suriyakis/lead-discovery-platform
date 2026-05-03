import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth, signOut } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  AutopilotError,
  getAutopilotSettings,
  listAutopilotLog,
  runOnce,
  updateAutopilotSettings,
} from '@/lib/services/autopilot';
import { listMailboxes } from '@/lib/services/mailbox';
import { listCrmConnections } from '@/lib/services/crm';

export default async function AutopilotPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }

  const [settings, log, mailboxes, crmConns] = await Promise.all([
    getAutopilotSettings(ctx),
    listAutopilotLog(ctx, 100),
    listMailboxes(ctx),
    listCrmConnections(ctx),
  ]);

  const canEdit = canAdminWorkspace(ctx);

  async function save(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const num = (k: string) => {
      const v = String(formData.get(k) ?? '');
      return /^\d+$/.test(v) ? Number(v) : undefined;
    };
    const big = (k: string) => {
      const v = String(formData.get(k) ?? '');
      return /^\d+$/.test(v) ? BigInt(v) : null;
    };
    try {
      await updateAutopilotSettings(c, {
        autopilotEnabled: formData.get('autopilotEnabled') === 'on',
        emergencyPause: formData.get('emergencyPause') === 'on',
        enableAutoApproveProjects: formData.get('enableAutoApproveProjects') === 'on',
        autoApproveThreshold: num('autoApproveThreshold'),
        enableAutoEnqueueOutreach: formData.get('enableAutoEnqueueOutreach') === 'on',
        enableAutoDrainQueue: formData.get('enableAutoDrainQueue') === 'on',
        enableAutoSyncInbound: formData.get('enableAutoSyncInbound') === 'on',
        enableAutoCrmContactSync: formData.get('enableAutoCrmContactSync') === 'on',
        enableAutoCrmDealOnQualified: formData.get('enableAutoCrmDealOnQualified') === 'on',
        maxApprovalsPerRun: num('maxApprovalsPerRun'),
        maxEnqueuesPerRun: num('maxEnqueuesPerRun'),
        defaultMailboxId: big('defaultMailboxId'),
        defaultCrmConnectionId: big('defaultCrmConnectionId'),
      });
      redirect('/autopilot?message=Saved');
    } catch (err) {
      const m = err instanceof AutopilotError ? err.message : 'failed';
      redirect(`/autopilot?error=${encodeURIComponent(m)}`);
    }
  }

  async function runNow() {
    'use server';
    const c = await getWorkspaceContext();
    const r = await runOnce(c);
    redirect(
      `/autopilot?message=${encodeURIComponent(
        `runOnce — ${r.steps.length} steps`,
      )}`,
    );
  }

  return (
    <AppShell
      active="autopilot"
      isSuperAdmin={session.user.role === 'super_admin'}
      rightSlot={
        <>
          <span className="who">{session.user.email}</span>
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/' });
            }}
          >
            <button type="submit" className="ghost-btn">
              Sign out
            </button>
          </form>
        </>
      }
    >
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> / Autopilot
      </p>
      <h1>Autopilot</h1>
      <p className="muted">
        Scheduled orchestrator that walks through approve → enqueue → drain →
        sync-inbound → CRM-sync. Every step is gated; everything is audit-logged.
        Default state is OFF — opt in per step.
      </p>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <section>
        <h2>State</h2>
        <p>
          <span className={settings.autopilotEnabled ? 'badge badge-good' : 'badge'}>
            {settings.autopilotEnabled ? 'enabled' : 'disabled'}
          </span>{' '}
          {settings.emergencyPause ? (
            <span className="badge badge-bad">emergency pause</span>
          ) : null}
        </p>
        <form action={runNow}>
          <button type="submit">Run now</button>
        </form>
      </section>

      {canEdit ? (
        <section>
          <h2>Settings</h2>
          <form action={save} className="edit-draft-form">
            <fieldset className="ks-kind-fields">
              <legend className="muted">Master switches</legend>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  name="autopilotEnabled"
                  defaultChecked={settings.autopilotEnabled}
                />
                <span>Autopilot enabled</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  name="emergencyPause"
                  defaultChecked={settings.emergencyPause}
                />
                <span>Emergency pause (kill switch)</span>
              </label>
            </fieldset>

            <fieldset className="ks-kind-fields">
              <legend className="muted">Per-step toggles</legend>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  name="enableAutoSyncInbound"
                  defaultChecked={settings.enableAutoSyncInbound}
                />
                <span>Sync inbound mail (every IMAP-enabled mailbox)</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  name="enableAutoApproveProjects"
                  defaultChecked={settings.enableAutoApproveProjects}
                />
                <span>Auto-approve review items above threshold</span>
              </label>
              <label>
                <span>Approval threshold (0..100)</span>
                <input
                  type="number"
                  name="autoApproveThreshold"
                  defaultValue={settings.autoApproveThreshold}
                  min={0}
                  max={100}
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  name="enableAutoEnqueueOutreach"
                  defaultChecked={settings.enableAutoEnqueueOutreach}
                />
                <span>Auto-generate + enqueue outreach drafts</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  name="enableAutoDrainQueue"
                  defaultChecked={settings.enableAutoDrainQueue}
                />
                <span>Auto-drain the send queue</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  name="enableAutoCrmContactSync"
                  defaultChecked={settings.enableAutoCrmContactSync}
                />
                <span>Auto-sync qualified leads&apos; contacts to CRM</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  name="enableAutoCrmDealOnQualified"
                  defaultChecked={settings.enableAutoCrmDealOnQualified}
                />
                <span>Auto-create CRM deals on qualified state</span>
              </label>
            </fieldset>

            <fieldset className="ks-kind-fields">
              <legend className="muted">Per-run caps</legend>
              <label>
                <span>Max approvals per run</span>
                <input
                  type="number"
                  name="maxApprovalsPerRun"
                  defaultValue={settings.maxApprovalsPerRun}
                  min={0}
                />
              </label>
              <label>
                <span>Max enqueues per run</span>
                <input
                  type="number"
                  name="maxEnqueuesPerRun"
                  defaultValue={settings.maxEnqueuesPerRun}
                  min={0}
                />
              </label>
            </fieldset>

            <fieldset className="ks-kind-fields">
              <legend className="muted">Defaults</legend>
              <label>
                <span>Default mailbox for outreach</span>
                <select
                  name="defaultMailboxId"
                  defaultValue={settings.defaultMailboxId?.toString() ?? ''}
                >
                  <option value="">workspace default</option>
                  {mailboxes
                    .filter((m) => m.status === 'active')
                    .map((m) => (
                      <option key={m.id.toString()} value={m.id.toString()}>
                        {m.name} ({m.fromAddress})
                      </option>
                    ))}
                </select>
              </label>
              <label>
                <span>Default CRM connection</span>
                <select
                  name="defaultCrmConnectionId"
                  defaultValue={settings.defaultCrmConnectionId?.toString() ?? ''}
                >
                  <option value="">first active</option>
                  {crmConns
                    .filter((c) => c.status === 'active')
                    .map((c) => (
                      <option key={c.id.toString()} value={c.id.toString()}>
                        {c.name} ({c.system})
                      </option>
                    ))}
                </select>
              </label>
            </fieldset>

            <div className="action-row">
              <button type="submit" className="primary-btn">
                Save settings
              </button>
            </div>
          </form>
        </section>
      ) : (
        <p className="muted">Workspace admins can edit autopilot settings.</p>
      )}

      <section>
        <h2>Recent activity ({log.length})</h2>
        {log.length === 0 ? (
          <p className="muted">No autopilot runs yet.</p>
        ) : (
          <ul className="timeline">
            {log.map((l) => (
              <li key={l.id.toString()}>
                <span className="muted">{l.createdAt.toLocaleString()}</span>{' '}
                <strong>{l.step}</strong>
                {' · '}
                {l.outcome}
                {l.detail ? ` — ${l.detail.slice(0, 200)}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
