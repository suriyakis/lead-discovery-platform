import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  AlertTriangle,
  Languages,
  Mail,
  MessageSquareReply,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
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
  getWorkspaceNativeLanguage,
  getWorkspaceOutreachLanguage,
  updateOutreachDefaults,
  updateWorkspaceNativeLanguage,
  updateWorkspaceOutreachLanguage,
} from '@/lib/services/workspace';
import { ENABLED_LANGUAGE_OPTIONS } from '@/lib/i18n/language';
import { loadSettings as loadFollowUpSettings } from '@/lib/services/follow-up';
import { saveFollowUp } from './follow-up-actions';
import {
  FOLLOW_UP_MAX_DAYS,
  FOLLOW_UP_MAX_INSTRUCTIONS,
  FOLLOW_UP_MAX_STEPS,
  STEP_REMOVE_FIELD,
  stepDaysField,
  stepInstrField,
} from './follow-up-form';
import {
  TRASH_RETENTION_DAYS_MAX,
  TRASH_RETENTION_DAYS_MIN,
  emptyTrashNow,
  updateImapAutoSync,
  updateTrashRetentionDays,
} from '@/lib/services/mail';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  getReplyAutoActions,
  getReplyAutoActionsImpact,
  switchesOf,
} from '@/lib/services/reply-auto-actions';
import { ReplyAutoActionsCard } from './ReplyAutoActionsCard';
import { saveReplyAutoActions } from './actions';
import { NoWorkspaceState } from '@/components/NoWorkspaceState';

const STEP_DESCRIPTORS = [
  'Gentle reminder',
  'Value proposition',
  // Only the last step is the final attempt (rendered separately); a
  // non-final step 3 gets the "polite nudge" framing its placeholder uses.
  'Polite nudge',
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
    if (err instanceof NoWorkspaceError) return <NoWorkspaceState />;
    throw err;
  }
  // ia:F-03: everyone in the workspace can see what runs automatically on
  // inbound mail; only admins can change it.
  const replyAutoActions = switchesOf(await getReplyAutoActions(ctx));
  const replyAutoActionsImpact = await getReplyAutoActionsImpact(ctx);

  if (!canAdminWorkspace(ctx)) {
    return (
      <>
        <p className="muted">
          <Link href="/today">Today</Link> /{' '}
          <Link href="/settings/integrations">Settings</Link> / Outreach
        </p>
        <h1 className="page-title">Outreach configuration</h1>
        <p className="page-lede">
          Only workspace admins can change outreach settings. The reply
          auto-actions are shown read-only so you can see what happens
          automatically to inbound mail.
        </p>
        {sp.error ? <p className="form-error">{sp.error}</p> : null}
        <ReplyAutoActionsCard
          switches={replyAutoActions}
          impact={replyAutoActionsImpact}
        />
      </>
    );
  }

  const followUpSettings = await loadFollowUpSettings(ctx.workspaceId);
  const nativeLanguage = await getWorkspaceNativeLanguage(ctx);
  const outreachLanguage = await getWorkspaceOutreachLanguage(ctx);

  async function saveNativeLanguage(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const lang = String(formData.get('nativeLanguage') ?? '');
    try {
      const stored = await updateWorkspaceNativeLanguage(c, lang);
      redirect(
        '/settings/outreach?message=' +
          encodeURIComponent(`Native language set — replies and references now use it (${stored}).`),
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof WorkspaceServiceError ? err.message : 'failed';
      redirect(`/settings/outreach?error=${encodeURIComponent(m)}`);
    }
  }

  async function saveOutreachLanguage(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const lang = String(formData.get('outreachLanguage') ?? '');
    try {
      const stored = await updateWorkspaceOutreachLanguage(c, lang);
      redirect(
        '/settings/outreach?message=' +
          encodeURIComponent(
            stored
              ? `Default outreach language set to ${stored} — leads are emailed in it unless a recipe or lead overrides.`
              : 'Default outreach language cleared — language now follows the recipe / product of each lead.',
          ),
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof WorkspaceServiceError ? err.message : 'failed';
      redirect(`/settings/outreach?error=${encodeURIComponent(m)}`);
    }
  }

  async function saveReply(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const autoDraftReplies = formData.get('autoDraftReplies') === 'on';
    try {
      await updateOutreachDefaults(c, { autoDraftReplies });
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

  const steps = followUpSettings.steps;
  const showAddRow = steps.length < FOLLOW_UP_MAX_STEPS;

  return (
    <>
      <p className="muted">
        <Link href="/today">Today</Link> /{' '}
        <Link href="/settings/integrations">Settings</Link> / Outreach
      </p>
      <h1 className="page-title">Outreach configuration</h1>
      <p className="page-lede">
        How this workspace handles automatic follow-ups and inbound replies on
        outreach threads. All flags are workspace-scoped.
      </p>

      {sp.message ? <p className="form-info">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      {/* ---------- Native language card (Phase 63) ---------- */}
      <form action={saveNativeLanguage} className="config-card">
        <header className="config-card-header">
          <Languages className="config-card-icon" aria-hidden="true" />
          <div>
            <h2 className="config-card-title">Native language</h2>
            <p className="config-card-desc">
              The language your team reads in. Outreach is drafted in this
              language for you to review; on send it is translated to each
              recipient&rsquo;s language and both versions are kept. Inbound
              replies are translated into this language too.
            </p>
          </div>
        </header>

        <Field label="Workspace native language" layout="inline">
          <Select name="nativeLanguage" defaultValue={nativeLanguage}>
            {ENABLED_LANGUAGE_OPTIONS.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="config-card-actions">
          <button type="submit" className="primary-btn">
            Save native language
          </button>
        </div>
      </form>

      {/* ---------- Outreach (communication) language card ---------- */}
      <form action={saveOutreachLanguage} className="config-card">
        <header className="config-card-header">
          <Languages className="config-card-icon" aria-hidden="true" />
          <div>
            <h2 className="config-card-title">Default outreach language</h2>
            <p className="config-card-desc">
              The language leads are emailed in by default. Leave on{' '}
              <strong>Auto</strong> to let each lead&rsquo;s discovery recipe (or
              product) decide. A discovery recipe&rsquo;s own{' '}
              <strong>Language</strong> field (Connectors → recipe) — which also
              sets the language we <em>search</em> in — overrides this, as does a
              per-lead language on the lead page.
            </p>
          </div>
        </header>

        <Field label="Default outreach language" layout="inline">
          <Select name="outreachLanguage" defaultValue={outreachLanguage ?? ''}>
            <option value="">Auto (follow recipe / product)</option>
            {ENABLED_LANGUAGE_OPTIONS.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="config-card-actions">
          <button type="submit" className="primary-btn">
            Save outreach language
          </button>
        </div>
      </form>

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

        <Switch
          name="autoDraftReplies"
          label="Auto-draft replies"
          description="AI writes the next reply on lead threads for your review. A reply draft is never sent on its own: you approve each one. Recommended: on."
          position="end"
          defaultChecked={ws.autoDraftReplies}
        />

        <div className="config-card-actions">
          <button type="submit" className="primary-btn">Save reply settings</button>
        </div>
      </form>

      {/* ---------- Reply auto-actions card (ia:F-03) ---------- */}
      <ReplyAutoActionsCard
        switches={replyAutoActions}
        impact={replyAutoActionsImpact}
        action={saveReplyAutoActions}
      />

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

        <Switch
          name="followUpEnabled"
          label="Follow-ups enabled"
          description="When off, no new schedules are created."
          position="end"
          defaultChecked={followUpSettings.enabled}
        />

        <div className="config-divider" />

        <p className="config-eyebrow">Follow-up steps</p>
        <p className="config-row-sub" style={{ marginTop: 0 }}>
          Days after the previous step (step 1 counts from the first outbound).
          The last step gets a &ldquo;this is the final email&rdquo; framing
          automatically. Each step can carry its own AI instructions; leave
          them empty to use the default tone.
        </p>
        {/* One card per step: its days, its AI instructions and its Remove
            box travel together (stepDays.N / stepInstr.N / stepRemove=N,
            parsed by ./follow-up-form.ts), so removing step 2 keeps every
            other step's instructions on that step (I114). */}
        <div className="followup-step-list">
          {steps.map((s, i) => (
            <div
              className="followup-step-card"
              key={i}
              role="group"
              aria-label={`Step ${i + 1}`}
            >
              <div className="followup-step-card-head">
                <span className={`followup-step-badge tier-${tierColor(i)}`}>
                  Step {i + 1}
                </span>
                <span className="followup-step-descriptor">
                  {i === steps.length - 1
                    ? 'Final attempt'
                    : STEP_DESCRIPTORS[i] ?? 'Follow-up'}
                </span>
                <label className="followup-step-remove">
                  <input
                    type="checkbox"
                    name={STEP_REMOVE_FIELD}
                    value={i}
                    data-tone="danger"
                  />
                  <Trash2 className="lucide" aria-hidden="true" /> Remove
                </label>
              </div>
              <label className="followup-step-input-row">
                <Input
                  type="number"
                  name={stepDaysField(i)}
                  min={1}
                  max={FOLLOW_UP_MAX_DAYS}
                  step={1}
                  defaultValue={s.daysAfterPrev}
                  className="followup-step-input"
                />
                <span className="followup-step-days-label">
                  days after {i === 0 ? 'the first email' : `step ${i}`}
                </span>
              </label>
              <details className="followup-step-instr" open={s.customInstructions !== ''}>
                <summary>AI instructions for step {i + 1}</summary>
                <Textarea
                  name={stepInstrField(i)}
                  defaultValue={s.customInstructions}
                  placeholder={defaultInstr(i, steps.length)}
                  maxLength={FOLLOW_UP_MAX_INSTRUCTIONS}
                  rows={3}
                  aria-label={`AI instructions for step ${i + 1}`}
                  className="followup-instr-textarea"
                />
              </details>
              <p className="followup-step-removed-note">
                Removed when you save. Untick to keep it.
              </p>
            </div>
          ))}
          {showAddRow ? (
            <div
              className="followup-step-card followup-step-card-add"
              role="group"
              aria-label="Add a step"
            >
              <div className="followup-step-card-head">
                <span className="followup-step-badge tier-add">
                  <Plus className="lucide" aria-hidden="true" /> Step {steps.length + 1}
                </span>
                <span className="followup-step-descriptor">
                  Optional: fill in the days to add a step at the end
                </span>
              </div>
              <label className="followup-step-input-row">
                <Input
                  type="number"
                  name={stepDaysField(steps.length)}
                  min={1}
                  max={FOLLOW_UP_MAX_DAYS}
                  step={1}
                  placeholder="7"
                  className="followup-step-input"
                />
                <span className="followup-step-days-label">
                  days after {steps.length === 0 ? 'the first email' : `step ${steps.length}`}
                </span>
              </label>
              <details className="followup-step-instr">
                <summary>AI instructions for the new step</summary>
                <Textarea
                  name={stepInstrField(steps.length)}
                  placeholder="Optional. Leave empty to use the default tone."
                  maxLength={FOLLOW_UP_MAX_INSTRUCTIONS}
                  rows={3}
                  aria-label="AI instructions for the new step"
                  className="followup-instr-textarea"
                />
              </details>
            </div>
          ) : null}
        </div>
        <p className="config-row-sub">
          Tick <strong>Remove</strong> on a step and save to delete it. The
          steps after it move up and keep their own instructions.
        </p>

        <div className="config-divider" />

        {/* The description holds a link, so it sits outside the label
            (a link inside a label is a nested interactive element);
            aria-describedby still reads it with the switch. */}
        <div>
          <Switch
            name="followUpRequireApproval"
            label="Require approval before send"
            position="end"
            defaultChecked={followUpSettings.requireApproval}
            aria-describedby="followup-require-approval-help"
          />
          <p className="config-row-sub" id="followup-require-approval-help">
            The worker composes via AI as usual but stages the email for
            human review. Approve, edit, or reject each one from{' '}
            <Link href="/communication/follow-ups">
              Communication → Follow-ups
            </Link>
            .
          </p>
        </div>

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

        <Switch
          name="imapAutoSyncEnabled"
          label="Auto-sync"
          position="end"
          defaultChecked={ws.imapAutoSyncEnabled}
        />

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

        <Field
          label="Auto-purge trash after (days)"
          hint="0 turns the automatic purge off."
          width="num"
        >
          <Input
            type="number"
            name="trashRetentionDays"
            min={TRASH_RETENTION_DAYS_MIN}
            max={TRASH_RETENTION_DAYS_MAX}
            step={1}
            defaultValue={ws.trashRetentionDays}
          />
        </Field>

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
    </>
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
