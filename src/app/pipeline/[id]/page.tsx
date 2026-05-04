import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  PipelineServiceError,
  FORWARD_TRANSITIONS,
  assign,
  getLead,
  setNotes,
  transition,
  updateContact,
} from '@/lib/services/pipeline';
import {
  CrmServiceError,
  listCrmConnections,
  listSyncEntries,
  pushDeal,
  pushLeadToCrm,
  pushThreadAsNotes,
} from '@/lib/services/crm';
import { db } from '@/lib/db/client';
import { mailThreads } from '@/lib/db/schema/mailing';
import { contactAssociations } from '@/lib/db/schema/contacts';
import { and, eq, sql } from 'drizzle-orm';
import type {
  CloseReason,
  PipelineState,
} from '@/lib/db/schema/pipeline';

const CLOSE_REASONS: ReadonlyArray<{ key: CloseReason; label: string }> = [
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
  { key: 'no_response', label: 'No response' },
  { key: 'wrong_fit', label: 'Wrong fit' },
  { key: 'duplicate', label: 'Duplicate' },
  { key: 'spam', label: 'Spam' },
  { key: 'other', label: 'Other' },
];

export default async function PipelineLeadDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/pipeline');
  const id = BigInt(idStr);
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/pipeline');
    throw err;
  }

  let detail;
  try {
    detail = await getLead(ctx, id);
  } catch (err) {
    if (err instanceof PipelineServiceError && err.code === 'not_found') {
      redirect('/pipeline');
    }
    throw err;
  }

  const { lead, product, reviewItem, events } = detail;
  const allowed = FORWARD_TRANSITIONS[lead.state];
  const crmConns = await listCrmConnections(ctx);
  const activeCrm = crmConns.filter((c) => c.status !== 'archived');
  const recentSyncs = await listSyncEntries(ctx, { leadId: lead.id, limit: 10 });

  // Phase 18: surface threads attached to this lead's contact so the user
  // can pick which thread to push as notes.
  const leadThreads = await db
    .select({ thread: mailThreads })
    .from(mailThreads)
    .innerJoin(
      contactAssociations,
      and(
        eq(contactAssociations.entityType, 'mail_thread'),
        sql`${contactAssociations.entityId} = ${mailThreads.id}::text`,
      ),
    )
    .innerJoin(
      contactAssociations as never,
      and(
        eq(contactAssociations.entityType, 'qualified_lead'),
        sql`${contactAssociations.entityId} = ${lead.id}::text`,
      ),
    )
    .where(eq(mailThreads.workspaceId, ctx.workspaceId))
    .limit(20);
  void leadThreads;
  // Simpler approach: fetch every thread the lead's contact is attached to.
  const threadAssocs = await db
    .select()
    .from(contactAssociations)
    .where(
      and(
        eq(contactAssociations.workspaceId, ctx.workspaceId),
        eq(contactAssociations.entityType, 'mail_thread'),
      ),
    );
  const leadAssocs = await db
    .select()
    .from(contactAssociations)
    .where(
      and(
        eq(contactAssociations.workspaceId, ctx.workspaceId),
        eq(contactAssociations.entityType, 'qualified_lead'),
        eq(contactAssociations.entityId, lead.id.toString()),
      ),
    );
  const leadContactIds = new Set(leadAssocs.map((a) => a.contactId.toString()));
  const threadIdsForLead = threadAssocs
    .filter((a) => leadContactIds.has(a.contactId.toString()))
    .map((a) => BigInt(a.entityId));
  const linkedThreads = threadIdsForLead.length > 0
    ? await db
        .select()
        .from(mailThreads)
        .where(
          and(
            eq(mailThreads.workspaceId, ctx.workspaceId),
            sql`${mailThreads.id} = ANY(${threadIdsForLead})`,
          ),
        )
    : [];

  async function doTransition(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const toRaw = String(formData.get('to') ?? '');
    if (!toRaw) return;
    try {
      await transition(c, id, {
        to: toRaw as PipelineState,
        closeReason: (String(formData.get('closeReason') ?? '') || undefined) as CloseReason | undefined,
        closeNote: String(formData.get('closeNote') ?? '').trim() || null,
      });
      redirect(`/pipeline/${id}`);
    } catch (err) {
      if (err instanceof PipelineServiceError) {
        redirect(`/pipeline/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  async function doForceTransition(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const toRaw = String(formData.get('to') ?? '');
    try {
      await transition(c, id, {
        to: toRaw as PipelineState,
        force: true,
        closeReason: (String(formData.get('closeReason') ?? '') || undefined) as CloseReason | undefined,
      });
      redirect(`/pipeline/${id}`);
    } catch (err) {
      if (err instanceof PipelineServiceError) {
        redirect(`/pipeline/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  async function saveContact(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await updateContact(c, id, {
        contactName: String(formData.get('contactName') ?? '').trim() || null,
        contactEmail: String(formData.get('contactEmail') ?? '').trim() || null,
        contactRole: String(formData.get('contactRole') ?? '').trim() || null,
        contactPhone: String(formData.get('contactPhone') ?? '').trim() || null,
        contactNotes: String(formData.get('contactNotes') ?? '').trim() || null,
      });
      redirect(`/pipeline/${id}?message=Contact+updated`);
    } catch (err) {
      if (err instanceof PipelineServiceError) {
        redirect(`/pipeline/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  async function saveNotes(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    await setNotes(c, id, String(formData.get('notes') ?? ''));
    redirect(`/pipeline/${id}?message=Notes+saved`);
  }

  async function saveAssignment(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const userIdRaw = String(formData.get('assignedToUserId') ?? '').trim();
    await assign(c, id, userIdRaw || null);
    redirect(`/pipeline/${id}`);
  }

  async function pushNotes(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const connIdRaw = String(formData.get('connectionId') ?? '');
    const threadIdRaw = String(formData.get('threadId') ?? '');
    if (!/^\d+$/.test(connIdRaw) || !/^\d+$/.test(threadIdRaw)) return;
    try {
      const r = await pushThreadAsNotes(c, {
        connectionId: BigInt(connIdRaw),
        threadId: BigInt(threadIdRaw),
      });
      const m = `Notes pushed — inserted ${r.inserted}, skipped ${r.skipped}, failed ${r.failed}`;
      redirect(`/pipeline/${id}?message=${encodeURIComponent(m)}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'failed';
      redirect(`/pipeline/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  async function pushDealAction(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const connIdRaw = String(formData.get('connectionId') ?? '');
    if (!/^\d+$/.test(connIdRaw)) return;
    try {
      const r = await pushDeal(c, { connectionId: BigInt(connIdRaw), leadId: id });
      const m =
        r.entry.outcome === 'succeeded'
          ? `Deal pushed (ext ${r.entry.externalId ?? '—'})`
          : `Deal push failed: ${r.entry.error ?? 'unknown'}`;
      redirect(`/pipeline/${id}?message=${encodeURIComponent(m)}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'failed';
      redirect(`/pipeline/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  async function pushCrm(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const connIdRaw = String(formData.get('connectionId') ?? '');
    if (!/^\d+$/.test(connIdRaw)) return;
    const advance = formData.get('advance') === 'on';
    try {
      const result = await pushLeadToCrm(c, {
        connectionId: BigInt(connIdRaw),
        leadId: id,
        advanceState: advance,
      });
      const m =
        result.entry.outcome === 'succeeded'
          ? `Pushed (ext ${result.entry.externalId ?? '—'})`
          : `Failed: ${result.entry.error ?? 'unknown'}`;
      redirect(`/pipeline/${id}?message=${encodeURIComponent(m)}`);
    } catch (err) {
      const m =
        err instanceof CrmServiceError ? err.message : err instanceof Error ? err.message : 'push failed';
      redirect(`/pipeline/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/pipeline">Pipeline</Link> / {lead.contactName ?? `Lead ${lead.id}`}
        </p>
        <h1>{lead.contactName ?? `Lead ${lead.id}`}</h1>
        <p>
          <span className={badgeFor(lead.state)}>
            {lead.state.replace(/_/g, ' ')}
          </span>{' '}
          <span className="muted">
            for <Link href={`/products/${product.id}`}>{product.name}</Link> ·
            source <Link href={`/review/${reviewItem.id}`}>review item {reviewItem.id.toString()}</Link>
          </span>
        </p>
        {sp.error ? <p className="form-error">{sp.error}</p> : null}
        {sp.message ? <p className="form-message">{sp.message}</p> : null}

        <section>
          <h2>State transitions</h2>
          {allowed.length === 0 ? (
            <p className="muted">No forward transitions — this lead is in a terminal state.</p>
          ) : (
            <div className="action-row">
              {allowed.map((next) => (
                <form key={next} action={doTransition}>
                  <input type="hidden" name="to" value={next} />
                  {next === 'closed' ? (
                    <>
                      <select name="closeReason" required defaultValue="">
                        <option value="" disabled>
                          Pick reason…
                        </option>
                        {CLOSE_REASONS.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        name="closeNote"
                        placeholder="Note (optional)"
                        maxLength={300}
                      />
                      <button type="submit" className="ghost-btn">
                        Close
                      </button>
                    </>
                  ) : (
                    <button type="submit">→ {next.replace(/_/g, ' ')}</button>
                  )}
                </form>
              ))}
            </div>
          )}
          {canAdminWorkspace(ctx) && lead.state !== 'closed' ? (
            <details className="qual-evidence" style={{ marginTop: '1rem' }}>
              <summary>Force a non-forward transition (admin)</summary>
              <form action={doForceTransition} className="inline-form">
                <label>
                  <span>To state</span>
                  <select name="to" defaultValue="">
                    <option value="" disabled>
                      Pick state…
                    </option>
                    {Object.keys(FORWARD_TRANSITIONS).map((st) => (
                      <option key={st} value={st}>
                        {st.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Close reason (if to=closed)</span>
                  <select name="closeReason" defaultValue="">
                    <option value="">—</option>
                    {CLOSE_REASONS.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="ghost-btn">
                  Force
                </button>
              </form>
            </details>
          ) : null}
        </section>

        <section>
          <h2>Contact</h2>
          <form action={saveContact} className="edit-draft-form">
            <label>
              <span>Name</span>
              <input
                type="text"
                name="contactName"
                defaultValue={lead.contactName ?? ''}
                maxLength={200}
              />
            </label>
            <label>
              <span>Email</span>
              <input
                type="email"
                name="contactEmail"
                defaultValue={lead.contactEmail ?? ''}
              />
            </label>
            <label>
              <span>Role</span>
              <input
                type="text"
                name="contactRole"
                defaultValue={lead.contactRole ?? ''}
                maxLength={120}
              />
            </label>
            <label>
              <span>Phone</span>
              <input
                type="text"
                name="contactPhone"
                defaultValue={lead.contactPhone ?? ''}
                maxLength={60}
              />
            </label>
            <label>
              <span>Contact notes</span>
              <textarea
                name="contactNotes"
                rows={3}
                defaultValue={lead.contactNotes ?? ''}
                maxLength={2000}
              />
            </label>
            <div className="action-row">
              <button type="submit" className="primary-btn">
                Save contact
              </button>
            </div>
          </form>
        </section>

        <section>
          <h2>Assignment</h2>
          <form action={saveAssignment} className="inline-form">
            <label>
              <span>Assigned user id</span>
              <input
                type="text"
                name="assignedToUserId"
                defaultValue={lead.assignedToUserId ?? ''}
                placeholder="leave blank to clear"
                maxLength={120}
              />
            </label>
            <button type="submit">Assign</button>
          </form>
        </section>

        <section>
          <h2>Notes</h2>
          <form action={saveNotes} className="edit-draft-form">
            <label>
              <span>Free-form notes</span>
              <textarea
                name="notes"
                rows={6}
                defaultValue={lead.notes ?? ''}
                maxLength={10000}
              />
            </label>
            <div className="action-row">
              <button type="submit" className="primary-btn">
                Save notes
              </button>
            </div>
          </form>
        </section>

        <section>
          <h2>CRM</h2>
          {activeCrm.length === 0 ? (
            <p className="muted">
              No CRM connections configured.{' '}
              <Link href="/settings/crm">Add one</Link> to push this lead.
            </p>
          ) : (
            <form action={pushCrm} className="inline-form">
              <label>
                <span>Connection</span>
                <select name="connectionId" required defaultValue="">
                  <option value="" disabled>
                    Pick a CRM…
                  </option>
                  {activeCrm.map((c) => (
                    <option key={c.id.toString()} value={c.id.toString()}>
                      {c.name} ({c.system})
                    </option>
                  ))}
                </select>
              </label>
              <label className="checkbox-row">
                <input type="checkbox" name="advance" defaultChecked />
                <span>Advance to synced_to_crm on success</span>
              </label>
              <button type="submit">Push contact</button>
            </form>
          )}
          {activeCrm.length > 0 ? (
            <>
              <form action={pushDealAction} className="inline-form" style={{ marginTop: '0.5rem' }}>
                <label>
                  <span>Create / update deal</span>
                  <select name="connectionId" required defaultValue="">
                    <option value="" disabled>
                      Pick a CRM…
                    </option>
                    {activeCrm.map((c) => (
                      <option key={c.id.toString()} value={c.id.toString()}>
                        {c.name} ({c.system})
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit">Push deal</button>
              </form>
              {linkedThreads.length > 0 ? (
                <form action={pushNotes} className="inline-form" style={{ marginTop: '0.5rem' }}>
                  <label>
                    <span>Push thread as notes</span>
                    <select name="threadId" required defaultValue="">
                      <option value="" disabled>
                        Pick a thread…
                      </option>
                      {linkedThreads.map((t) => (
                        <option key={t.id.toString()} value={t.id.toString()}>
                          {t.subject || '(no subject)'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Connection</span>
                    <select name="connectionId" required defaultValue="">
                      <option value="" disabled>
                        Pick a CRM…
                      </option>
                      {activeCrm.map((c) => (
                        <option key={c.id.toString()} value={c.id.toString()}>
                          {c.name} ({c.system})
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit">Push notes</button>
                </form>
              ) : null}
            </>
          ) : null}
          {recentSyncs.length > 0 ? (
            <ul className="timeline" style={{ marginTop: '0.75rem' }}>
              {recentSyncs.map((s) => (
                <li key={s.id.toString()}>
                  <span className="muted">{s.createdAt.toLocaleString()}</span>{' '}
                  <strong>{s.kind}</strong>
                  {' · '}
                  {s.outcome}
                  {s.statusCode ? ` · HTTP ${s.statusCode}` : ''}
                  {s.externalId ? ` · ext ${s.externalId}` : ''}
                  {s.error ? ` · ${s.error.slice(0, 200)}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section>
          <h2>Timeline</h2>
          <ul className="timeline">
            {events.map((e) => (
              <li key={e.id.toString()}>
                <span className="muted">{e.createdAt.toLocaleString()}</span>{' '}
                <strong>{e.eventKind}</strong>
                {e.fromState ? ` · ${e.fromState} → ${e.toState}` : ` · → ${e.toState}`}
                {e.actorUserId ? <span className="muted"> · {e.actorUserId.slice(0, 12)}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      </AppShell>
  );
}

function badgeFor(state: PipelineState): string {
  if (state === 'closed') return 'badge';
  if (state === 'qualified' || state === 'handed_over' || state === 'synced_to_crm') {
    return 'badge badge-good';
  }
  return 'badge';
}
