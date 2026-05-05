import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  AlertTriangle,
  Eye,
  Mail,
  MailWarning,
  MessageSquare,
  Send,
  ShieldOff,
  XOctagon,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  getDeliverabilityReport,
  type DeliverabilityReport,
} from '@/lib/services/deliverability';

const WINDOW_OPTIONS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

const fmtPct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const fmt = (n: number): string => n.toLocaleString('en-US');

export default async function DeliverabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;
  const requestedDays = Number(sp.days ?? '30');
  const validOption = WINDOW_OPTIONS.find((o) => o.days === requestedDays);
  const days = validOption ? validOption.days : 30;

  let report: DeliverabilityReport;
  try {
    const ctx = await getWorkspaceContext();
    report = await getDeliverabilityReport(ctx, { sinceDays: days });
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }

  const { totals, byMailbox, replyClassifications } = report;
  const totalReplies = replyClassifications.reduce((a, c) => a + c.count, 0);

  return (
    <AppShell>
      <div className="dashboard-wrap">
        <header className="page-intro">
          <p className="page-eyebrow">Mailbox health</p>
          <h1 className="page-title">Deliverability</h1>
          <p className="page-lede">
            How outbound mail is performing per mailbox: opens, bounces,
            replies, unsubscribes, and queue health. Window:{' '}
            <strong>
              {report.windowStart.toLocaleDateString()} —{' '}
              {report.windowEnd.toLocaleDateString()}
            </strong>
            .
          </p>
        </header>

        <div className="window-tabs">
          {WINDOW_OPTIONS.map((o) => {
            const active = o.days === days;
            return (
              <Link
                key={o.days}
                href={`/mailbox/deliverability?days=${o.days}`}
                className={active ? 'window-tab active' : 'window-tab'}
              >
                {o.label}
              </Link>
            );
          })}
        </div>

        <section className="metric-grid">
          <MetricCard
            icon={Send}
            label="Sent"
            value={fmt(totals.sent)}
            tone="primary"
          />
          <MetricCard
            icon={Eye}
            label="Opens"
            value={fmt(totals.opened)}
            sub={
              totals.sent > 0
                ? `${fmtPct(totals.opened / totals.sent)} of sent`
                : undefined
            }
            tone="teal"
          />
          <MetricCard
            icon={MessageSquare}
            label="Replies"
            value={fmt(totals.replied)}
            sub={
              totals.sent > 0
                ? `${fmtPct(totals.replied / totals.sent)} of sent`
                : undefined
            }
            tone="violet"
          />
          <MetricCard
            icon={MailWarning}
            label="Bounced"
            value={fmt(totals.bounced)}
            sub={
              totals.sent > 0
                ? `${fmtPct(totals.bounced / totals.sent)} of sent`
                : undefined
            }
            tone={totals.bounced > 0 ? 'warn' : 'muted'}
          />
          <MetricCard
            icon={XOctagon}
            label="Failed"
            value={fmt(totals.failed)}
            tone={totals.failed > 0 ? 'warn' : 'muted'}
          />
          <MetricCard
            icon={ShieldOff}
            label="Unsubscribed"
            value={fmt(totals.unsubscribed)}
            tone="muted"
          />
          <MetricCard
            icon={AlertTriangle}
            label="Queue skipped"
            value={fmt(totals.queueSkipped)}
            tone="muted"
          />
          <MetricCard
            icon={XOctagon}
            label="Queue failed"
            value={fmt(totals.queueFailed)}
            tone={totals.queueFailed > 0 ? 'warn' : 'muted'}
          />
        </section>

        <section>
          <div className="section-header">
            <h2 className="section-title">By mailbox</h2>
            <p className="section-sub">
              Most active first. Rates are computed against sent mail in the
              selected window.
            </p>
          </div>
          {byMailbox.length === 0 ? (
            <div className="empty-state">
              <Mail className="empty-state-icon" aria-hidden="true" />
              <p>
                No mailboxes configured yet. Connect one from the{' '}
                <Link href="/mailbox">Mailbox</Link> page to start sending.
              </p>
            </div>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Mailbox</th>
                    <th className="num">Sent</th>
                    <th className="num">Open</th>
                    <th className="num">Reply</th>
                    <th className="num">Bounced</th>
                    <th className="num">Failed</th>
                    <th className="num">Q sent</th>
                    <th className="num">Q skipped</th>
                    <th className="num">Q failed</th>
                  </tr>
                </thead>
                <tbody>
                  {byMailbox.map((m) => (
                    <tr key={m.mailboxId}>
                      <td>
                        <div className="mailbox-name">{m.mailboxName}</div>
                        <div className="mailbox-from">
                          {m.fromAddress}
                          {m.status !== 'active' ? (
                            <span className="mailbox-status">· {m.status}</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="num">{fmt(m.sent)}</td>
                      <td className="num">
                        {fmt(m.opened)}
                        <span className="num-sub">
                          {m.sent > 0 ? fmtPct(m.openRate) : '—'}
                        </span>
                      </td>
                      <td className="num">
                        {fmt(m.replied)}
                        <span className="num-sub">
                          {m.sent > 0 ? fmtPct(m.replyRate) : '—'}
                        </span>
                      </td>
                      <td className={`num ${m.bounced > 0 ? 'num-warn' : ''}`}>
                        {fmt(m.bounced)}
                        {m.sent > 0 && m.bounced > 0 ? (
                          <span className="num-sub">{fmtPct(m.bounceRate)}</span>
                        ) : null}
                      </td>
                      <td className={`num ${m.failed > 0 ? 'num-warn' : ''}`}>
                        {fmt(m.failed)}
                      </td>
                      <td className="num">{fmt(m.queueSent)}</td>
                      <td className="num">{fmt(m.queueSkipped)}</td>
                      <td className={`num ${m.queueFailed > 0 ? 'num-warn' : ''}`}>
                        {fmt(m.queueFailed)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {totalReplies > 0 ? (
          <section>
            <div className="section-header">
              <h2 className="section-title">Reply classifications</h2>
              <p className="section-sub">
                Phase 20 reply classifier categorises every inbound message.
                NULL classifications bucket as <code>unclassified</code>.
              </p>
            </div>
            <div className="reply-class-grid">
              {replyClassifications.map((r) => (
                <div key={r.classification} className="reply-class-card">
                  <div className="reply-class-label">
                    {r.classification.replace(/_/g, ' ')}
                  </div>
                  <div className="reply-class-count">{fmt(r.count)}</div>
                  <div className="reply-class-pct">
                    {fmtPct(r.count / totalReplies)} of replies
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="metric-notes">
          <p>
            <strong>Open rate</strong> counts messages with at least one
            tracking-pixel fetch. Privacy-mode mail clients (Apple Mail Mail
            Privacy Protection, corporate proxies) inflate this number; treat
            it as a directional metric.
          </p>
          <p>
            <strong>Bounced</strong> = SMTP failure with a final 5xx response
            code. <strong>Failed</strong> = other send errors (auth, network,
            refused). Both auto-add the recipient to the suppression list.
          </p>
          <p>
            <strong>Queue skipped</strong> = items the queue refused to send
            because the recipient was suppressed, the domain was in cooldown,
            or the workspace hit its daily cap. <strong>Queue failed</strong> =
            the SMTP send threw.
          </p>
        </section>
      </div>
    </AppShell>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'muted',
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  value: string;
  sub?: string;
  tone?: 'primary' | 'teal' | 'amber' | 'violet' | 'warn' | 'muted';
}) {
  return (
    <article className={`metric-card metric-card-${tone}`}>
      <div className="metric-card-head">
        <span className="metric-card-icon">
          <Icon aria-hidden />
        </span>
        <span className="metric-card-label">{label}</span>
      </div>
      <div className="metric-card-value">{value}</div>
      {sub ? <div className="metric-card-sub">{sub}</div> : null}
    </article>
  );
}
