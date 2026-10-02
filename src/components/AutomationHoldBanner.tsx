// PC-06: the shell banner every member of a workspace sees while its work
// is held: the platform-wide outbound stop, each enforced hold (with who
// placed it and why), and a missing accountable owner. Built on the Alert
// primitive — no new CSS. Server component; renders nothing when there is
// nothing to say.

import { Alert } from './Alert';
import { formatUtc } from '@/lib/format-utc';
import { describeHoldScope, type WorkspaceAutomationNotice } from '@/lib/services/automation-gate';

export function hasAutomationNotice(notice: WorkspaceAutomationNotice): boolean {
  return Boolean(
    notice.platformOutboundStop || notice.holds.length > 0 || notice.ownerProblemMessage,
  );
}

export function AutomationHoldBanner({ notice }: Readonly<{ notice: WorkspaceAutomationNotice }>) {
  if (!hasAutomationNotice(notice)) return null;
  const platformHeld =
    Boolean(notice.platformOutboundStop) || notice.holds.some((h) => h.source === 'platform');
  return (
    <Alert
      tone={platformHeld ? 'danger' : 'warning'}
      title={platformHeld ? 'Held by the platform' : 'Work in this workspace is on hold'}
    >
      {notice.platformOutboundStop ? (
        <p>
          <strong>Outbound email</strong> is stopped for every workspace by the platform: nothing is
          sent, manually or automatically, until it is lifted. Reason:{' '}
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
  );
}
