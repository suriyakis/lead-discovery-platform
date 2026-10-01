// ia:F-03: the "Reply auto-actions" card on /settings/outreach.
//
// Presentational server component: the page loads the switches and the
// 30-day impact and passes the save action for admins. Without `action`
// the card renders read-only (managers, members, viewers see what runs
// automatically but cannot change it — the service refuses non-admins
// anyway).

import Link from 'next/link';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import type {
  ReplyAutoActionKey,
  ReplyAutoActionSwitches,
  ReplyAutoActionsImpact,
} from '@/lib/services/reply-auto-actions';

const ROWS: ReadonlyArray<{ key: ReplyAutoActionKey; title: string; sub: string }> = [
  {
    key: 'autoSuppressUnsubscribe',
    title: 'Suppress the sender on an unsubscribe reply',
    sub:
      'When an inbound message is classified as an unsubscribe request, add its sender to the suppression list and close their lead. People who click the unsubscribe link in your emails are always suppressed, whatever this says.',
  },
  {
    key: 'autoSuppressBounce',
    title: 'Suppress the sender on a bounce',
    sub:
      'When an inbound message is classified as a bounce, add its sender to the suppression list and close the lead. Recipients your mail server rejects while sending are handled separately.',
  },
  {
    key: 'autoCloseNegative',
    title: 'Close the lead on a negative reply',
    sub:
      'When a reply is classified as not interested, close the lead as lost. Off: the lead stays open so you can answer by hand.',
  },
  {
    key: 'autoExtractRedirects',
    title: 'Create contacts from redirect replies',
    sub:
      'When a reply points you to someone else (“please contact …”), add the email addresses it mentions as contacts on the thread.',
  },
];

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ReplyAutoActionsCard({
  switches,
  impact,
  action,
}: Readonly<{
  switches: ReplyAutoActionSwitches;
  impact: ReplyAutoActionsImpact;
  /** Save action (admins). Omit to render the card read-only. */
  action?: (formData: FormData) => Promise<void>;
}>) {
  const readOnly = !action;
  const suppressing = switches.autoSuppressUnsubscribe || switches.autoSuppressBounce;
  const acted = impact.suppressedAddresses > 0 || impact.closedLeads > 0;

  const body = (
    <>
      <header className="config-card-header">
        <ShieldAlert className="config-card-icon" aria-hidden="true" />
        <div>
          <h2 className="config-card-title">Reply auto-actions</h2>
          <p className="config-card-desc">
            What happens on its own when an inbound message is classified. With a
            switch off the message is still classified and shown to you; you decide
            what to do.
          </p>
        </div>
      </header>

      {suppressing ? (
        <div className="config-callout config-callout-warn">
          <AlertTriangle className="lucide" aria-hidden="true" />
          <div>
            <p className="config-row-title">Automatic suppression is on</p>
            <p className="config-row-sub" data-testid="reply-auto-actions-warning">
              Automatic suppression currently acts on every synced email, not only
              replies to your outreach;{' '}
              <strong>{plural(impact.suppressedAddresses, 'address was', 'addresses were')}</strong>{' '}
              suppressed this way in the last {impact.windowDays} days
              {impact.suppressedAddresses > 0
                ? ` (${impact.stillSuppressed} still suppressed)`
                : ''}
              .
              {impact.closedLeads > 0
                ? ` ${plural(impact.closedLeads, 'lead was', 'leads were')} closed automatically.`
                : ''}{' '}
              <Link href="/mailbox/suppression">Review the suppression list</Link>
            </p>
          </div>
        </div>
      ) : acted ? (
        <div className="config-callout" data-testid="reply-auto-actions-impact">
          <Info className="lucide" aria-hidden="true" />
          <p className="config-row-sub">
            In the last {impact.windowDays} days, reply auto-actions suppressed{' '}
            {plural(impact.suppressedAddresses, 'address', 'addresses')}
            {impact.suppressedAddresses > 0
              ? ` (${impact.stillSuppressed} still suppressed)`
              : ''}{' '}
            and closed {plural(impact.closedLeads, 'lead', 'leads')}.{' '}
            <Link href="/mailbox/suppression">Review the suppression list</Link>
          </p>
        </div>
      ) : null}

      {ROWS.map((row, i) => (
        <div key={row.key}>
          {i > 0 ? <div className="config-divider" /> : null}
          <div className="config-row">
            <div className="config-row-label">
              <p className="config-row-title" id={`reply-auto-${row.key}`}>
                {row.title}
              </p>
              <p className="config-row-sub">{row.sub}</p>
            </div>
            <label className="config-switch">
              <input
                type="checkbox"
                name={row.key}
                defaultChecked={switches[row.key]}
                disabled={readOnly}
                aria-labelledby={`reply-auto-${row.key}`}
                className="config-switch-input"
              />
              <span className="config-switch-track">
                <span className="config-switch-thumb" />
              </span>
            </label>
          </div>
        </div>
      ))}

      {readOnly ? (
        <p className="config-row-sub">Only workspace admins can change these.</p>
      ) : (
        <div className="config-card-actions">
          <button type="submit" className="primary-btn">
            Save reply auto-actions
          </button>
        </div>
      )}
    </>
  );

  return readOnly ? (
    <section className="config-card" aria-label="Reply auto-actions">
      {body}
    </section>
  ) : (
    <form action={action} className="config-card" aria-label="Reply auto-actions">
      {body}
    </form>
  );
}
