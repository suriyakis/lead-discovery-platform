import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bell, Check } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
} from '@/lib/services/notifications';
import { isNextRedirectError } from '@/lib/server-redirect';

const KIND_LABELS: Record<string, string> = {
  'lead.replied': '💬 Reply',
  'follow_up.awaiting_approval': '⏳ Approval',
  'review.needs_review': '🌍 Geo review',
  'run.failed': '❌ Run failed',
  'tokens.low': '🪙 Tokens',
  mention: '👤 Mention',
  assignment: '📌 Assigned',
};

export default async function NotificationsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }

  const rows = await listNotifications(ctx, { limit: 100 });

  async function markAll() {
    'use server';
    const c = await getWorkspaceContext();
    await markAllNotificationsRead(c);
    redirect('/notifications');
  }

  async function markOne(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const raw = String(formData.get('id') ?? '');
    if (/^\d+$/.test(raw)) {
      await markNotificationsRead(c, [BigInt(raw)]);
    }
    redirect('/notifications');
  }

  const unread = rows.filter((r) => r.readAt === null).length;

  return (
    <AppShell>
      <div className="dashboard-wrap">
        <header className="page-intro">
          <p className="page-eyebrow">Workspace</p>
          <h1 className="page-title">
            <Bell className="lucide" aria-hidden="true" /> Notifications
          </h1>
          <p className="page-lede">
            Replies, approvals, geo reviews, failed runs, low tokens, mentions
            and assignments — everything that needs a human, in one feed.
            This is a shared team inbox: marking a workspace notification read
            clears it for the whole team (mentions and assignments are yours
            alone).
          </p>
        </header>

        {unread > 0 ? (
          <form action={markAll} className="action-row" style={{ marginBottom: '1rem' }}>
            <button type="submit" className="ghost-btn">
              <Check className="lucide" aria-hidden="true" /> Mark all read ({unread})
            </button>
          </form>
        ) : null}

        {rows.length === 0 ? (
          <p className="muted">Nothing yet — when a lead replies or something needs your attention, it lands here.</p>
        ) : (
          <ul className="profile-list">
            {rows.map((n) => (
              <li
                key={n.id.toString()}
                style={n.readAt ? { opacity: 0.6 } : undefined}
              >
                <div className="lead-row" style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span className="badge">{KIND_LABELS[n.kind] ?? n.kind}</span>
                  {n.href ? (
                    <Link href={n.href}>
                      <strong>{n.title}</strong>
                    </Link>
                  ) : (
                    <strong>{n.title}</strong>
                  )}
                  {!n.readAt ? (
                    <form action={markOne} style={{ display: 'inline' }}>
                      <input type="hidden" name="id" value={n.id.toString()} />
                      <button type="submit" className="ghost-btn" style={{ padding: '0.1rem 0.5rem', fontSize: '0.78rem' }}>
                        mark read
                      </button>
                    </form>
                  ) : null}
                </div>
                <div className="meta">
                  {n.body ? <span>{n.body}</span> : null}
                  <span className="muted">{n.createdAt.toLocaleString()}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
