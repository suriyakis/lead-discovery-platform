import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Timer } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { CommunicationTabs } from '@/components/CommunicationTabs';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  cancelFollowUps,
  countFollowUpsByStatus,
  listFollowUps,
} from '@/lib/services/follow-up';
import { countCommunicationByStatus } from '@/lib/services/communication';
import { isNextRedirectError } from '@/lib/server-redirect';

type FollowUpFilter = 'all' | 'pending' | 'sent' | 'skipped' | 'failed';

const STATUS_TABS: ReadonlyArray<{
  id: FollowUpFilter;
  label: string;
  hint: string;
}> = [
  { id: 'pending', label: 'Pending', hint: 'Scheduled, waiting for their send time.' },
  { id: 'sent', label: 'Sent', hint: 'Follow-up email delivered.' },
  {
    id: 'skipped',
    label: 'Skipped',
    hint: 'Cancelled — reply arrived, lead closed, or operator override.',
  },
  { id: 'failed', label: 'Failed', hint: 'Compose or send error; retry needed.' },
  { id: 'all', label: 'All', hint: 'Every follow-up row in the workspace.' },
];

export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
          <h1>Follow-ups</h1>
          <p>You don&apos;t belong to a workspace yet.</p>
        </AppShell>
      );
    }
    throw err;
  }

  const activeStatus: FollowUpFilter =
    sp.status === 'all' ||
    sp.status === 'pending' ||
    sp.status === 'sent' ||
    sp.status === 'skipped' ||
    sp.status === 'failed'
      ? sp.status
      : 'pending';

  const [rows, counts, conversationCounts] = await Promise.all([
    listFollowUps(ctx, { status: activeStatus }),
    countFollowUpsByStatus(ctx),
    countCommunicationByStatus(ctx),
  ]);

  async function cancel(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const threadIdRaw = String(formData.get('threadId') ?? '');
    if (!/^\d+$/.test(threadIdRaw)) {
      redirect('/communication/follow-ups?error=invalid_thread_id');
    }
    const threadId = BigInt(threadIdRaw);
    try {
      const n = await cancelFollowUps(c, threadId, 'manual_cancel');
      redirect(
        `/communication/follow-ups?status=${activeStatus}&message=${encodeURIComponent(
          `Cancelled ${n} pending follow-up${n === 1 ? '' : 's'}.`,
        )}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'cancel failed';
      redirect(
        `/communication/follow-ups?status=${activeStatus}&error=${encodeURIComponent(m)}`,
      );
    }
  }

  return (
    <AppShell>
      <div className="page-header">
        <div className="page-intro">
          <p className="page-eyebrow">Outreach</p>
          <h1 className="page-title">
            <Timer className="lucide" /> Follow-ups
          </h1>
          <p className="page-lede">
            After the first outbound on a thread, the platform schedules
            three polite follow-ups — one per week. They only fire if no
            reply has arrived and no error has surfaced. The last step
            explicitly tells the recipient it&apos;s the final email so the
            cadence ends cleanly.
          </p>
        </div>
      </div>

      <CommunicationTabs
        active="follow-ups"
        conversationsCount={conversationCounts.all}
        followUpsPendingCount={counts.pending}
      />

      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <nav
        className="window-tabs"
        style={{ marginBottom: '0.75rem' }}
        aria-label="Follow-up status"
      >
        {STATUS_TABS.map((t) => {
          const isActive = t.id === activeStatus;
          return (
            <Link
              key={t.id}
              href={`/communication/follow-ups?status=${t.id}`}
              className={`window-tab${isActive ? ' window-tab-active' : ''}`}
              title={t.hint}
            >
              {t.label} <span className="badge">{counts[t.id]}</span>
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600 }}>
            No {activeStatus === 'all' ? '' : activeStatus} follow-ups.
          </p>
          <p className="muted" style={{ margin: '0.5rem 0 0' }}>
            When the platform sends the first outbound on a thread linked
            to a qualified lead, three follow-ups get pre-scheduled here.
          </p>
        </div>
      ) : (
        <ul
          className="profile-list"
          style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}
        >
          {rows.map((r) => {
            const statusBadge =
              r.status === 'pending'
                ? 'badge'
                : r.status === 'sent'
                  ? 'badge badge-good'
                  : r.status === 'failed'
                    ? 'badge badge-bad'
                    : 'badge';
            const stepLabel = `${r.stepNumber}/${r.totalSteps}`;
            const isFinal = r.stepNumber === r.totalSteps;
            return (
              <li key={r.id.toString()}>
                <div
                  className="lead-row"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span className="badge">Step {stepLabel}</span>
                      <span className={statusBadge}>{r.status}</span>
                      {r.skipReason ? (
                        <span className="muted" style={{ fontSize: '0.78em' }}>
                          ({r.skipReason})
                        </span>
                      ) : null}
                      {isFinal ? (
                        <span
                          className="badge"
                          title="The AI prompt explicitly tells the recipient this is the last follow-up."
                        >
                          final
                        </span>
                      ) : null}
                      <Link
                        href={`/communication/${r.threadId}`}
                        style={{ fontWeight: 600 }}
                      >
                        {r.threadSubject || '(no subject)'}
                      </Link>
                    </div>
                    <div
                      className="muted"
                      style={{ fontSize: '0.78em', marginTop: '0.2rem' }}
                    >
                      {r.contactName || r.contactEmail || '(no contact)'}
                      {r.contactName && r.contactEmail ? ` · ${r.contactEmail}` : ''}
                      {r.productName ? ` · ${r.productName}` : ''}
                    </div>
                    {r.lastError ? (
                      <div
                        className="form-error"
                        style={{
                          fontSize: '0.78em',
                          marginTop: '0.2rem',
                          padding: '0.3rem 0.5rem',
                        }}
                      >
                        {r.lastError.slice(0, 200)}
                      </div>
                    ) : null}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      gap: '0.3rem',
                      minWidth: '11rem',
                    }}
                  >
                    <span
                      className="muted"
                      style={{ fontSize: '0.78em', whiteSpace: 'nowrap' }}
                    >
                      {r.status === 'pending' ? 'sends' : 'scheduled'}{' '}
                      {r.scheduledFor.toLocaleString()}
                    </span>
                    {r.processedAt ? (
                      <span
                        className="muted"
                        style={{ fontSize: '0.72em', whiteSpace: 'nowrap' }}
                      >
                        processed {r.processedAt.toLocaleString()}
                      </span>
                    ) : null}
                    {r.status === 'pending' ? (
                      <form action={cancel} style={{ display: 'inline' }}>
                        <input
                          type="hidden"
                          name="threadId"
                          value={r.threadId.toString()}
                        />
                        <button
                          type="submit"
                          className="ghost-btn"
                          style={{ fontSize: '0.78em' }}
                          title="Cancel every pending follow-up on this thread"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </AppShell>
  );
}
