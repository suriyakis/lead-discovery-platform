// Phase 24: platform-wide audit-log viewer (super-admin only).
//
// Filters across all workspaces. Useful for investigating cross-workspace
// activity, support, security review.

import Link from 'next/link';
import { inArray } from 'drizzle-orm';
import { requirePlatformAdmin } from '@/lib/services/auth-context';
import {
  distinctAuditKindsAcross,
  listAuditAcrossWorkspaces,
} from '@/lib/services/admin';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import { users } from '@/lib/db/schema/auth';
import {
  auditRowScopeHint,
  auditRowScopeLabel,
  type NoWorkspaceOrigin,
} from '@/lib/audit-scope';

const ALLOWED_LIMITS = [50, 100, 250, 500, 1000] as const;

/**
 * Rows with workspace_id NULL come in two kinds (src/lib/audit-scope.ts):
 * `?workspace=platform` selects the platform-scope events,
 * `?workspace=deleted` the tenant rows whose workspace was deleted.
 */
const NO_WORKSPACE_FILTERS: ReadonlyArray<{
  value: string;
  origin: NoWorkspaceOrigin;
  label: string;
}> = [
  { value: 'platform', origin: 'platform', label: 'Platform events (no workspace)' },
  { value: 'deleted', origin: 'deleted_workspace', label: 'Deleted workspaces (no workspace)' },
];

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    workspace?: string;
    kind?: string;
    since?: string;
    until?: string;
    limit?: string;
  }>;
}) {
  const pctx = await requirePlatformAdmin();
  const sp = await searchParams;

  // '' = all, 'platform' / 'deleted' = one kind of workspace_id-NULL row,
  // digits = one workspace.
  const noWorkspace = NO_WORKSPACE_FILTERS.find((f) => f.value === sp.workspace);
  const workspaceFilter: bigint | null | undefined = noWorkspace
    ? null
    : sp.workspace && /^\d+$/.test(sp.workspace)
      ? BigInt(sp.workspace)
      : undefined;
  const kindFilter = sp.kind?.trim() || undefined;
  const since = parseDateInput(sp.since);
  const until = parseDateInput(sp.until);
  const limit =
    sp.limit && /^\d+$/.test(sp.limit) ? Number(sp.limit) : 100;
  const safeLimit = (ALLOWED_LIMITS as ReadonlyArray<number>).includes(limit)
    ? limit
    : 100;

  const [events, kinds, allWorkspaces] = await Promise.all([
    listAuditAcrossWorkspaces(pctx, {
      workspaceId: workspaceFilter,
      noWorkspaceOrigin: noWorkspace?.origin,
      kind: kindFilter,
      since,
      until,
      limit: safeLimit,
    }),
    distinctAuditKindsAcross(pctx),
    db.select().from(workspaces).orderBy(workspaces.name),
  ]);
  const wsById = new Map(allWorkspaces.map((w) => [w.id.toString(), w]));

  const userIds = Array.from(
    new Set(events.map((e) => e.userId).filter((u): u is string => !!u)),
  );
  const userRows = userIds.length
    ? await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const userById = new Map(userRows.map((u) => [u.id, u]));

  return (
    <div className="dashboard-wrap">
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/admin">Admin</Link> / Audit log
      </p>
      <h1>Platform audit log</h1>
      <p className="muted">
        Audit events across every workspace. Rows marked{' '}
        <code>platform</code> are platform-level events (users,
        pre-authorisations, platform roles, provider keys and settings,
        background jobs) filed in no workspace on purpose. Rows marked{' '}
        <code>no workspace</code> belonged to a workspace that has since been
        deleted: audit rows outlive their workspace, and the{' '}
        <code>admin.workspace.delete</code> row names it. Each row is signed
        with the actor&apos;s user id.
      </p>

      <form className="leads-controls" method="get">
        <label>
          Workspace
          <select
            name="workspace"
            defaultValue={noWorkspace?.value ?? workspaceFilter?.toString() ?? ''}
          >
            <option value="">All</option>
            {NO_WORKSPACE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
            {allWorkspaces.map((w) => (
              <option key={w.id.toString()} value={w.id.toString()}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kind
          <select name="kind" defaultValue={kindFilter ?? ''}>
            <option value="">All</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          Since
          <input
            type="datetime-local"
            name="since"
            defaultValue={toLocalInput(since)}
          />
        </label>
        <label>
          Until
          <input
            type="datetime-local"
            name="until"
            defaultValue={toLocalInput(until)}
          />
        </label>
        <label>
          Limit
          <select name="limit" defaultValue={safeLimit.toString()}>
            {ALLOWED_LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>

      <section>
        {events.length === 0 ? (
          <p className="muted">No events match this filter.</p>
        ) : (
          <ul className="timeline">
            {events.map((e) => {
              const u = e.userId ? userById.get(e.userId) : null;
              const w = e.workspaceId ? wsById.get(e.workspaceId.toString()) : null;
              const scopeHint = auditRowScopeHint(e);
              const payload = e.payload as Record<string, unknown>;
              const hasPayload = Object.keys(payload).length > 0;
              return (
                <li key={e.id.toString()}>
                  <div>
                    <span className="muted">{e.createdAt.toLocaleString()}</span>{' '}
                    <code title={scopeHint ?? undefined}>
                      {auditRowScopeLabel(e, w?.name)}
                    </code>{' '}
                    <strong>{e.kind}</strong>
                    {e.entityType ? (
                      <span className="muted">
                        {' '}
                        · {e.entityType}#{e.entityId ?? '—'}
                      </span>
                    ) : null}
                  </div>
                  <div className="muted">
                    by {u ? `${u.name ?? u.email}` : (e.userId ?? '—')}
                  </div>
                  {hasPayload ? (
                    <pre
                      className="draft-body"
                      style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}
                    >
                      {JSON.stringify(payload, null, 2)}
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function parseDateInput(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function toLocalInput(d: Date | undefined): string {
  if (!d) return '';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
