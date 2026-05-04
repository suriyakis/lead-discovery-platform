import Link from 'next/link';
import { redirect } from 'next/navigation';
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
      <main style={{ padding: '1.5rem 2rem', maxWidth: '1200px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', marginBottom: '0.5rem' }}>
          <h1 style={{ margin: 0, fontSize: '1.6rem' }}>Deliverability</h1>
          <span style={{ color: '#9ca3af', fontSize: '0.9rem' }}>
            {report.windowStart.toLocaleDateString()} — {report.windowEnd.toLocaleDateString()}
          </span>
        </div>
        <p style={{ marginTop: 0, color: '#9ca3af', fontSize: '0.9rem' }}>
          How outbound mail is performing per mailbox: opens, bounces, replies,
          unsubscribes, and queue health.
        </p>

        <div style={{ display: 'flex', gap: '0.5rem', margin: '1rem 0 1.5rem' }}>
          {WINDOW_OPTIONS.map((o) => {
            const active = o.days === days;
            return (
              <Link
                key={o.days}
                href={`/mailbox/deliverability?days=${o.days}`}
                style={{
                  padding: '0.4rem 0.85rem',
                  borderRadius: '6px',
                  fontSize: '0.85rem',
                  background: active ? '#f97316' : '#1f2937',
                  color: active ? '#0b1220' : '#e5e7eb',
                  border: '1px solid #374151',
                  textDecoration: 'none',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {o.label}
              </Link>
            );
          })}
        </div>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '0.75rem',
            marginBottom: '2rem',
          }}
        >
          <Stat label="Sent" value={fmt(totals.sent)} />
          <Stat
            label="Opens"
            value={fmt(totals.opened)}
            sub={totals.sent > 0 ? `${fmtPct(totals.opened / totals.sent)} of sent` : undefined}
          />
          <Stat
            label="Replies"
            value={fmt(totals.replied)}
            sub={totals.sent > 0 ? `${fmtPct(totals.replied / totals.sent)} of sent` : undefined}
          />
          <Stat
            label="Bounced"
            value={fmt(totals.bounced)}
            sub={totals.sent > 0 ? `${fmtPct(totals.bounced / totals.sent)} of sent` : undefined}
            tone={totals.bounced > 0 ? 'warn' : 'normal'}
          />
          <Stat
            label="Failed"
            value={fmt(totals.failed)}
            tone={totals.failed > 0 ? 'warn' : 'normal'}
          />
          <Stat label="Unsubscribed" value={fmt(totals.unsubscribed)} />
          <Stat label="Queue skipped" value={fmt(totals.queueSkipped)} />
          <Stat
            label="Queue failed"
            value={fmt(totals.queueFailed)}
            tone={totals.queueFailed > 0 ? 'warn' : 'normal'}
          />
        </section>

        <section style={{ marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>By mailbox</h2>
          {byMailbox.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: '0.9rem' }}>
              No mailboxes configured yet. Connect one from the{' '}
              <Link href="/mailbox" style={{ color: '#f97316' }}>
                Mailbox
              </Link>{' '}
              page.
            </p>
          ) : (
            <div
              style={{
                background: '#0f172a',
                border: '1px solid #1f2937',
                borderRadius: '8px',
                overflow: 'auto',
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                <thead>
                  <tr style={{ background: '#111827' }}>
                    <Th>Mailbox</Th>
                    <Th align="right">Sent</Th>
                    <Th align="right">Open</Th>
                    <Th align="right">Reply</Th>
                    <Th align="right">Bounced</Th>
                    <Th align="right">Failed</Th>
                    <Th align="right">Q sent</Th>
                    <Th align="right">Q skipped</Th>
                    <Th align="right">Q failed</Th>
                  </tr>
                </thead>
                <tbody>
                  {byMailbox.map((m) => (
                    <tr
                      key={m.mailboxId}
                      style={{ borderTop: '1px solid #1f2937', verticalAlign: 'top' }}
                    >
                      <Td>
                        <div style={{ fontWeight: 500 }}>{m.mailboxName}</div>
                        <div style={{ color: '#9ca3af', fontSize: '0.78rem' }}>
                          {m.fromAddress}
                          {m.status !== 'active' ? (
                            <span style={{ marginLeft: '0.4rem', color: '#f59e0b' }}>
                              · {m.status}
                            </span>
                          ) : null}
                        </div>
                      </Td>
                      <Td align="right">{fmt(m.sent)}</Td>
                      <Td align="right">
                        {fmt(m.opened)}
                        <span style={{ color: '#6b7280', marginLeft: '0.3rem', fontSize: '0.78rem' }}>
                          {m.sent > 0 ? fmtPct(m.openRate) : '—'}
                        </span>
                      </Td>
                      <Td align="right">
                        {fmt(m.replied)}
                        <span style={{ color: '#6b7280', marginLeft: '0.3rem', fontSize: '0.78rem' }}>
                          {m.sent > 0 ? fmtPct(m.replyRate) : '—'}
                        </span>
                      </Td>
                      <Td align="right" tone={m.bounced > 0 ? 'warn' : undefined}>
                        {fmt(m.bounced)}
                        {m.sent > 0 && m.bounced > 0 ? (
                          <span style={{ color: '#6b7280', marginLeft: '0.3rem', fontSize: '0.78rem' }}>
                            {fmtPct(m.bounceRate)}
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right" tone={m.failed > 0 ? 'warn' : undefined}>
                        {fmt(m.failed)}
                      </Td>
                      <Td align="right">{fmt(m.queueSent)}</Td>
                      <Td align="right">{fmt(m.queueSkipped)}</Td>
                      <Td align="right" tone={m.queueFailed > 0 ? 'warn' : undefined}>
                        {fmt(m.queueFailed)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {totalReplies > 0 ? (
          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Reply classifications</h2>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '0.5rem',
              }}
            >
              {replyClassifications.map((r) => (
                <div
                  key={r.classification}
                  style={{
                    padding: '0.65rem 0.85rem',
                    background: '#0f172a',
                    border: '1px solid #1f2937',
                    borderRadius: '6px',
                  }}
                >
                  <div style={{ fontSize: '0.78rem', color: '#9ca3af', textTransform: 'uppercase' }}>
                    {r.classification.replace(/_/g, ' ')}
                  </div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 600 }}>{fmt(r.count)}</div>
                  <div style={{ fontSize: '0.78rem', color: '#6b7280' }}>
                    {fmtPct(r.count / totalReplies)} of replies
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section style={{ color: '#9ca3af', fontSize: '0.82rem' }}>
          <p style={{ margin: '0 0 0.4rem' }}>
            <strong>Open rate</strong> counts messages with at least one tracking-pixel
            fetch. Privacy-mode mail clients (Apple Mail Mail Privacy Protection,
            corporate proxies) inflate this number; treat it as a directional metric.
          </p>
          <p style={{ margin: '0 0 0.4rem' }}>
            <strong>Bounced</strong> = SMTP failure with a final 5xx response code.
            <strong>Failed</strong> = other send errors (auth, network, refused).
            Both auto-add the recipient to the suppression list per Phase 17.
          </p>
          <p style={{ margin: 0 }}>
            <strong>Queue skipped</strong> = items the queue refused to send because
            the recipient was suppressed, the domain was in cooldown, or the workspace
            hit its daily cap. <strong>Queue failed</strong> = the SMTP send threw.
          </p>
        </section>
      </main>
    </AppShell>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'normal' | 'warn';
}) {
  const color = tone === 'warn' ? '#f59e0b' : '#e5e7eb';
  return (
    <div
      style={{
        padding: '0.85rem 1rem',
        background: '#0f172a',
        border: '1px solid #1f2937',
        borderRadius: '8px',
      }}
    >
      <div style={{ fontSize: '0.78rem', color: '#9ca3af', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 600, color }}>{value}</div>
      {sub ? (
        <div style={{ fontSize: '0.78rem', color: '#6b7280', marginTop: '0.1rem' }}>{sub}</div>
      ) : null}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return (
    <th
      style={{
        textAlign: align ?? 'left',
        padding: '0.6rem 0.85rem',
        fontSize: '0.78rem',
        fontWeight: 600,
        color: '#9ca3af',
        textTransform: 'uppercase',
        letterSpacing: '0.02em',
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  tone,
}: {
  children: React.ReactNode;
  align?: 'right';
  tone?: 'warn';
}) {
  const color = tone === 'warn' ? '#f59e0b' : undefined;
  return (
    <td style={{ textAlign: align ?? 'left', padding: '0.6rem 0.85rem', color }}>
      {children}
    </td>
  );
}
