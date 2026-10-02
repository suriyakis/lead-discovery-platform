// PC-05 Wave 1: the workspace pause control. It replaces the two old
// "Emergency pause (kill switch)" checkboxes (/autopilot and
// /mailbox/queue), which wrote two unrelated flags that each stopped only
// part of the work (I004, I046). One pause now stops every kind of
// automatic work; inbox sync keeps reading.
//
// Pause: any write role, a standalone action never tied to a settings
// form, so a lapsed plan can always stop automation (I063); no confirm —
// the person who paused can Undo for 10 seconds. Resume: owners and
// admins, after a confirm that lists what starts again.
//
// Server component built from existing classes only (no new CSS); the
// full status pill / bottom sheet is MOB-07 / PC-15.
//
// MOB-06: all three actions are guarded; each form carries the page's
// workspace, so a tab left open on another workspace cannot pause, undo or
// resume this one (it answers workspace_changed).

import { ConfirmFormButton } from './ConfirmFormButton';
import { Alert } from './Alert';
import { ExpectedWorkspaceField } from './WorkspaceGuard';
import { formatUtc } from '@/lib/format-utc';
import { resumeAutomationConfirm } from '@/lib/confirm-copy';
import { PAUSE_REASON_MAX, type AutomationPauseOverview } from '@/lib/services/automation-pause';
import type { PauseControlPage } from '@/lib/automation-pause-form';
import {
  pauseAutomationAction,
  resumeAutomationAction,
  undoPauseAction,
} from '@/lib/automation-pause-actions';

function n(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function AutomationPauseControl({
  overview,
  returnTo,
}: Readonly<{ overview: AutomationPauseOverview; returnTo: PauseControlPage }>) {
  const { pause, impact } = overview;
  return (
    <section id="pause" aria-labelledby="pause-heading">
      <h2 id="pause-heading">{pause ? 'Automation is paused' : 'Pause all automation'}</h2>
      {pause ? (
        <>
          <Alert tone="warning" title="Nothing runs automatically">
            <p>
              Paused {pause.byLabel ? `by ${pause.byLabel} ` : ''}on {formatUtc(pause.since)}
              {pause.reason ? `. Reason: ${pause.reason}` : ''}. The send queue, follow-ups,
              autopilot, scheduled crawls, reply auto-actions, background AI, auto top-up and
              the trash purge all wait. Replies keep arriving. Email you write yourself sends
              after you confirm &ldquo;send anyway&rdquo;.
            </p>
          </Alert>
          {overview.undoUntil ? (
            <form action={undoPauseAction} className="action-row">
              <input type="hidden" name="returnTo" value={returnTo} />
              <ExpectedWorkspaceField />
              <button type="submit" className="ghost-btn">
                Undo pause
              </button>
              <span className="muted small">
                You paused it just now — undo until {formatUtc(overview.undoUntil)}.
              </span>
            </form>
          ) : null}
          <p className="muted">
            Waiting: {n(impact.queued, 'queued email')}
            {impact.queued > 0
              ? ` (${impact.queuedDue} already due${
                  impact.nextSendAt ? `, next ${formatUtc(impact.nextSendAt)}` : ''
                })`
              : ''}
            , {n(impact.pendingFollowUps, 'pending follow-up')},{' '}
            {n(impact.enabledCrawlPlans, 'scheduled crawl plan')}
            {impact.heldInboundActions > 0
              ? `, ${n(impact.heldInboundActions, 'reply auto-action')} held while paused (not applied on resume — check those replies yourself)`
              : ''}
            .
          </p>
          {overview.canResume ? (
            <form action={resumeAutomationAction} className="inline-form">
              <input type="hidden" name="returnTo" value={returnTo} />
              <ExpectedWorkspaceField />
              <label>
                <span>Reason (optional)</span>
                <input type="text" name="reason" maxLength={PAUSE_REASON_MAX} />
              </label>
              <ConfirmFormButton
                className="primary-btn"
                message={resumeAutomationConfirm({
                  ...impact,
                  nextSendAt: impact.nextSendAt ? formatUtc(impact.nextSendAt) : null,
                })}
              >
                Resume automation
              </ConfirmFormButton>
            </form>
          ) : (
            <p className="muted">Only owners and admins can resume automation.</p>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            One switch for the whole workspace. It stops at once, at the next item, everything
            that runs on its own: the send queue ({n(impact.queued, 'queued email')}), follow-ups (
            {n(impact.pendingFollowUps, 'pending step')}), autopilot (
            {impact.autopilotEnabled ? 'on' : 'off'}), scheduled crawls (
            {n(impact.enabledCrawlPlans, 'enabled plan')}), reply auto-actions, background AI,
            auto top-up and the trash purge. Nothing is lost or failed — it waits. Inbox sync
            keeps reading replies, and you can still send an email yourself after confirming
            &ldquo;send anyway&rdquo;. Anyone who can edit can pause; owners and admins resume.
          </p>
          {overview.canPause ? (
            <form action={pauseAutomationAction} className="inline-form">
              <input type="hidden" name="returnTo" value={returnTo} />
              <ExpectedWorkspaceField />
              <label>
                <span>Reason (optional)</span>
                <input type="text" name="reason" maxLength={PAUSE_REASON_MAX} />
              </label>
              <button type="submit" className="primary-btn">
                Pause all automation
              </button>
            </form>
          ) : (
            <p className="muted">Your role can see this but not pause.</p>
          )}
        </>
      )}
    </section>
  );
}
