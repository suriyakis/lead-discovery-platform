// Phase 24: platform-wide audit-log viewer (super-admin only).
//
// Filters across all workspaces. Useful for investigating cross-workspace
// activity, support, security review.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { isSuperAdmin } from '@/lib/services/context';
import {
  distinctAuditKindsAcross,
  listAuditAcrossWorkspaces,
} from '@/lib/services/admin';
import { db } from '@/lib/db/client';
import { workspaces } from '@/lib/db/schema/workspaces';
import { users } from '@/lib/db/schema/auth';

const ALLOWED_LIMITS = [50, 100, 250, 500, 1000] as const;

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
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }
  if (!isSuperAdmin(ctx)) {
    return (
      <AppShell>
        <h1>Audit log</h1>
        <p className="form-error">Super-admin only.</p>
      </AppShell>
    );
  }

  const workspaceFilter =
    sp.workspace && /^\d+$/.test(sp.workspace) ? BigInt(sp.workspace) : undefined;
  const kindFilter = sp.kind?.trim() || undefined;
  const since = parseDateInput(sp.since);
  const until = parseDateInput(sp.until);
  const limit =
    sp.limit && /^\d+$/.test(sp.limit) ? Number(sp.limit) : 100;
  const safeLimit = (ALLOWED_LIMITS as ReadonlyArray<number>).includes(limit)
    ? limit
    : 100;

  const [events, kinds, allWorkspaces] = await Promise.all([
    listAuditAcrossWorkspaces(ctx, {
      workspaceId: workspaceFilter,
      kind: kindFilter,
      since,
      until,
      limit: safeLimit,
    }),
    distinctAuditKindsAcross(ctx),
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
        .where(sql`${users.id} = ANY(${userIds})`)
    : [];
  const userById = new Map(userRows.map((u) => [u.id, u]));

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/admin">Admin</Link> / Audit log
      </p>
      <h1>Platform audit log</h1>
      <p className="muted">
        Audit events across every workspace. Each row is signed with the
        actor user_id, regardless of which workspace it lands in.
      </p>

      <form className="leads-controls" method="get">
        <label>
          Workspace
          <select name="workspace" defaultValue={workspaceFilter?.toString() ?? ''}>
            <option value="">All</option>
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
              const payload = e.payload as Record<string, unknown>;
              const hasPayload = Object.keys(payload).length > 0;
              return (
                <li key={e.id.toString()}>
                  <div>
                    <span className="muted">{e.createdAt.toLocaleString()}</span>{' '}
                    <code>ws:{w ? w.name : (e.workspaceId?.toString() ?? '—')}</code>{' '}
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
                      style={{ marginTop: '0.25rem', fontSize: '0.75rem' }}
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
    </AppShell>
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
