// PC-06 + PC-05: the shell banners every member of a workspace sees while
// its work is stopped or held: the workspace pause (who paused, when and
// why), the platform-wide outbound stop, each enforced hold (with who
// placed it and why), a missing accountable owner, and the go-live hold
// (flow:F-07). Built on the Alert primitive — the existing shell banner
// element, no new CSS. Server component; renders nothing when there is
// nothing to say.

import { Alert } from './Alert';
import { formatUtc } from '@/lib/format-utc';
import { describeHoldScope, type WorkspaceAutomationNotice } from '@/lib/services/automation-gate';

export function hasAutomationNotice(notice: WorkspaceAutomationNotice): boolean {
  return Boolean(
    notice.pause ||
      notice.platformOutboundStop ||
      notice.holds.length > 0 ||
      notice.ownerProblemMessage ||
      notice.notLive,
  );
}

function hasHoldNotice(notice: WorkspaceAutomationNotice): boolean {
  return Boolean(
    notice.platformOutboundStop || notice.holds.length > 0 || notice.ownerProblemMessage,
  );
}

export function AutomationHoldBanner({ notice }: Readonly<{ notice: WorkspaceAutomationNotice }>) {
  if (!hasAutomationNotice(notice)) return null;
  const platformHeld =
    Boolean(notice.platformOutboundStop) || notice.holds.some((h) => h.source === 'platform');
  return (
    <>
      {notice.pause ? (
        <Alert
          tone="warning"
          title="Automation is paused"
          action={
            <a href="/autopilot#pause" className="ghost-btn">
              Pause and resume
            </a>
          }
        >
          <p>
            Nothing is sent, composed or run automatically — the send queue, follow-ups,
            autopilot, scheduled crawls, reply auto-actions and background AI all wait. Replies
            keep arriving. Paused {notice.pause.byLabel ? `by ${notice.pause.byLabel} ` : ''}
            on {formatUtc(notice.pause.since)}
            {notice.pause.reason ? `. Reason: ${notice.pause.reason}` : ''}. An owner or admin
            resumes it.
          </p>
        </Alert>
      ) : null}
      {hasHoldNotice(notice) ? (
        <Alert
          tone={platformHeld ? 'danger' : 'warning'}
          title={platformHeld ? 'Held by the platform' : 'Work in this workspace is on hold'}
        >
          {notice.platformOutboundStop ? (
            <p>
              <strong>Outbound email</strong> is stopped for every workspace by the platform:
              nothing is sent, manually or automatically, until it is lifted. Reason:{' '}
              {notice.platformOutboundStop.reason}
            </p>
          ) : null}
          {notice.holds.map((h) => (
            <p key={h.id.toString()}>
              <strong>{describeHoldScope(h)}</strong> on hold
              {h.source === 'platform' ? ' (placed by the platform; only it can release this)' : ''}
              {h.expiresAt ? ` until ${formatUtc(h.expiresAt)}` : ''}. Reason: {h.reason}
            </p>
          ))}
          {notice.ownerProblemMessage ? <p>{notice.ownerProblemMessage}</p> : null}
        </Alert>
      ) : null}
      {notice.notLive ? (
        <Alert tone="info" title="Not live for outreach yet">
          <p>
            Cold emails, follow-ups and AI reply drafts wait in the send queue — not sent, not
            failed — until the platform releases this workspace for outreach. Email you write
            yourself sends normally.
          </p>
        </Alert>
      ) : null}
    </>
  );
}
