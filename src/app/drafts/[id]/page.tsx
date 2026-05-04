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
  OutreachServiceError,
  approveOutreachDraft,
  archiveOutreachDraft,
  editOutreachDraft,
  generateOutreachDraft,
  getOutreachDraft,
  rejectOutreachDraft,
} from '@/lib/services/outreach';
import { enqueueDraft } from '@/lib/services/outreach-queue';
import { listMailboxes } from '@/lib/services/mailbox';
import type { OutreachDraftStatus } from '@/lib/db/schema/outreach';

export default async function DraftDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/drafts');
  const id = BigInt(idStr);

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/drafts');
    throw err;
  }

  let row;
  try {
    row = await getOutreachDraft(ctx, id);
  } catch (err) {
    if (err instanceof OutreachServiceError && err.code === 'not_found') {
      redirect('/drafts');
    }
    throw err;
  }

  const { draft, product, sourceRecord, reviewItem } = row;
  const mailboxes = await listMailboxes(ctx);
  const sendableMailboxes = mailboxes.filter((m) => m.status !== 'archived');
  const normalized = sourceRecord.normalizedData as Record<string, unknown>;
  const recordTitle =
    (normalized.title as string | undefined) ??
    sourceRecord.sourceUrl ??
    `Record ${sourceRecord.id}`;
  const isTerminal =
    draft.status === 'approved' ||
    draft.status === 'rejected' ||
    draft.status === 'superseded';

  // ---- server actions ----
  async function saveEdits(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const subject = String(formData.get('subject') ?? '').trim() || null;
    const body = String(formData.get('body') ?? '');
    await editOutreachDraft(c, id, { subject, body });
    redirect(`/drafts/${id}`);
  }
  async function enqueueForSend(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const mailboxIdRaw = String(formData.get('mailboxId') ?? '');
    if (!/^\d+$/.test(mailboxIdRaw)) return;
    const delayMode = String(formData.get('delayMode') ?? 'random') as
      | 'immediate'
      | 'fixed'
      | 'random';
    try {
      await enqueueDraft(c, {
        draftId: id,
        mailboxId: BigInt(mailboxIdRaw),
        delayMode,
      });
      redirect('/mailbox/queue?message=Enqueued');
    } catch (err) {
      const m = err instanceof Error ? err.message : 'failed';
      redirect(`/drafts/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  async function approve() {
    'use server';
    const c = await getWorkspaceContext();
    await approveOutreachDraft(c, id);
    redirect(`/drafts/${id}`);
  }
  async function reject(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const reason = String(formData.get('reason') ?? '').trim() || null;
    await rejectOutreachDraft(c, id, reason);
    redirect(`/drafts/${id}`);
  }
  async function regenerate(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const method = (String(formData.get('method') ?? 'rules') as 'rules' | 'ai' | 'hybrid');
    const created = await generateOutreachDraft(c, {
      reviewItemId: reviewItem.id,
      productProfileId: product.id,
      method,
    });
    redirect(`/drafts/${created.id}`);
  }
  async function archive() {
    'use server';
    const c = await getWorkspaceContext();
    await archiveOutreachDraft(c, id);
    redirect('/drafts');
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/drafts">Drafts</Link> / Draft {draft.id.toString()}
        </p>
        <h1>{draft.subject ?? `Draft ${draft.id}`}</h1>
        <p>
          <span className={statusBadgeClass(draft.status)}>
            {draft.status.replace('_', ' ')}
          </span>{' '}
          <span className="muted">
            for <Link href={`/products/${product.id}`}>{product.name}</Link> ·
            lead <Link href={`/review/${reviewItem.id}`}>{recordTitle}</Link>
          </span>
        </p>

        <section>
          <h2>Metadata</h2>
          <dl>
            <dt>Method</dt>
            <dd>
              <code>{draft.method}</code>
              {draft.model ? <span className="muted"> · {draft.model}</span> : null}
            </dd>
            <dt>Channel / language</dt>
            <dd>
              <code>{draft.channel}</code> / <code>{draft.language}</code>
            </dd>
            <dt>Confidence</dt>
            <dd>{draft.confidence}</dd>
            <dt>Created</dt>
            <dd>{draft.createdAt.toLocaleString()}</dd>
            {draft.editedAt ? (
              <>
                <dt>Last edit</dt>
                <dd>{draft.editedAt.toLocaleString()}</dd>
              </>
            ) : null}
            {draft.approvedAt ? (
              <>
                <dt>Approved</dt>
                <dd>{draft.approvedAt.toLocaleString()}</dd>
              </>
            ) : null}
            {draft.rejectedAt ? (
              <>
                <dt>Rejected</dt>
                <dd>
                  {draft.rejectedAt.toLocaleString()}
                  {draft.rejectionReason ? ` — ${draft.rejectionReason}` : ''}
                </dd>
              </>
            ) : null}
            {draft.forbiddenStripped.length > 0 ? (
              <>
                <dt>Forbidden phrases stripped</dt>
                <dd>
                  <code>{draft.forbiddenStripped.join(', ')}</code>
                </dd>
              </>
            ) : null}
          </dl>
        </section>

        <section>
          <h2>Content</h2>
          {isTerminal ? (
            <>
              <p>
                <strong>Subject:</strong> {draft.subject ?? <em className="muted">(none)</em>}
              </p>
              <pre className="draft-body">{draft.body}</pre>
            </>
          ) : (
            <form action={saveEdits} className="edit-draft-form">
              <label>
                <span>Subject</span>
                <input
                  name="subject"
                  type="text"
                  maxLength={200}
                  defaultValue={draft.subject ?? ''}
                />
              </label>
              <label>
                <span>Body</span>
                <textarea
                  name="body"
                  rows={14}
                  defaultValue={draft.body}
                  maxLength={20000}
                />
              </label>
              <div className="action-row">
                <button type="submit" className="primary-btn">
                  Save edits
                </button>
              </div>
            </form>
          )}
        </section>

        {!isTerminal ? (
          <section>
            <h2>Decisions</h2>
            <div className="action-row">
              <form action={approve}>
                <button type="submit" className="primary-btn">
                  Approve
                </button>
              </form>
            </div>
            <form action={reject} className="reject-form">
              <label>
                <span>Reject with reason</span>
                <input
                  name="reason"
                  type="text"
                  maxLength={500}
                  placeholder="e.g. tone is off, regenerate with new lessons"
                />
              </label>
              <button type="submit">Reject</button>
            </form>
            {sendableMailboxes.length > 0 ? (
              <form action={enqueueForSend} className="inline-form" style={{ marginTop: '0.75rem' }}>
                <label>
                  <span>Send via</span>
                  <select name="mailboxId" required defaultValue="">
                    <option value="" disabled>
                      Pick a mailbox…
                    </option>
                    {sendableMailboxes.map((m) => (
                      <option key={m.id.toString()} value={m.id.toString()}>
                        {m.name} ({m.fromAddress})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Delay</span>
                  <select name="delayMode" defaultValue="random">
                    <option value="immediate">immediate</option>
                    <option value="fixed">fixed</option>
                    <option value="random">random</option>
                  </select>
                </label>
                <button type="submit">Enqueue for send</button>
              </form>
            ) : null}
          </section>
        ) : null}

        <section>
          <h2>Regenerate</h2>
          <p className="muted">
            Replace this draft with a fresh one for the same lead + product. The
            current draft becomes <code>superseded</code> in the audit trail.
          </p>
          <form action={regenerate} className="inline-form">
            <label>
              <span>Method</span>
              <select name="method" defaultValue={draft.method}>
                <option value="rules">rules</option>
                <option value="ai">ai</option>
                <option value="hybrid">hybrid</option>
              </select>
            </label>
            <button type="submit">Regenerate</button>
          </form>
        </section>

        {canAdminWorkspace(ctx) && draft.status !== 'superseded' ? (
          <section>
            <h2>Admin</h2>
            <form action={archive}>
              <button type="submit" className="ghost-btn">
                Archive (mark superseded)
              </button>
            </form>
          </section>
        ) : null}
      </AppShell>
  );
}

function statusBadgeClass(status: OutreachDraftStatus): string {
  switch (status) {
    case 'approved':
      return 'badge badge-good';
    case 'rejected':
      return 'badge badge-bad';
    default:
      return 'badge';
  }
}
