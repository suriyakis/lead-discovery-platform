import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Languages } from 'lucide-react';
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
import {
  TranslationError,
  translateFromEnglish,
} from '@/lib/services/translation';
import {
  getLanguageName,
  resolveProfileLanguage,
} from '@/lib/i18n/language';
import type { OutreachDraftStatus } from '@/lib/db/schema/outreach';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function DraftDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ msg?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/drafts');
  const id = BigInt(idStr);
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/drafts');
    throw err;
  }

  let row;
  try {
    row = await getOutreachDraft(ctx, id);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
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
  async function translateAndSave(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const body = String(formData.get('body') ?? '');
    if (!body.trim()) redirect(`/drafts/${id}`);
    const targetLang = resolveProfileLanguage(product);
    if (targetLang === 'en' || targetLang.startsWith('en-')) {
      // Already English — no-op, but persist any pending edits.
      const subject = String(formData.get('subject') ?? '').trim() || null;
      await editOutreachDraft(c, id, { subject, body });
      redirect(`/drafts/${id}?msg=already-english`);
    }
    try {
      const result = await translateFromEnglish(c, {
        text: body,
        targetLanguage: targetLang,
      });
      const subject = String(formData.get('subject') ?? '').trim() || null;
      await editOutreachDraft(c, id, { subject, body: result.translatedText });
      redirect(`/drafts/${id}?msg=translated-to-${targetLang}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof TranslationError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'translate failed';
      redirect(`/drafts/${id}?error=${encodeURIComponent(m)}`);
    }
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
      if (isNextRedirectError(err)) throw err;
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

  const banner = sp.error
    ? { tone: 'error' as const, text: sp.error }
    : sp.msg === 'already-english'
      ? {
          tone: 'info' as const,
          text: "Product language is English — kept the body as-is.",
        }
      : sp.msg?.startsWith('translated-to-')
        ? {
            tone: 'info' as const,
            text: `Body translated to ${getLanguageName(sp.msg.replace('translated-to-', ''))} and saved. Review before approving.`,
          }
        : null;

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/drafts">Drafts</Link> / Draft {draft.id.toString()}
        </p>
        <h1>{draft.subject ?? `Draft ${draft.id}`}</h1>
        {banner ? (
          <p
            className={banner.tone === 'error' ? 'form-error' : 'form-info'}
            style={{ marginBottom: '1rem' }}
          >
            {banner.text}
          </p>
        ) : null}
        <p>
          <span className={statusBadgeClass(draft.status)}>
            {draft.status.replace('_', ' ')}
          </span>{' '}
          <span className="badge">{draft.stage}</span>{' '}
          {draft.model ? (
            <span className="badge" title={draft.model}>
              {draft.model.toLowerCase().includes('opus')
                ? 'opus-4.7'
                : draft.model.toLowerCase().includes('sonnet')
                  ? 'sonnet'
                  : draft.model.toLowerCase().includes('haiku')
                    ? 'haiku'
                    : draft.model.startsWith('gpt-5-nano')
                      ? 'gpt-5-nano'
                      : draft.model.startsWith('gpt-5')
                        ? 'gpt-5'
                        : draft.model}
            </span>
          ) : null}{' '}
          <span className="muted">
            for <Link href={`/products/${product.id}`}>{product.name}</Link> ·
            review <Link href={`/review/${reviewItem.id}`}>{recordTitle}</Link>
            {' · '}
            <Link href={`/pipeline?reviewItem=${reviewItem.id}`}>see in pipeline</Link>
          </span>
        </p>

        {draft.stage !== 'discovery' ? (
          <ThreadContextSection
            workspaceId={ctx.workspaceId}
            triggeredByMessageId={draft.triggeredByMessageId}
          />
        ) : null}

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
                {(() => {
                  const target = resolveProfileLanguage(product);
                  if (target === 'en' || target.startsWith('en-')) return null;
                  return (
                    <button
                      type="submit"
                      formAction={translateAndSave}
                      className="ghost-btn translate-draft-btn"
                    >
                      <Languages className="primary-btn-icon" aria-hidden="true" />
                      <span>Translate to {getLanguageName(target)} &amp; save</span>
                    </button>
                  );
                })()}
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

/**
 * Phase E — render the inbound message that triggered this draft so
 * the operator sees the conversation context above the proposed reply.
 * For drafts at stage > discovery only.
 */
async function ThreadContextSection({
  workspaceId,
  triggeredByMessageId,
}: {
  workspaceId: bigint;
  triggeredByMessageId: bigint | null;
}) {
  if (!triggeredByMessageId) {
    return (
      <section>
        <h2>Conversation context</h2>
        <p className="muted">
          This draft was generated without a specific inbound trigger
          (operator-initiated regeneration or referral fork).
        </p>
      </section>
    );
  }
  const { db } = await import('@/lib/db/client');
  const { mailMessages } = await import('@/lib/db/schema/mailing');
  const { and, asc, eq } = await import('drizzle-orm');
  const triggerRows = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, workspaceId),
        eq(mailMessages.id, triggeredByMessageId),
      ),
    )
    .limit(1);
  const trigger = triggerRows[0];
  if (!trigger) {
    return null;
  }
  const threadRows = trigger.threadId
    ? await db
        .select()
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.workspaceId, workspaceId),
            eq(mailMessages.threadId, trigger.threadId),
          ),
        )
        .orderBy(asc(mailMessages.id))
    : [trigger];
  const last5 = threadRows.slice(-5);
  return (
    <section>
      <h2>Conversation context</h2>
      <p className="muted">
        Most recent {last5.length} message(s) in this thread. The reply
        below is your proposed response to the last inbound.
      </p>
      <ol className="thread-history">
        {last5.map((m) => (
          <li
            key={m.id.toString()}
            className={m.direction === 'inbound' ? 'msg-inbound' : 'msg-outbound'}
            style={{
              padding: '0.5rem 0.75rem',
              marginBottom: '0.5rem',
              borderLeft: `3px solid ${m.direction === 'inbound' ? 'oklch(0.75 0.15 220)' : 'oklch(0.85 0.05 100)'}`,
            }}
          >
            <p className="muted" style={{ margin: 0 }}>
              <strong>{m.direction === 'inbound' ? '← ' : '→ '}</strong>
              <code>{m.fromName ?? m.fromAddress}</code>
              {' · '}
              {(m.receivedAt ?? m.sentAt ?? m.createdAt).toLocaleString()}
            </p>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
                margin: '0.25rem 0 0',
                fontSize: '0.92em',
              }}
            >
              {(m.bodyText ?? '').slice(0, 1200)}
              {(m.bodyText ?? '').length > 1200 ? '\n…' : ''}
            </pre>
          </li>
        ))}
      </ol>
    </section>
  );
}
