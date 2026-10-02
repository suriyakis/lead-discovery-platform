// PC-08: the "Owner alerts" section of the platform console's settings
// page (/admin/providers). Read-only status of the ntfy sink, which the
// server environment configures, plus "Send test alert".
//
// It renders ONLY an OwnerAlertStatus (services/ops-alerts.ts), which
// carries neither the ntfy topic nor the access token: on ntfy.sh the
// topic name is the password, so the page shows that it is set and its
// length, never its value. Server component: no client JS.

import { BellRing } from 'lucide-react';
import { formatUtc } from '@/lib/format-utc';
import type { OwnerAlertStatus } from '@/lib/services/ops-alerts';
import { TableScroll } from './TableScroll';

const KIND_LABELS: Record<string, string> = {
  incident: 'incident',
  digest: 'digest (burst)',
  daily_digest: 'daily digest',
  control: 'stop / hold change',
  test: 'test',
};

export function OwnerAlertsPanel({
  status,
  sendTestAction,
}: Readonly<{
  status: OwnerAlertStatus;
  sendTestAction: () => Promise<void>;
}>) {
  const { config, rules, history } = status;
  return (
    <section id="owner-alerts">
      <h2>
        <BellRing className="lucide" aria-hidden="true" /> Owner alerts
      </h2>
      <p className="muted small">
        Pushed to an ntfy topic: incidents of severity <code>{config.minSeverity}</code> and above,
        background ticks that stop running (seen stale on two checks a minute apart), and platform
        stop and hold changes. One alert per incident, a reminder every {rules.reAlertHours} h while
        it stays open, more than {rules.digestThreshold} at once folded into one message, at most{' '}
        {rules.budgetPerHour} messages an hour, and a digest of what is still open at{' '}
        {String(rules.dailyDigestHourUtc).padStart(2, '0')}:00 UTC. Configured in the server
        environment (<code>NTFY_TOPIC</code>, <code>NTFY_URL</code>, <code>NTFY_TOKEN</code>,{' '}
        <code>OPS_ALERT_MIN_SEVERITY</code>); the topic and the token are never shown here.
      </p>
      <TableScroll label="Owner alert configuration">
        <table className="data-table">
          <tbody>
            <tr>
              <th scope="row">Status</th>
              <td>
                <span className={config.enabled ? 'badge badge-good' : 'badge badge-bad'}>
                  {config.enabled ? 'on' : 'off'}
                </span>
                {config.disabledReason ? (
                  <span className="muted small"> {config.disabledReason}</span>
                ) : null}
              </td>
            </tr>
            <tr>
              <th scope="row">Server</th>
              <td>
                {config.server ? <code>{config.server}</code> : <span className="muted">—</span>}
              </td>
            </tr>
            <tr>
              <th scope="row">Topic</th>
              <td>
                {config.topicSet ? `set (${config.topicLength} characters, hidden)` : 'not set'}
              </td>
            </tr>
            <tr>
              <th scope="row">Access token</th>
              <td>{config.tokenSet ? 'set (hidden)' : 'not set'}</td>
            </tr>
            <tr>
              <th scope="row">Minimum severity</th>
              <td>
                <code>{config.minSeverity}</code>
                {config.minSeverityIgnored ? (
                  <span className="muted small">
                    {' '}
                    OPS_ALERT_MIN_SEVERITY was not recognised; the default applies.
                  </span>
                ) : null}
              </td>
            </tr>
            <tr>
              <th scope="row">Sent in the last hour</th>
              <td>{history ? `${history.sentLastHour} of ${rules.budgetPerHour}` : 'unknown'}</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>
      <form action={sendTestAction} className="action-row">
        <button type="submit" className="ghost-btn" disabled={!config.enabled}>
          Send test alert
        </button>
        <span className="muted small">
          Sends one message to the configured topic now and records it below.
        </span>
      </form>
      {history === null ? (
        <p className="muted small">The alert log could not be read.</p>
      ) : history.recent.length === 0 ? (
        <p className="muted small">No alert has been sent yet.</p>
      ) : (
        <TableScroll label="Recent owner alerts">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Alert</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {history.recent.map((r) => (
                <tr key={r.id}>
                  <td className="muted small">{formatUtc(r.createdAt)}</td>
                  <td>{KIND_LABELS[r.kind] ?? r.kind}</td>
                  <td>{r.title}</td>
                  <td>
                    <span className={r.status === 'sent' ? 'badge badge-good' : 'badge badge-bad'}>
                      {r.status}
                    </span>
                    {r.error ? <span className="muted small"> {r.error}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}
