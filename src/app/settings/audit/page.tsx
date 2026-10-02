// Phase 24: workspace audit-log viewer.
//
// Shows what changed in this workspace, newest first. Admin-gated. Filters:
//   - kind (multi-select dropdown of distinct kinds present in this workspace)
//   - since / until (datetime-local inputs, optional), read in the
//     viewer's time zone (the form's hidden `tz` field); timestamps are
//     shown in the same zone
//   - limit (10..1000)

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq, inArray } from 'drizzle-orm';
import { AppShell } from '@/components/AppShell';
import { ViewerTimeZoneField } from '@/components/ViewerTimeZoneField';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import { listAuditEvents } from '@/lib/services/audit';
import { db } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema/audit';
import { users } from '@/lib/db/schema/auth';
import {
  formatDateTimeInZone,
  parseDateTimeLocal,
  resolveTimeZone,
  toDateTimeLocalValue,
  untilExclusiveEnd,
} from '@/lib/time-zone';

const ALLOWED_LIMITS = [25, 50, 100, 250, 500] as const;

export default async function WorkspaceAuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    since?: string;
    until?: string;
    tz?: string;
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
    if (err instanceof NoWorkspaceError) redirect('/today');
    throw err;
  }
  if (!canAdminWorkspace(ctx)) {
    return (
      <AppShell>
        <h1>Audit log</h1>
        <p className="form-error">Admins only.</p>
      </AppShell>
    );
  }

  const kindFilter = sp.kind?.trim() || undefined;
  const requestedZone = resolveTimeZone(sp.tz);
  const timeZone = requestedZone ?? 'UTC';
  const since = parseDateTimeLocal(sp.since, timeZone) ?? undefined;
  const until = parseDateTimeLocal(sp.until, timeZone) ?? undefined;
  // Until covers its whole minute: the list shows seconds, so "until
  // 13:00" must keep an event stamped 13:00:40.
  const before = untilExclusiveEnd(sp.until, timeZone) ?? undefined;
  const limit =
    sp.limit && /^\d+$/.test(sp.limit)
      ? Number(sp.limit)
      : 100;
  const safeLimit =
    (ALLOWED_LIMITS as ReadonlyArray<number>).includes(limit) ? limit : 100;

  const [events, kinds] = await Promise.all([
    listAuditEvents(ctx, {
      kind: kindFilter,
      since,
      before,
      limit: safeLimit,
    }),
    db
      .selectDistinct({ kind: auditLog.kind })
      .from(auditLog)
      .where(eq(auditLog.workspaceId, ctx.workspaceId))
      .orderBy(auditLog.kind),
  ]);

  // Resolve user names for display. One round trip — small set.
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
    <AppShell>
      <p className="muted">
        <Link href="/today">Today</Link> /{' '}
        <Link href="/settings/integrations">Settings</Link> / Audit log
      </p>
      <h1>Audit log</h1>
      <p className="muted">
        Append-only history of workspace mutations. Every service-layer
        write emits an audit event keyed by the actor and entity touched.
      </p>

      <form className="leads-controls" method="get">
        <label>
          Kind
          <select name="kind" defaultValue={kindFilter ?? ''}>
            <option value="">All</option>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          Since
          <input
            type="datetime-local"
            name="since"
            defaultValue={since ? toDateTimeLocalValue(since, timeZone) : ''}
          />
        </label>
        <label>
          Until
          <input
            type="datetime-local"
            name="until"
            defaultValue={until ? toDateTimeLocalValue(until, timeZone) : ''}
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
        <ViewerTimeZoneField current={requestedZone} />
        <button type="submit">Apply</button>
      </form>
      <p className="muted">Times are in {timeZone}.</p>

      <section>
        {events.length === 0 ? (
          <p className="muted">No events match this filter.</p>
        ) : (
          <ul className="timeline">
            {events.map((e) => {
              const u = e.userId ? userById.get(e.userId) : null;
              const payload = e.payload as Record<string, unknown>;
              const hasPayload = Object.keys(payload).length > 0;
              return (
                <li key={e.id.toString()}>
                  <div>
                    <span className="muted">
                      {formatDateTimeInZone(e.createdAt, timeZone)}
                    </span>{' '}
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
    </AppShell>
  );
}
