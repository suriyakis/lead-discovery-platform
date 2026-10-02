import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import { flashText } from '@/lib/action-errors';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace, canWrite } from '@/lib/services/context';
import { newDecisionKey } from '@/lib/services/learning-decisions';
import { ReviewServiceError, getReviewItem } from '@/lib/services/review';
import { listQualificationsForRecord } from '@/lib/services/qualification';
import { activeDraftFor } from '@/lib/services/outreach';
import {
  approveReviewItemAction,
  archiveReviewItemAction,
  commentOnReviewItemAction,
  flagReviewItemAction,
  generateDraftAction,
  ignoreReviewItemAction,
  rejectReviewItemAction,
} from './actions';

export default async function ReviewDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string | string[]; error?: string | string[] }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/review');
  const id = BigInt(idStr);
  const sp = await searchParams;
  const flashMessage = flashText(sp.message);
  const flashError = flashText(sp.error);

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
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
  const activeDrafts = await Promise.all(
    qualList.map(async ({ product }) => {
      const draft = await activeDraftFor(ctx, item.id, product.id);
      return { productId: product.id, draft };
    }),
  );
  const activeDraftByProduct = new Map(
    activeDrafts.map((d) => [d.productId.toString(), d.draft]),
  );
  const normalized = sourceRecord.normalizedData as Record<string, unknown>;
  const title = (normalized.title as string | undefined) ?? sourceRecord.sourceUrl ?? `Record ${sourceRecord.id}`;
  const snippet = normalized.snippet as string | undefined;
  const url = (normalized.url as string | undefined) ?? sourceRecord.sourceUrl;
  const domain = normalized.domain as string | undefined;

  // ---- server actions (./actions.ts, bound to this item's id) ----
  const itemKey = id.toString();
  const approve = approveReviewItemAction.bind(null, itemKey);
  const reject = rejectReviewItemAction.bind(null, itemKey);
  const ignore = ignoreReviewItemAction.bind(null, itemKey);
  const flag = flagReviewItemAction.bind(null, itemKey);
  const archive = archiveReviewItemAction.bind(null, itemKey);
  const postComment = commentOnReviewItemAction.bind(null, itemKey);
  const generateDraft = generateDraftAction.bind(null, itemKey);

  // Viewers can read everything here, but they don't get buttons that
  // can only fail for them (the services refuse !canWrite).
  const canEdit = canWrite(ctx);
  const isArchived = item.state === 'archived';
  // One nonce per decision control (KL-02): a double submit, or a resubmit
  // after Back, records the decision once. Each render gets fresh ones, so a
  // deliberate second decision is a new decision.
  const decisionKey = () => <input type="hidden" name="decisionKey" value={newDecisionKey()} />;

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/review">Review</Link> / Item {item.id.toString()}
        </p>
        <h1>{title}</h1>
        <p>
          <span className="badge">{item.state}</span>
        </p>

        {flashMessage || flashError ? (
          <div className="flash-stack">
            {flashMessage ? (
              <p className="mail-flash info" role="status">
                {flashMessage}
              </p>
            ) : null}
            {flashError ? (
              <p className="mail-flash error" role="alert">
                {flashError}
              </p>
            ) : null}
          </div>
        ) : null}

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
                      {qualification.operatorVerdict === 'fit' ? (
                        <span className="badge badge-good">marked Fit</span>
                      ) : null}
                      {qualification.operatorVerdict === 'not_fit' ? (
                        <span className="badge badge-bad">marked Not a fit</span>
                      ) : null}
                      {qualification.geoStatus === 'match' ? (
                        <span className="badge badge-good">
                          geo ✓ {qualification.inferredCountry}
                        </span>
                      ) : null}
                      {qualification.geoStatus === 'mismatch' ? (
                        <span className="badge badge-bad">
                          geo ✗ {qualification.inferredCountry} (target {qualification.targetCountry})
                        </span>
                      ) : null}
                      {qualification.geoStatus === 'unverified' ? (
                        <span className="badge badge-warn">
                          geo? location unverified — target {qualification.targetCountry}
                        </span>
                      ) : null}
                    </div>
                    {qualification.geoStatus === 'unverified' && qualification.isRelevant ? (
                      <p className="qual-reason qual-reason-bad">
                        <strong>Verify location before approving:</strong> the company&apos;s
                        country could not be confirmed. Approving this item confirms the
                        company is inside the target country ({qualification.targetCountry})
                        — otherwise reject it. Unapproved geo-unverified leads are never
                        sent outreach.
                      </p>
                    ) : null}
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
                    <div className="qual-draft-row">
                      {activeDraftByProduct.get(product.id.toString()) ? (
                        <Link
                          href={`/drafts/${activeDraftByProduct.get(product.id.toString())!.id}`}
                          className="primary-btn"
                        >
                          Open draft →
                        </Link>
                      ) : null}
                      {qualification.operatorVerdict === 'not_fit' ? (
                        <p className="muted">
                          Marked Not a fit for {product.name}: no draft, no pipeline lead
                          and no autopilot outreach for this product.
                        </p>
                      ) : null}
                      {canEdit && !isArchived && qualification.operatorVerdict !== 'not_fit' ? (
                        <form action={generateDraft} className="generate-draft-form">
                          <input type="hidden" name="productId" value={product.id.toString()} />
                          <select name="method" defaultValue="rules">
                            <option value="rules">rules</option>
                            <option value="ai">ai</option>
                            <option value="hybrid">hybrid</option>
                          </select>
                          <button type="submit">
                            {activeDraftByProduct.get(product.id.toString())
                              ? 'Regenerate'
                              : 'Generate draft'}
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {!isArchived && !canEdit ? (
          <section>
            <h2>Actions</h2>
            <p className="muted">
              Read-only — your role in this workspace can view review items but not
              approve, reject, comment on or draft outreach for them.
            </p>
          </section>
        ) : null}

        {!isArchived && canEdit ? (
          <section>
            <h2>Actions</h2>
            <div className="action-row">
              <form action={ignore}>
                {decisionKey()}
                <button type="submit">Ignore</button>
              </form>
              <form action={flag}>
                <button type="submit">Flag for review</button>
              </form>
              {canAdminWorkspace(ctx) ? (
                <form action={archive}>
                  {decisionKey()}
                  <button type="submit" className="ghost-btn">
                    Archive
                  </button>
                </form>
              ) : null}
            </div>

            <form action={approve} className="approve-form">
              {decisionKey()}
              <label>
                <span>Approve — why does this fit? (optional, teaches the knowledge base)</span>
                <input
                  name="reason"
                  type="text"
                  maxLength={500}
                  placeholder="e.g. exact ICP, right buying role, active tender"
                />
              </label>
              <button type="submit" className="primary-btn">Approve</button>
            </form>

            <form action={reject} className="reject-form">
              {decisionKey()}
              <label>
                <span>Reject — why doesn&apos;t this fit? (teaches the knowledge base)</span>
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

          {canEdit && !isArchived ? (
            <form action={postComment} className="comment-form">
              {decisionKey()}
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
      </AppShell>
  );
}
