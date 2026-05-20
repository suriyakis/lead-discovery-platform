import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';
import {
  MessagesSquare,
  Mail,
  User,
  Clock,
  History,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { CommunicationReply } from '@/components/CommunicationReply';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { db } from '@/lib/db/client';
import { mailThreads, mailMessages, type MailMessage } from '@/lib/db/schema/mailing';
import { outreachThreadState } from '@/lib/db/schema/outreach';
import { outreachQueue } from '@/lib/db/schema/outreach';
import { qualifiedLeads, pipelineEvents } from '@/lib/db/schema/pipeline';
import { productProfiles, type ProductProfile } from '@/lib/db/schema/products';
import { listSignatures, defaultSignature } from '@/lib/services/signatures';
import { getMailbox } from '@/lib/services/mailbox';
import {
  markAsSpam,
  moveToTrash,
  restoreFromTrash,
  unmarkSpam,
} from '@/lib/services/mail';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function CommunicationDetail({
  params,
  searchParams,
}: {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { threadId: rawId } = await params;
  if (!/^\d+$/.test(rawId)) redirect('/communication');
  const threadId = BigInt(rawId);
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/communication');
    throw err;
  }

  // Thread + messages.
  const [thread] = await db
    .select()
    .from(mailThreads)
    .where(
      and(
        eq(mailThreads.workspaceId, ctx.workspaceId),
        eq(mailThreads.id, threadId),
      ),
    )
    .limit(1);
  if (!thread) redirect('/communication');
  const messages = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.workspaceId),
        eq(mailMessages.threadId, threadId),
      ),
    )
    .orderBy(mailMessages.createdAt);

  // P61-10: split into visible (in-conversation) vs hidden (trashed or
  // spammed). Hidden messages live inside a <details> expander so the
  // thread reads clean by default but the audit trail is one click away.
  const visibleMessages = messages.filter(
    (m) => !m.trashedAt && !m.spamAt,
  );
  const hiddenMessages = messages.filter(
    (m) => m.trashedAt || m.spamAt,
  );

  // P61-10: per-message actions inside the thread view. Each takes a
  // single message id (passed via .bind()) and redirects back to this
  // thread. No-op on rows that already match the target state.
  async function trashMessage(messageIdStr: string) {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await moveToTrash(c, [BigInt(messageIdStr)]);
      redirect(`/communication/${threadId}?message=Message+moved+to+trash`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(
        `/communication/${threadId}?error=${encodeURIComponent(
          err instanceof Error ? err.message : 'trash failed',
        )}`,
      );
    }
  }
  async function restoreMessage(messageIdStr: string) {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await restoreFromTrash(c, [BigInt(messageIdStr)]);
      redirect(`/communication/${threadId}?message=Message+restored`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(
        `/communication/${threadId}?error=${encodeURIComponent(
          err instanceof Error ? err.message : 'restore failed',
        )}`,
      );
    }
  }
  async function spamMessage(messageIdStr: string) {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await markAsSpam(c, [BigInt(messageIdStr)], 'manual');
      redirect(`/communication/${threadId}?message=Message+flagged+as+spam`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(
        `/communication/${threadId}?error=${encodeURIComponent(
          err instanceof Error ? err.message : 'spam failed',
        )}`,
      );
    }
  }
  async function unspamMessage(messageIdStr: string) {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await unmarkSpam(c, [BigInt(messageIdStr)]);
      redirect(`/communication/${threadId}?message=Spam+flag+cleared`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      redirect(
        `/communication/${threadId}?error=${encodeURIComponent(
          err instanceof Error ? err.message : 'unspam failed',
        )}`,
      );
    }
  }

  // Linked outreach state → lead → product.
  const [ots] = await db
    .select()
    .from(outreachThreadState)
    .where(
      and(
        eq(outreachThreadState.workspaceId, ctx.workspaceId),
        eq(outreachThreadState.threadId, threadId),
      ),
    )
    .limit(1);
  let lead = null;
  let product: ProductProfile | null = null;
  let history: Array<{ id: bigint; fromState: string | null; toState: string; eventKind: string; createdAt: Date }> = [];
  if (ots) {
    const [leadRow] = await db
      .select()
      .from(qualifiedLeads)
      .where(eq(qualifiedLeads.id, ots.qualifiedLeadId))
      .limit(1);
    lead = leadRow ?? null;
    if (lead) {
      const [productRow] = await db
        .select()
        .from(productProfiles)
        .where(eq(productProfiles.id, lead.productProfileId))
        .limit(1);
      product = productRow ?? null;
      const evRows = await db
        .select({
          id: pipelineEvents.id,
          fromState: pipelineEvents.fromState,
          toState: pipelineEvents.toState,
          eventKind: pipelineEvents.eventKind,
          createdAt: pipelineEvents.createdAt,
        })
        .from(pipelineEvents)
        .where(eq(pipelineEvents.qualifiedLeadId, lead.id))
        .orderBy(desc(pipelineEvents.createdAt))
        .limit(50);
      history = evRows;
    }
  }

  // Scheduled / queued sends keyed to this thread (by inReplyTo header
  // matching a message on the thread).
  const queuedRows = await db
    .select()
    .from(outreachQueue)
    .where(
      and(
        eq(outreachQueue.workspaceId, ctx.workspaceId),
        eq(outreachQueue.status, 'queued'),
      ),
    )
    .limit(50);
  const threadMessageIds = new Set(
    messages.map((m) => m.messageId).filter((id): id is string => !!id),
  );
  const scheduled = queuedRows.filter(
    (q) => q.inReplyTo && threadMessageIds.has(q.inReplyTo),
  );

  const mailbox = await getMailbox(ctx, thread.mailboxId);
  const sigs = await listSignatures(ctx, { mailboxId: thread.mailboxId });
  const def = await defaultSignature(ctx, thread.mailboxId);

  // Reply defaults: most recent inbound → reply-to-sender; if no inbound,
  // pre-fill the operator's own from-address so they can self-test.
  const lastInbound = [...messages]
    .reverse()
    .find((m) => m.direction === 'inbound');
  const replyTo = lastInbound?.fromAddress ?? mailbox.fromAddress;
  const lastMessage = messages[messages.length - 1] ?? null;
  const replyInReplyTo = lastMessage?.messageId ?? null;
  const replyReferences = lastMessage?.references ?? [];
  const baseSubject = thread.subject || '(no subject)';
  const replySubject = baseSubject.match(/^Re:/i)
    ? baseSubject
    : `Re: ${baseSubject}`;

  const sigOptions = sigs.map((s) => ({
    id: s.id.toString(),
    name: s.name,
    isDefault: s.isDefault,
  }));

  return (
    <AppShell>
      <nav
        className="muted"
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '0.4rem',
          marginBottom: '0.75rem',
          fontSize: '0.85rem',
        }}
      >
        <Link href="/dashboard">Dashboard</Link>
        <span aria-hidden>/</span>
        <Link href="/communication">Communication</Link>
        <span aria-hidden>/</span>
        <span
          style={{
            color: 'var(--brand-fg)',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '50ch',
          }}
        >
          {baseSubject}
        </span>
      </nav>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 0.85fr) minmax(0, 0.85fr) minmax(0, 1.6fr)',
          gap: '1rem',
          alignItems: 'flex-start',
        }}
      >
        {/* Left: contact + product + lead info */}
        <section className="profile-list-card" style={{ padding: '1rem' }}>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>
            <User className="lucide" /> Lead context
          </h2>
          <dl>
            <dt>Subject</dt>
            <dd>{baseSubject}</dd>
            <dt>Mailbox</dt>
            <dd>
              <Link href={`/mailbox/${mailbox.id}`}>{mailbox.name}</Link>
              <span className="muted"> · {mailbox.fromAddress}</span>
            </dd>
            {lead ? (
              <>
                <dt>Contact</dt>
                <dd>
                  {lead.contactName || '(unknown)'}
                  {lead.contactEmail ? (
                    <>
                      <br />
                      <a href={`mailto:${lead.contactEmail}`}>{lead.contactEmail}</a>
                    </>
                  ) : null}
                  {lead.contactRole ? (
                    <>
                      <br />
                      <span className="muted">{lead.contactRole}</span>
                    </>
                  ) : null}
                  {lead.contactPhone ? (
                    <>
                      <br />
                      <span className="muted">{lead.contactPhone}</span>
                    </>
                  ) : null}
                </dd>
              </>
            ) : (
              <>
                <dt>Contact</dt>
                <dd className="muted">
                  Not linked to a qualified lead yet. Participants:{' '}
                  {thread.participants.slice(0, 4).join(', ')}
                </dd>
              </>
            )}
            {product ? (
              <>
                <dt>Product</dt>
                <dd>
                  <Link href={`/products/${product.id}`}>{product.name}</Link>
                </dd>
              </>
            ) : null}
            {lead?.notes ? (
              <>
                <dt>Notes</dt>
                <dd>
                  <pre
                    className="muted"
                    style={{
                      margin: 0,
                      fontFamily: 'inherit',
                      whiteSpace: 'pre-wrap',
                      fontSize: '0.85em',
                    }}
                  >
                    {lead.notes}
                  </pre>
                </dd>
              </>
            ) : null}
            {lead?.tags && lead.tags.length > 0 ? (
              <>
                <dt>Tags</dt>
                <dd style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                  {lead.tags.map((t) => (
                    <span key={t} className="badge">
                      {t}
                    </span>
                  ))}
                </dd>
              </>
            ) : null}
          </dl>
          {lead ? (
            <div className="action-row" style={{ marginTop: '0.5rem' }}>
              <Link href={`/pipeline/${lead.id}`} className="ghost-btn">
                Full lead page
              </Link>
            </div>
          ) : null}
        </section>

        {/* Middle: state management */}
        <section className="profile-list-card" style={{ padding: '1rem' }}>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>
            <Clock className="lucide" /> State
          </h2>
          {lead ? (
            <dl>
              <dt>Pipeline state</dt>
              <dd>
                <span className="badge badge-good">{lead.state}</span>
              </dd>
              <dt>Outreach stage</dt>
              <dd>
                <span className="badge">{lead.currentStage}</span>
              </dd>
              {ots?.lastInboundIntent ? (
                <>
                  <dt>Last reply intent</dt>
                  <dd>
                    <span className="badge">{ots.lastInboundIntent}</span>
                    {ots.lastInboundConfidence != null ? (
                      <span className="muted"> · {ots.lastInboundConfidence}% conf</span>
                    ) : null}
                  </dd>
                </>
              ) : null}
              {ots?.closedAt ? (
                <>
                  <dt>Closed</dt>
                  <dd>
                    {ots.closedAt.toLocaleString()}
                    <br />
                    <span className="muted">{ots.closedReason}</span>
                  </dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="muted" style={{ fontSize: '0.85em' }}>
              No qualified-lead link for this thread.
            </p>
          )}

          <h3
            style={{ fontSize: '0.85rem', marginTop: '1rem', marginBottom: '0.4rem' }}
          >
            <Clock className="lucide" /> Scheduled sends
          </h3>
          {scheduled.length === 0 ? (
            <p className="muted" style={{ fontSize: '0.8em', margin: 0 }}>
              No queued sends for this thread.
            </p>
          ) : (
            <ul style={{ paddingLeft: '1rem', margin: 0, fontSize: '0.8em' }}>
              {scheduled.map((q) => (
                <li key={q.id.toString()}>
                  {q.scheduledSendAt.toLocaleString()} → {q.toAddresses.join(', ')}
                </li>
              ))}
            </ul>
          )}

          <h3
            style={{ fontSize: '0.85rem', marginTop: '1rem', marginBottom: '0.4rem' }}
          >
            <History className="lucide" /> State history
          </h3>
          {history.length === 0 ? (
            <p className="muted" style={{ fontSize: '0.8em', margin: 0 }}>
              No state transitions logged.
            </p>
          ) : (
            <ul
              className="timeline"
              style={{ fontSize: '0.78em', maxHeight: 280, overflow: 'auto' }}
            >
              {history.map((ev) => (
                <li key={ev.id.toString()}>
                  <span className="muted">{ev.createdAt.toLocaleString()}</span>
                  <br />
                  {ev.fromState ? `${ev.fromState} → ` : ''}
                  <strong>{ev.toState}</strong>
                  {ev.eventKind !== 'transition' ? (
                    <span className="muted"> · {ev.eventKind}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Right: conversation + reply composer */}
        <section className="profile-list-card" style={{ padding: '1rem' }}>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>
            <MessagesSquare className="lucide" /> Conversation
          </h2>
          {messages.length === 0 ? (
            <p className="muted" style={{ fontSize: '0.85em' }}>
              No messages yet — drafts only.
            </p>
          ) : (
            <>
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.6rem',
                  maxHeight: 380,
                  overflow: 'auto',
                  marginBottom: '0.75rem',
                }}
              >
                {visibleMessages.map((m: MailMessage) =>
                  renderMessageBubble(m, {
                    onTrash: trashMessage,
                    onSpam: spamMessage,
                    onRestore: restoreMessage,
                    onUnspam: unspamMessage,
                  }),
                )}
              </ul>
              {hiddenMessages.length > 0 ? (
                <details style={{ marginBottom: '0.75rem' }}>
                  <summary
                    style={{ cursor: 'pointer', fontSize: '0.82em' }}
                    className="muted"
                  >
                    Show {hiddenMessages.length} hidden message
                    {hiddenMessages.length === 1 ? '' : 's'} (trashed / spam)
                  </summary>
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: '0.5rem 0 0',
                      padding: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.6rem',
                      opacity: 0.75,
                    }}
                  >
                    {hiddenMessages.map((m: MailMessage) =>
                      renderMessageBubble(m, {
                        onTrash: trashMessage,
                        onSpam: spamMessage,
                        onRestore: restoreMessage,
                        onUnspam: unspamMessage,
                      }),
                    )}
                  </ul>
                </details>
              ) : null}
            </>
          )}

          {sp.message ? <p className="form-message">{sp.message}</p> : null}
          {sp.error ? <p className="form-error">{sp.error}</p> : null}

          <CommunicationReply
            threadId={threadId.toString()}
            mailboxId={thread.mailboxId.toString()}
            defaultTo={replyTo}
            defaultSubject={replySubject}
            inReplyTo={replyInReplyTo}
            references={replyReferences}
            signatures={sigOptions}
            defaultSignatureId={def?.id.toString() ?? null}
          />
        </section>
      </div>
    </AppShell>
  );
}

interface MessageBubbleActions {
  onTrash: (id: string) => Promise<void>;
  onSpam: (id: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onUnspam: (id: string) => Promise<void>;
}

function renderMessageBubble(
  m: MailMessage,
  actions: MessageBubbleActions,
) {
  const idStr = m.id.toString();
  const inTrash = m.trashedAt !== null;
  const inSpam = m.spamAt !== null;
  return (
    <li
      key={idStr}
      style={{
        padding: '0.5rem 0.75rem',
        borderRadius: '0.35rem',
        background:
          m.direction === 'inbound'
            ? 'rgba(28, 100, 242, 0.08)'
            : 'rgba(0, 0, 0, 0.04)',
        borderLeft:
          m.direction === 'inbound'
            ? '3px solid #1c64f2'
            : '3px solid rgba(0,0,0,0.25)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '0.78em',
          gap: '0.5rem',
        }}
      >
        <span>
          <Mail
            className="lucide"
            style={{ width: 14, height: 14 }}
          />{' '}
          <strong>{m.direction === 'inbound' ? '↓' : '↑'}</strong>{' '}
          {m.fromAddress}
          {inTrash ? (
            <span className="badge badge-bad" style={{ marginLeft: '0.4rem' }}>
              trashed
            </span>
          ) : null}
          {inSpam ? (
            <span className="badge badge-warn" style={{ marginLeft: '0.4rem' }}>
              spam{m.spamReason ? `: ${m.spamReason}` : ''}
            </span>
          ) : null}
        </span>
        <span
          className="muted"
          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}
        >
          <span>{(m.receivedAt ?? m.createdAt).toLocaleString()}</span>
          {/* Per-message action menu — small inline forms keyed by id. */}
          {!inTrash ? (
            <form
              action={actions.onTrash.bind(null, idStr)}
              style={{ display: 'inline' }}
            >
              <button
                type="submit"
                className="ghost-btn"
                style={{ padding: '0.05rem 0.4rem', fontSize: '0.78em' }}
                title="Move to trash"
              >
                Trash
              </button>
            </form>
          ) : (
            <form
              action={actions.onRestore.bind(null, idStr)}
              style={{ display: 'inline' }}
            >
              <button
                type="submit"
                className="ghost-btn"
                style={{ padding: '0.05rem 0.4rem', fontSize: '0.78em' }}
              >
                Restore
              </button>
            </form>
          )}
          {!inSpam && !inTrash ? (
            <form
              action={actions.onSpam.bind(null, idStr)}
              style={{ display: 'inline' }}
            >
              <button
                type="submit"
                className="ghost-btn"
                style={{ padding: '0.05rem 0.4rem', fontSize: '0.78em' }}
                title="Flag as spam"
              >
                Spam
              </button>
            </form>
          ) : null}
          {inSpam && !inTrash ? (
            <form
              action={actions.onUnspam.bind(null, idStr)}
              style={{ display: 'inline' }}
            >
              <button
                type="submit"
                className="ghost-btn"
                style={{ padding: '0.05rem 0.4rem', fontSize: '0.78em' }}
              >
                Not spam
              </button>
            </form>
          ) : null}
        </span>
      </div>
      <pre
        style={{
          margin: '0.4rem 0 0',
          fontFamily: 'inherit',
          fontSize: '0.85em',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 200,
          overflow: 'auto',
        }}
      >
        {(m.bodyText ?? '(no plain text body)').slice(0, 4000)}
      </pre>
    </li>
  );
}
