import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MessagesSquare, Search } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listProductProfiles } from '@/lib/services/product-profile';
import {
  countCommunicationByStatus,
  listCommunication,
  type CommunicationStatus,
} from '@/lib/services/communication';

const STATUS_TABS: ReadonlyArray<{
  id: CommunicationStatus;
  label: string;
  hint: string;
}> = [
  { id: 'all', label: 'Total', hint: 'Every thread in the workspace.' },
  { id: 'sent', label: 'Sent', hint: 'Outbound delivered, no reply yet.' },
  { id: 'replied', label: 'Replied', hint: 'Recipient has answered.' },
  { id: 'error', label: 'Error', hint: 'A send in this thread failed.' },
  {
    id: 'scheduled',
    label: 'Scheduled',
    hint: 'A queued reply is waiting for its send window.',
  },
];

function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function CommunicationPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    productId?: string;
    search?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
          <h1>Communication</h1>
          <p>You don&apos;t belong to a workspace yet.</p>
        </AppShell>
      );
    }
    throw err;
  }

  const activeStatus: CommunicationStatus =
    sp.status === 'sent' ||
    sp.status === 'replied' ||
    sp.status === 'error' ||
    sp.status === 'scheduled' ||
    sp.status === 'all'
      ? sp.status
      : 'all';
  const productId =
    sp.productId && /^\d+$/.test(sp.productId) ? BigInt(sp.productId) : undefined;
  const search = sp.search?.trim() || undefined;
  const dateFrom = parseDate(sp.from);
  const dateTo = parseDate(sp.to);

  const baseFilters = { productId, search, dateFrom, dateTo };
  const [rows, counts, products] = await Promise.all([
    listCommunication(ctx, { ...baseFilters, status: activeStatus }),
    countCommunicationByStatus(ctx, baseFilters),
    listProductProfiles(ctx, { includeArchived: false }),
  ]);

  function buildHref(overrides: Partial<{ status: CommunicationStatus }>): string {
    const params = new URLSearchParams();
    const nextStatus = overrides.status ?? activeStatus;
    if (nextStatus !== 'all') params.set('status', nextStatus);
    if (sp.productId) params.set('productId', sp.productId);
    if (sp.search) params.set('search', sp.search);
    if (sp.from) params.set('from', sp.from);
    if (sp.to) params.set('to', sp.to);
    const q = params.toString();
    return q ? `/communication?${q}` : '/communication';
  }

  return (
    <AppShell>
      <div className="page-header">
        <div className="page-intro">
          <p className="page-eyebrow">Outreach</p>
          <h1 className="page-title">
            <MessagesSquare className="lucide" /> Communication
          </h1>
          <p className="page-lede">
            Every thread the workspace is engaged in — outbound waiting for
            a reply, conversations the recipient answered, failed sends, and
            queued replies. Filter by status, product, time window, or
            search across subject / contact / company.
          </p>
        </div>
      </div>

      {/* Status tabs */}
      <div className="window-tabs" style={{ marginBottom: '0.75rem' }}>
        {STATUS_TABS.map((t) => {
          const isActive = t.id === activeStatus;
          return (
            <Link
              key={t.id}
              href={buildHref({ status: t.id })}
              className={`window-tab${isActive ? ' window-tab-active' : ''}`}
              title={t.hint}
            >
              {t.label}{' '}
              <span className="badge">{counts[t.id]}</span>
            </Link>
          );
        })}
      </div>

      {/* Filter form (product + search + date range) */}
      <form
        method="get"
        action="/communication"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          alignItems: 'flex-end',
          marginBottom: '0.75rem',
        }}
      >
        <input type="hidden" name="status" value={activeStatus} />
        <label style={{ flex: '2 1 280px', minWidth: 220 }}>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            Search (subject, contact, email, product)
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Search
              className="lucide"
              style={{ width: 16, height: 16, color: 'var(--brand-muted)' }}
            />
            <input
              type="text"
              name="search"
              defaultValue={sp.search ?? ''}
              placeholder="acme · jakub · datasheet …"
              style={{ flex: 1 }}
            />
          </div>
        </label>
        <label style={{ flex: '1 1 180px', minWidth: 160 }}>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            Product
          </span>
          <select name="productId" defaultValue={sp.productId ?? ''}>
            <option value="">— any —</option>
            {products.map((p) => (
              <option key={p.id.toString()} value={p.id.toString()}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: '1 1 140px', minWidth: 140 }}>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            From
          </span>
          <input type="date" name="from" defaultValue={sp.from ?? ''} />
        </label>
        <label style={{ flex: '1 1 140px', minWidth: 140 }}>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            To
          </span>
          <input type="date" name="to" defaultValue={sp.to ?? ''} />
        </label>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button type="submit" className="primary-btn">
            Apply
          </button>
          <Link href="/communication" className="ghost-btn">
            Clear
          </Link>
        </div>
      </form>

      {/* Results */}
      {rows.length === 0 ? (
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600 }}>No threads match.</p>
          <p className="muted" style={{ margin: '0.5rem 0 0' }}>
            Adjust the filters above, or generate / send an outreach draft
            to start a conversation.
          </p>
        </div>
      ) : (
        <ul
          className="profile-list"
          style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}
        >
          {rows.map((r) => {
            const statusBadge =
              r.derivedStatus === 'scheduled'
                ? 'badge'
                : r.derivedStatus === 'error'
                  ? 'badge badge-bad'
                  : r.derivedStatus === 'replied'
                    ? 'badge badge-good'
                    : 'badge';
            return (
              <li key={r.threadId.toString()}>
                <Link
                  href={`/communication/${r.threadId}`}
                  className="lead-row"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: '0.6rem',
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        flexWrap: 'wrap',
                      }}
                    >
                      <strong style={{ fontSize: '0.95em' }}>
                        {r.subject || '(no subject)'}
                      </strong>
                      <span className={statusBadge}>{r.derivedStatus}</span>
                      {r.productName ? (
                        <span className="badge">{r.productName}</span>
                      ) : null}
                      {r.currentStage ? (
                        <span className="badge">{r.currentStage}</span>
                      ) : null}
                    </div>
                    <div
                      className="muted"
                      style={{
                        fontSize: '0.78em',
                        marginTop: '0.2rem',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {r.contactName || r.contactEmail || r.participants[0] || '(no contact)'}
                      {r.contactName && r.contactEmail ? ` · ${r.contactEmail}` : ''}
                      {' · '}
                      {r.messageCount} msg
                      {r.scheduledSendAt ? (
                        <> · sends {r.scheduledSendAt.toLocaleString()}</>
                      ) : null}
                    </div>
                  </div>
                  <div
                    className="muted"
                    style={{ fontSize: '0.78em', flexShrink: 0, whiteSpace: 'nowrap' }}
                  >
                    {r.lastMessageAt ? r.lastMessageAt.toLocaleString() : '—'}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </AppShell>
  );
}
