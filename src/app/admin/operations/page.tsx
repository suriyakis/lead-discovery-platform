// PC-12 review: the platform console's Operations page — first, the work
// leases (services/work-leases.ts). PC-12 chose leases over advisory locks
// because an operator can see them: who holds which background work in
// which workspace, since when, until when, and which leases a dead holder
// left behind (expired: the next pass takes it over; never delete a live
// one by hand). PC-31 grows this page into its Status / Incidents / Stuck
// work / Mailboxes tabs.
//
// Read only, super-admin only (the /admin layout guards it; the page and
// the service check again).

import Link from 'next/link';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { TableScroll } from '@/components/TableScroll';
import { formatUtc } from '@/lib/format-utc';
import { requirePlatformAdmin } from '@/lib/services/auth-context';
import { listWorkLeases, type WorkLeaseView } from '@/lib/services/work-leases';

/** What the lease covers, for people. */
const KIND_LABELS: Readonly<Record<WorkLeaseView['kind'], string>> = {
  'autopilot.run': 'Autopilot run',
  'outreach.drain': 'Send queue',
  'outreach.follow_up': 'Follow-up pass',
  'mailbox.sync': 'Mailbox',
  'connector.recipe': 'Discovery recipe',
  action: 'AI button',
};

function workLabel(l: Pick<WorkLeaseView, 'kind' | 'resourceKey'>): string {
  const kind = KIND_LABELS[l.kind];
  if (!l.resourceKey) return kind;
  return l.kind === 'action' ? `${kind}: ${l.resourceKey}` : `${kind} #${l.resourceKey}`;
}

export default async function AdminOperationsPage() {
  const pctx = await requirePlatformAdmin();
  const leases = await listWorkLeases(pctx);
  const live = leases.filter((l) => l.live).length;
  const expired = leases.length - live;

  return (
    <div className="dashboard-wrap">
      <p className="muted">
        <Link href="/admin">Platform console</Link> / Operations
      </p>
      <h1>Operations</h1>
      <p className="muted">
        Work leases: background work that must not overlap in a workspace (an autopilot run, the
        send queue, a follow-up pass, a mailbox sync, a discovery recipe, an AI button) holds a
        lease while it works and renews it as it goes. A live lease is work in progress. An expired
        one was left by a holder that stopped without releasing it (a crash or a deploy); the next
        pass takes it over on its own. Never delete a live lease: a second pass would start beside
        the first.
      </p>

      <section>
        <h2>
          Work leases ({live} live, {expired} expired)
        </h2>
        {leases.length === 0 ? (
          <EmptyState
            title="No work leases"
            hint="Nothing is running right now, and no holder left a lease behind."
          />
        ) : (
          <TableScroll label="Work leases">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Work</th>
                  <th>State</th>
                  <th>Workspace</th>
                  <th>Purpose</th>
                  <th>Holder</th>
                  <th>Acquired</th>
                  <th>Renewed</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {leases.map((l) => (
                  <tr key={`${l.workspaceId}:${l.kind}:${l.resourceKey}`}>
                    <td>
                      {workLabel(l)}
                      <br />
                      <code className="muted">{l.kind}</code>
                    </td>
                    <td>
                      {l.live ? (
                        <Badge tone="live" pulse title="Held and renewed: work in progress">
                          Live
                        </Badge>
                      ) : (
                        <Badge
                          tone="danger"
                          title="Its holder stopped without releasing it; the next pass takes it over"
                        >
                          Expired
                        </Badge>
                      )}
                    </td>
                    <td>
                      <Link href={`/admin/workspaces/${l.workspaceId}`}>
                        {l.workspaceName ?? `Workspace ${l.workspaceId}`}
                      </Link>
                    </td>
                    <td>{l.purpose || '—'}</td>
                    <td>
                      <code>{l.holderLabel}</code>
                    </td>
                    <td>{formatUtc(l.acquiredAt)}</td>
                    <td>{formatUtc(l.renewedAt)}</td>
                    <td>{formatUtc(l.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>
    </div>
  );
}
