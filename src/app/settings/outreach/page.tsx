// Phase A: workspace-default toggles for staged outreach automation.
// autoDraftReplies governs whether inbound replies trigger an AI draft
// for human review; autoSendReplies governs whether high-confidence
// drafts go out without manual approval. Workspace-admin only.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus, Timer, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  WorkspaceServiceError,
  getWorkspace,
  updateOutreachDefaults,
} from '@/lib/services/workspace';
import {
  FollowUpServiceError,
  loadSettings as loadFollowUpSettings,
  updateFollowUpConfig,
  type FollowUpStepConfig,
} from '@/lib/services/follow-up';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function OutreachSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  let ws;
  try {
    ctx = await getWorkspaceContext();
    ws = await getWorkspace(ctx);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }
  if (!canAdminWorkspace(ctx)) {
    return (
      <AppShell>
        <h1>Outreach defaults</h1>
        <p className="form-error">Workspace-admin only.</p>
      </AppShell>
    );
  }

  const followUpSettings = await loadFollowUpSettings(ctx.workspaceId);

  async function save(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const autoDraftReplies = formData.get('autoDraftReplies') === 'on';
    const autoSendReplies = formData.get('autoSendReplies') === 'on';
    try {
      await updateOutreachDefaults(c, { autoDraftReplies, autoSendReplies });
      redirect('/settings/outreach?message=Saved');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof WorkspaceServiceError ? err.message : 'failed';
      redirect(`/settings/outreach?error=${encodeURIComponent(m)}`);
    }
  }

  async function saveFollowUp(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const enabled = formData.get('followUpEnabled') === 'on';
    const requireApproval =
      formData.get('followUpRequireApproval') === 'on';
    const stepDays = formData.getAll('stepDays') as string[];
    const stepInstr = formData.getAll('stepInstr') as string[];
    const steps: FollowUpStepConfig[] = [];
    for (let i = 0; i < stepDays.length; i++) {
      const d = Number(stepDays[i]);
      if (!Number.isFinite(d) || d < 1) continue;
      steps.push({
        daysAfterPrev: Math.floor(d),
        customInstructions: (stepInstr[i] ?? '').trim(),
      });
    }
    if (steps.length === 0) {
      redirect(
        '/settings/outreach?error=' +
          encodeURIComponent('at least one follow-up step is required'),
      );
    }
    try {
      await updateFollowUpConfig(c, { enabled, requireApproval, steps });
      redirect('/settings/outreach?message=Follow-up+config+saved');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof FollowUpServiceError ? err.message : 'failed';
      redirect(`/settings/outreach?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/settings/integrations">Settings</Link> / Outreach
      </p>
      <h1>Outreach defaults</h1>
      <p className="page-lede">
        How the staged outreach engine handles replies on this workspace&apos;s
        threads. Both flags can be flipped per workspace; super-admin can
        also override per lead.
      </p>

      {sp.message ? <p className="form-info">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <form action={save} className="edit-draft-form">
        <fieldset className="ks-kind-fields">
          <legend className="muted">Reply automation</legend>

          <label className="checkbox-row">
            <input
              type="checkbox"
              name="autoDraftReplies"
              defaultChecked={ws.autoDraftReplies}
            />
            <span>
              <strong>Auto-draft replies</strong> — when an inbound message
              lands on an outreach thread, generate the next draft via AI
              and queue it for your review. <em>Recommended: ON.</em>
            </span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              name="autoSendReplies"
              defaultChecked={ws.autoSendReplies}
            />
            <span>
              <strong>Auto-send replies</strong> — when an auto-drafted reply
              has high enough confidence, send it without manual approval.
              Implies auto-draft. <em>Recommended: OFF</em> until you have
              several weeks of supervised drafts you&apos;re happy with.
            </span>
          </label>
        </fieldset>

        <div className="action-row">
          <button type="submit" className="primary-btn">Save</button>
          <Link href="/settings/integrations" className="ghost-btn">Cancel</Link>
        </div>
      </form>

      <hr style={{ margin: '2rem 0' }} />

      <h2>
        <Timer className="lucide" /> Follow-up configuration
      </h2>
      <p className="page-lede" style={{ marginTop: 0 }}>
        After the first outbound on a thread, the platform automatically
        schedules a sequence of polite follow-ups. Each step has its own
        delay and optional operator instructions injected into the AI
        prompt for that send. Turn on <em>Require approval before send</em>
        when you want to review every follow-up instead of letting the
        platform send autonomously — staged composes show up on{' '}
        <Link href="/communication/follow-ups">Communication → Follow-ups</Link>
        {' '}
        with Approve / Reject buttons.
      </p>

      <form action={saveFollowUp} className="edit-draft-form">
        <fieldset className="ks-kind-fields">
          <legend className="muted">Global</legend>
          <label className="checkbox-row">
            <input
              type="checkbox"
              name="followUpEnabled"
              defaultChecked={followUpSettings.enabled}
            />
            <span>
              <strong>Enable follow-ups</strong> — when off, no new
              schedules are created and the worker tick is a no-op for
              this workspace. Existing pending rows stay pending until
              manually cancelled.
            </span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              name="followUpRequireApproval"
              defaultChecked={followUpSettings.requireApproval}
            />
            <span>
              <strong>Require approval before send</strong> — the worker
              composes via AI as usual but stages the email for human
              review instead of sending. Approve, edit, or reject each
              one from the Follow-ups tab.
            </span>
          </label>
        </fieldset>

        <fieldset className="ks-kind-fields">
          <legend className="muted">
            Steps — order matters. The last step automatically gets a
            &quot;this is the final email&quot; framing in its AI prompt.
          </legend>
          <p className="muted" style={{ fontSize: '0.78em', marginTop: 0 }}>
            <strong>Days after previous</strong> is days from the
            previous step (or from the first outbound, for step 1).
            Default cadence 7 / 7 / 7. <strong>Operator instructions</strong>{' '}
            are injected verbatim into the AI prompt for that specific
            step — e.g. &quot;mention the trade show&quot; or
            &quot;ask about timing for Q3&quot;. Up to 10 steps.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', width: '4ch' }}>#</th>
                <th style={{ textAlign: 'left', width: '14ch' }}>
                  Days after prev.
                </th>
                <th style={{ textAlign: 'left' }}>
                  Operator instructions (optional)
                </th>
              </tr>
            </thead>
            <tbody>
              {followUpSettings.steps.map((s, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <input
                      type="number"
                      name="stepDays"
                      min={1}
                      max={365}
                      defaultValue={s.daysAfterPrev}
                      style={{ width: '8ch' }}
                      required
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      name="stepInstr"
                      defaultValue={s.customInstructions}
                      placeholder={
                        i === followUpSettings.steps.length - 1
                          ? "e.g. emphasise we'll close the loop now"
                          : 'e.g. mention the trade show, ask about timing'
                      }
                      maxLength={2000}
                      style={{ width: '100%' }}
                    />
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <Plus className="lucide" />
                </td>
                <td>
                  <input
                    type="number"
                    name="stepDays"
                    min={1}
                    max={365}
                    placeholder="add (e.g. 7)"
                    style={{ width: '8ch' }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    name="stepInstr"
                    placeholder="(optional instructions)"
                    maxLength={2000}
                    style={{ width: '100%' }}
                  />
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: '0.75em' }}>
            To <strong>remove</strong> a step, clear its &quot;Days after
            prev&quot; field before saving — empty rows are dropped on
            save.
          </p>
        </fieldset>

        <div className="action-row">
          <button type="submit" className="primary-btn">
            Save follow-up config
          </button>
          <Link href="/communication/follow-ups" className="ghost-btn">
            See live schedule →
          </Link>
        </div>
      </form>

      <p className="muted" style={{ fontSize: '0.78em', marginTop: '1rem' }}>
        <Trash2 className="lucide" /> Disabling follow-ups doesn&apos;t
        cancel rows already scheduled. Cancel them individually on the{' '}
        <Link href="/communication/follow-ups">Follow-ups tab</Link>, or
        wait for the worker — pending rows are skipped if the lead
        closes or the recipient replies.
      </p>
    </AppShell>
  );
}
