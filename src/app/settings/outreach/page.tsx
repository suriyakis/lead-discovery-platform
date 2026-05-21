import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  AlertTriangle,
  Info,
  Mail,
  MessageSquareReply,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
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
import {
  TRASH_RETENTION_DAYS_MAX,
  TRASH_RETENTION_DAYS_MIN,
  emptyTrashNow,
  updateImapAutoSync,
  updateTrashRetentionDays,
} from '@/lib/services/mail';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { isNextRedirectError } from '@/lib/server-redirect';

const STEP_DESCRIPTORS = [
  'Gentle reminder',
  'Value proposition',
  'Final attempt',
  'Long-tail nudge',
  'Re-engage',
  'Last chance',
  'Cold check',
  'Cold check',
  'Cold check',
  'Cold check',
];

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

  async function saveReply(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const autoDraftReplies = formData.get('autoDraftReplies') === 'on';
    const autoSendReplies = formData.get('autoSendReplies') === 'on';
    try {
      await updateOutreachDefaults(c, { autoDraftReplies, autoSendReplies });
      redirect('/settings/outreach?message=Reply+automation+saved');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof WorkspaceServiceError ? err.message : 'failed';
      redirect(`/settings/outreach?error=${encodeURIComponent(m)}`);
    }
  }

  async function saveAutoSync(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const enabled = formData.get('imapAutoSyncEnabled') === 'on';
    try {
      const r = await updateImapAutoSync(c, enabled);
      redirect(
        '/settings/outreach?message=' +
          encodeURIComponent(
            r.imapAutoSyncEnabled
              ? 'Auto-sync ON — IMAP cron will poll every active mailbox.'
              : 'Auto-sync OFF — mailboxes will only sync when you click Sync.',
          ),
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'auto-sync save failed';
      redirect(`/settings/outreach?error=${encodeURIComponent(m)}`);
    }
  }

  async function saveRetention(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const raw = Number(formData.get('trashRetentionDays'));
    try {
      const result = await updateTrashRetentionDays(
        c,
        Number.isFinite(raw) ? Math.floor(raw) : 30,
      );
      redirect(
        '/settings/outreach?message=' +
          encodeURIComponent(
            result.trashRetentionDays === 0
              ? 'Trash purge disabled (set days > 0 to re-enable).'
              : `Trash now auto-purges after ${result.trashRetentionDays} days.`,
          ),
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'retention save failed';
      redirect(`/settings/outreach?error=${encodeURIComponent(m)}`);
    }
  }

  async function purgeNow() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const result = await emptyTrashNow(c);
      redirect(
        '/settings/outreach?message=' +
          encodeURIComponent(
            result.deleted === 0
              ? 'Trash was already empty.'
              : `${result.deleted} message${result.deleted === 1 ? '' : 's'} permanently deleted.`,
          ),
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'empty trash failed';
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

  const steps = followUpSettings.steps;
  const showAddRow = steps.length < 10;

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/settings/integrations">Settings</Link> / Outreach
      </p>
      <h1 className="page-title">Outreach configuration</h1>
      <p className="page-lede">
        How this workspace handles automatic follow-ups and inbound replies on
        outreach threads. All flags are workspace-scoped.
      </p>

      {sp.message ? <p className="form-info">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      {/* ---------- Reply automation card ---------- */}
      <form action={saveReply} className="config-card">
        <header className="config-card-header">
          <MessageSquareReply className="config-card-icon" aria-hidden="true" />
          <div>
            <h2 className="config-card-title">Reply automation</h2>
            <p className="config-card-desc">
              What happens when an inbound message lands on an outreach thread.
            </p>
          </div>
        </header>

        <div className="config-row">
          <div className="config-row-label">
            <p className="config-row-title">Auto-draft replies</p>
            <p className="config-row-sub">
              Generate the next reply via AI and queue it for your review.
              Recommended: on.
            </p>
          </div>
          <ToggleSwitch name="autoDraftReplies" defaultChecked={ws.autoDraftReplies} />
        </div>

        <div className="config-divider" />

        <div className="config-row">
          <div className="config-row-label">
            <p className="config-row-title">Auto-send replies</p>
            <p className="config-row-sub">
              Send high-confidence drafts without manual approval. Implies
              auto-draft. Recommended: off until you have weeks of supervised
              drafts.
            </p>
          </div>
          <ToggleSwitch name="autoSendReplies" defaultChecked={ws.autoSendReplies} />
        </div>

        <div className="config-card-actions">
          <button type="submit" className="primary-btn">Save reply settings</button>
        </div>
      </form>

      {/* ---------- Follow-up card ---------- */}
      <form action={saveFollowUp} className="config-card">
        <header className="config-card-header">
          <Mail className="config-card-icon" aria-hidden="true" />
          <div>
            <h2 className="config-card-title">Follow-up configuration</h2>
            <p className="config-card-desc">
              Automatic follow-ups after the first outbound on a thread.
              Cancels automatically on reply, bounce, or lead close.
            </p>
          </div>
        </header>

        <div className="config-row">
          <div className="config-row-label">
            <p className="config-row-title">Follow-ups enabled</p>
            <p className="config-row-sub">
              When off, no new schedules are created.
            </p>
          </div>
          <ToggleSwitch name="followUpEnabled" defaultChecked={followUpSettings.enabled} />
        </div>

        <div className="config-divider" />

        <p className="config-eyebrow">Follow-up intervals</p>
        <p className="config-row-sub" style={{ marginTop: 0 }}>
          Days after the previous step (step 1 counts from the first outbound).
          The last step gets a &ldquo;this is the final email&rdquo; framing
          automatically.
        </p>
        <div className="followup-step-grid">
          {steps.map((s, i) => (
            <div className="followup-step-cell" key={i}>
              <span className={`followup-step-badge tier-${tierColor(i)}`}>
                Step {i + 1}
              </span>
              <div className="followup-step-input-row">
                <input
                  type="number"
                  name="stepDays"
                  min={1}
                  max={365}
                  defaultValue={s.daysAfterPrev}
                  className="followup-step-input"
                  required
                />
                <span className="followup-step-days-label">days</span>
              </div>
              <p className="followup-step-descriptor">
                {i === steps.length - 1
                  ? 'Final attempt'
                  : STEP_DESCRIPTORS[i] ?? 'Follow-up'}
              </p>
            </div>
          ))}
          {showAddRow ? (
            <div className="followup-step-cell followup-step-cell-add">
              <span className="followup-step-badge tier-add">
                <Plus className="lucide" aria-hidden="true" /> Add
              </span>
              <div className="followup-step-input-row">
                <input
                  type="number"
                  name="stepDays"
                  min={1}
                  max={365}
                  placeholder="7"
                  className="followup-step-input"
                />
                <span className="followup-step-days-label">days</span>
              </div>
              <p className="followup-step-descriptor">
                Enter days to append a new step
              </p>
            </div>
          ) : null}
        </div>
        <p className="config-row-sub" style={{ fontSize: '0.72rem' }}>
          <X className="lucide" aria-hidden="true" /> To remove a step, clear
          its &ldquo;days&rdquo; field before saving.
        </p>

        <div className="config-divider" />

        <div className="config-row">
          <div className="config-row-label">
            <p className="config-row-title">Require approval before send</p>
            <p className="config-row-sub">
              The worker composes via AI as usual but stages the email for
              human review. Approve, edit, or reject each one from{' '}
              <Link href="/communication/follow-ups">
                Communication → Follow-ups
              </Link>
              .
            </p>
          </div>
          <ToggleSwitch
            name="followUpRequireApproval"
            defaultChecked={followUpSettings.requireApproval}
          />
        </div>

        <div className="config-divider" />

        <details className="config-collapsible">
          <summary className="config-collapsible-summary">
            <Pencil className="lucide" aria-hidden="true" />
            <div>
              <p className="config-row-title">
                Custom AI instructions per step
              </p>
              <p className="config-row-sub">
                Override the default tone and content for each follow-up. Leave
                a field empty to use the default.
              </p>
            </div>
          </summary>
          <div className="config-collapsible-body">
            {steps.map((s, i) => (
              <div key={i} className="followup-instr-block">
                <label
                  className={`followup-step-badge tier-${tierColor(i)}`}
                  htmlFor={`step-instr-${i}`}
                >
                  Step {i + 1}
                </label>
                <textarea
                  id={`step-instr-${i}`}
                  name="stepInstr"
                  defaultValue={s.customInstructions}
                  placeholder={defaultInstr(i, steps.length)}
                  maxLength={2000}
                  rows={3}
                  className="followup-instr-textarea"
                />
              </div>
            ))}
          </div>
        </details>

        <div className="followup-info-amber">
          <AlertTriangle className="lucide" aria-hidden="true" />
          <div>
            <p className="config-row-title" style={{ color: 'oklch(0.85 0.13 75)' }}>
              How it works
            </p>
            <p className="config-row-sub">
              Each follow-up is uniquely generated by AI against the full
              conversation history. Tone escalates across steps: gentle
              reminder → value proposition → final attempt. With approval on,
              drafts go to your queue before sending.
            </p>
          </div>
        </div>

        <div className="config-card-actions">
          <button type="submit" className="primary-btn">
            Save follow-up settings
          </button>
          <Link href="/communication/follow-ups" className="ghost-btn">
            See live schedule →
          </Link>
        </div>
      </form>

      {/* ---------- Auto-sync card (P61-23) ---------- */}
      <form action={saveAutoSync} className="config-card">
        <header className="config-card-header">
          <RefreshCw className="config-card-icon" aria-hidden="true" />
          <div>
            <h2 className="config-card-title">Mailbox auto-sync</h2>
            <p className="config-card-desc">
              When on, the IMAP cron polls every active mailbox in this
              workspace on a 2-minute cadence (adaptive — slows to 15 min
              when nothing new arrives). When off, mailboxes never poll on
              their own and you pull new mail only via the{' '}
              <strong>Sync</strong> button in{' '}
              <Link href="/communication">Communication</Link>. The
              fail2ban-defense backoff still applies in both modes.
            </p>
          </div>
        </header>

        <label className="config-card-row">
          <span>Auto-sync</span>
          <ToggleSwitch
            name="imapAutoSyncEnabled"
            defaultChecked={ws.imapAutoSyncEnabled}
          />
        </label>

        <div className="config-card-actions">
          <button type="submit" className="primary-btn">
            Save auto-sync
          </button>
        </div>
      </form>

      {/* ---------- Mailbox retention card (P61-09) ---------- */}
      <form action={saveRetention} className="config-card">
        <header className="config-card-header">
          <Trash2 className="config-card-icon" aria-hidden="true" />
          <div>
            <h2 className="config-card-title">Mailbox retention</h2>
            <p className="config-card-desc">
              How long a message stays in <strong>Trash</strong> before the
              daily purge cron hard-deletes it. Set to 0 to disable the
              auto-purge — you can still empty trash manually from this
              page.
            </p>
          </div>
        </header>

        <label className="config-card-row">
          <span>Auto-purge trash after</span>
          <span className="config-card-inline">
            <input
              type="number"
              name="trashRetentionDays"
              min={TRASH_RETENTION_DAYS_MIN}
              max={TRASH_RETENTION_DAYS_MAX}
              step={1}
              defaultValue={ws.trashRetentionDays}
              style={{ width: '6rem' }}
            />
            <span className="muted small">days (0 = never)</span>
          </span>
        </label>

        <div className="config-card-actions">
          <button type="submit" className="primary-btn">
            Save retention
          </button>
          <ConfirmFormButton
            formAction={purgeNow}
            message="Empty the trash NOW? This permanently deletes every trashed message in this workspace."
            className="ghost-btn"
          >
            Empty trash now
          </ConfirmFormButton>
        </div>
      </form>
    </AppShell>
  );
}

function ToggleSwitch({
  name,
  defaultChecked,
}: Readonly<{ name: string; defaultChecked: boolean }>) {
  return (
    <label className="config-switch">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="config-switch-input"
      />
      <span className="config-switch-track">
        <span className="config-switch-thumb" />
      </span>
    </label>
  );
}

function tierColor(index: number): 'g' | 'a' | 'r' | 'b' {
  if (index === 0) return 'g';
  if (index === 1) return 'a';
  if (index === 2) return 'r';
  return 'b';
}

function defaultInstr(index: number, total: number): string {
  if (index === total - 1) {
    return "Final attempt — extremely brief, mention you won't follow up again, keep it respectful, leave the door open.";
  }
  if (index === 0) {
    return 'Gentle reminder — reference original email, add a new angle or benefit, mention a specific use case.';
  }
  if (index === 1) {
    return 'Value proposition — be brief, offer to close the loop, suggest a specific next step (call, meeting).';
  }
  return 'Polite nudge — keep it short, restate the value, propose a tiny next step.';
}
