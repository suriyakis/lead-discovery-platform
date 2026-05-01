import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  ReviewServiceError,
  approveReviewItem,
  archiveReviewItem,
  commentOnReviewItem,
  flagForReview,
  getReviewItem,
  ignoreReviewItem,
  rejectReviewItem,
} from '@/lib/services/review';
import { listQualificationsForRecord } from '@/lib/services/qualification';

export default async function ReviewDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/review');
  const id = BigInt(idStr);

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/review');
    throw err;
  }

  let detail;
  try {
    detail = await getReviewItem(ctx, id);
  } catch (err) {
    if (err instanceof ReviewServiceError && err.code === 'not_found') {
      redirect('/review');
    }
    throw err;
  }

  const { item, sourceRecord, comments } = detail;
  const qualList = await listQualificationsForRecord(ctx, sourceRecord.id);
  const normalized = sourceRecord.normalizedData as Record<string, unknown>;
  const title = (normalized.title as string | undefined) ?? sourceRecord.sourceUrl ?? `Record ${sourceRecord.id}`;
  const snippet = normalized.snippet as string | undefined;
  const url = (normalized.url as string | undefined) ?? sourceRecord.sourceUrl;
  const domain = normalized.domain as string | undefined;

  // ---- server actions ----
  async function approve() {
    'use server';
    const c = await getWorkspaceContext();
    await approveReviewItem(c, id);
    redirect(`/review/${id}`);
  }
  async function reject(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const reason = String(formData.get('reason') ?? '').trim() || null;
    await rejectReviewItem(c, id, reason);
    redirect(`/review/${id}`);
  }
  async function ignore() {
    'use server';
    const c = await getWorkspaceContext();
    await ignoreReviewItem(c, id);
    redirect(`/review/${id}`);
  }
  async function flag() {
    'use server';
    const c = await getWorkspaceContext();
    await flagForReview(c, id);
    redirect(`/review/${id}`);
  }
  async function archive() {
    'use server';
    const c = await getWorkspaceContext();
    await archiveReviewItem(c, id);
    redirect('/review');
  }
  async function postComment(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const text = String(formData.get('comment') ?? '').trim();
    if (!text) return;
    await commentOnReviewItem(c, id, text);
    redirect(`/review/${id}`);
  }

  return (
    <>
      <BrandHeader
        rightSlot={
          <>
            <span className="who">{session.user.email}</span>
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/' });
              }}
            >
              <button type="submit" className="ghost-btn">
                Sign out
              </button>
            </form>
          </>
        }
      />
      <main>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/review">Review</Link> / Item {item.id.toString()}
        </p>
        <h1>{title}</h1>
        <p>
          <span className="badge">{item.state}</span>
        </p>

        <section>
          <h2>Source</h2>
          <dl>
            {domain ? (
              <>
                <dt>Domain</dt>
                <dd>{domain}</dd>
              </>
            ) : null}
            {url ? (
              <>
                <dt>URL</dt>
                <dd>
                  <a href={url} target="_blank" rel="noreferrer">
                    {url}
                  </a>
                </dd>
              </>
            ) : null}
            <dt>Source system</dt>
            <dd>
              <code>{sourceRecord.sourceSystem}</code>
            </dd>
            <dt>Source ID</dt>
            <dd>
              <code>{sourceRecord.sourceId}</code>
            </dd>
            <dt>Confidence</dt>
            <dd>{sourceRecord.confidence}</dd>
            {snippet ? (
              <>
                <dt>Snippet</dt>
                <dd>{snippet}</dd>
              </>
            ) : null}
          </dl>
        </section>

        <section>
          <h2>Qualifications ({qualList.length})</h2>
          {qualList.length === 0 ? (
            <p className="muted">
              No active product profiles. Create one to start classifying records.
            </p>
          ) : (
            <ul className="qual-list">
              {qualList.map(({ qualification, product }) => {
                const evidence = qualification.evidence as {
                  contributions?: Array<{ kind: string; value: string; delta: number }>;
                };
                const contribs = evidence.contributions ?? [];
                return (
                  <li key={qualification.id.toString()}>
                    <div className="qual-head">
                      <Link href={`/products/${product.id}`}>{product.name}</Link>
                      <span className={qualification.isRelevant ? 'badge badge-good' : 'badge badge-bad'}>
                        {qualification.isRelevant ? 'relevant' : 'not relevant'}
                      </span>
                      <span className="qual-score">
                        score <strong>{qualification.relevanceScore}</strong>
                        <span className="muted"> · threshold {product.relevanceThreshold}</span>
                      </span>
                      <span className="muted">conf {qualification.confidence}</span>
                      <span className="muted">via {qualification.method}</span>
                    </div>
                    {qualification.qualificationReason ? (
                      <p className="qual-reason qual-reason-good">
                        <strong>Why qualified:</strong> {qualification.qualificationReason}
                      </p>
                    ) : null}
                    {qualification.rejectionReason ? (
                      <p className="qual-reason qual-reason-bad">
                        <strong>Why rejected:</strong> {qualification.rejectionReason}
                      </p>
                    ) : null}
                    {qualification.matchedKeywords.length > 0 ? (
                      <p className="muted">
                        Matched keywords: {qualification.matchedKeywords.join(', ')}
                      </p>
                    ) : null}
                    {qualification.disqualifyingSignals.length > 0 ? (
                      <p className="muted">
                        Disqualifying: {qualification.disqualifyingSignals.join(', ')}
                      </p>
                    ) : null}
                    {contribs.length > 0 ? (
                      <details className="qual-evidence">
                        <summary>Evidence ({contribs.length} contributions)</summary>
                        <ul className="contrib-list">
                          {contribs.map((c, idx) => (
                            <li key={idx}>
                              <code>{c.kind}</code> · {c.value} ·{' '}
                              <span className={c.delta >= 0 ? 'delta-good' : 'delta-bad'}>
                                {c.delta > 0 ? `+${c.delta}` : c.delta}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {item.state !== 'archived' ? (
          <section>
            <h2>Actions</h2>
            <div className="action-row">
              <form action={approve}>
                <button type="submit" className="primary-btn">
                  Approve
                </button>
              </form>
              <form action={ignore}>
                <button type="submit">Ignore</button>
              </form>
              <form action={flag}>
                <button type="submit">Flag for review</button>
              </form>
              {canAdminWorkspace(ctx) ? (
                <form action={archive}>
                  <button type="submit" className="ghost-btn">
                    Archive
                  </button>
                </form>
              ) : null}
            </div>

            <form action={reject} className="reject-form">
              <label>
                <span>Reject with reason</span>
                <input
                  name="reason"
                  type="text"
                  maxLength={500}
                  placeholder="e.g. wrong sector, too small, already a customer"
                />
              </label>
              <button type="submit">Reject</button>
            </form>
          </section>
        ) : null}

        <section>
          <h2>Comments ({comments.length})</h2>
          {comments.length === 0 ? (
            <p className="muted">No comments yet.</p>
          ) : (
            <ul className="comment-list">
              {comments.map(({ comment, author }) => (
                <li key={comment.id.toString()}>
                  <p className="comment-meta">
                    <strong>{author?.name ?? author?.email ?? 'unknown'}</strong>{' '}
                    <span className="muted">
                      · {comment.createdAt.toLocaleString()}
                    </span>
                  </p>
                  <p className="comment-body">{comment.comment}</p>
                </li>
              ))}
            </ul>
          )}

          {item.state !== 'archived' ? (
            <form action={postComment} className="comment-form">
              <label>
                <span>Add comment</span>
                <textarea
                  name="comment"
                  rows={3}
                  maxLength={5000}
                  placeholder="What did you think? The learning layer reads these later."
                />
              </label>
              <button type="submit" className="primary-btn">
                Post comment
              </button>
            </form>
          ) : null}
        </section>
      </main>
    </>
  );
}
