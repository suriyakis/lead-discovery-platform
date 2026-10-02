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
import { Switch } from '@/components/ui';
import { ExpectedWorkspaceField } from '@/components/WorkspaceGuard';

const ROWS: ReadonlyArray<{ key: ReplyAutoActionKey; title: string; sub: string }> = [
  {
    key: 'autoSuppressUnsubscribe',
    title: 'Suppress the sender on an unsubscribe reply',
    sub:
      'When a reply to one of your emails asks to unsubscribe, add its sender to the suppression list and close their lead. Newsletters and other mail that is not a reply to you never trigger this. People who unsubscribe with the link in your outreach emails (and confirm on its page) are always suppressed, whatever this says.',
  },
  {
    key: 'autoSuppressBounce',
    title: 'Suppress the sender on a bounce',
    sub:
      'Not active yet: bounce reports are recorded on the conversation, but nobody is suppressed or closed automatically until bounces can be matched reliably to the email you sent. Recipients your mail server rejects while sending are handled separately.',
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
  // Bounce auto-suppression is inert until F-32, so only the unsubscribe
  // switch can suppress anyone today.
  const suppressing = switches.autoSuppressUnsubscribe;
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
              It acts only on replies to emails you sent, never on newsletters or
              other incoming mail;{' '}
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
          {/* DS-10: a labelled switch; the title names it, the text describes it. */}
          <Switch
            name={row.key}
            label={row.title}
            description={row.sub}
            position="end"
            defaultChecked={switches[row.key]}
            disabled={readOnly}
          />
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
      {/* MOB-06: the save action is guarded; post the page's workspace. */}
      <ExpectedWorkspaceField />
      {body}
    </form>
  );
}
