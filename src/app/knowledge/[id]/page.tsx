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
import { listProductProfiles } from '@/lib/services/product-profile';
import {
  KnowledgeSourceServiceError,
  deleteKnowledgeSource,
  getKnowledgeSource,
  knowledgeSourceErrorMessage,
  updateKnowledgeSource,
} from '@/lib/services/knowledge-sources';
import { NO_PRODUCT_TICKED_COPY, knowledgeScopeFromTicks } from '@/lib/services/knowledge-scope';
import { KnowledgeIndexError, requestKnowledgeIndex } from '@/lib/services/knowledge-indexing';
import { listIndexingJobs } from '@/lib/services/rag';
import type { ProductProfile } from '@/lib/db/schema/products';
import { isNextRedirectError } from '@/lib/server-redirect';
import { AutoRefresh } from '@/components/AutoRefresh';
import { ScopeChip } from '../scope-chip';
import { IndexStatusBadge, indexStatusExplanation, indexStatusMoving } from '../index-status';
import { IndexRunList } from '../index-run-list';

export default async function KnowledgeSourceDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/knowledge');
  const id = BigInt(idStr);
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/knowledge');
    throw err;
  }

  let detail;
  try {
    detail = await getKnowledgeSource(ctx, id);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof KnowledgeSourceServiceError && err.code === 'not_found') {
      redirect('/knowledge');
    }
    throw err;
  }

  const { source, document, scope } = detail;
  const attachedSet = new Set(scope.productProfileIds.map((pid) => pid.toString()));
  // Active products, plus any archived one the source is still scoped to:
  // leaving it out of the select would silently drop it on the next save.
  const allProducts: ProductProfile[] = (
    await listProductProfiles(ctx, { includeArchived: true })
  ).filter((p) => p.active || attachedSet.has(p.id.toString()));
  const productNames = new Map(allProducts.map((p) => [p.id.toString(), p.name]));
  const indexJobs = await listIndexingJobs(ctx, { knowledgeSourceId: source.id, limit: 5 });
  // KL-06: a queued or running run means the status is about to change.
  const runActive = indexJobs.some((j) => j.status === 'queued' || j.status === 'running');
  const moving = indexStatusMoving(source.indexStatus, runActive);

  async function saveEdits(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const title = String(formData.get('title') ?? '').trim();
    const summary = String(formData.get('summary') ?? '').trim();
    const language = String(formData.get('language') ?? 'en').trim() || 'en';
    const purposeRaw = String(formData.get('purposeCategory') ?? 'general');
    const purposeCategory = (
      purposeRaw === 'technical' ||
      purposeRaw === 'marketing' ||
      purposeRaw === 'case_study' ||
      purposeRaw === 'internal_note' ||
      purposeRaw === 'objection_handling'
        ? purposeRaw
        : 'general'
    ) as
      | 'technical'
      | 'marketing'
      | 'case_study'
      | 'internal_note'
      | 'objection_handling'
      | 'general';
    const rawTags = String(formData.get('tags') ?? '');
    const tags = rawTags.split(',').map((t) => t.trim()).filter(Boolean);
    const productIds = formData.getAll('productProfileIds')
      .map((v) => String(v))
      .filter((v) => /^\d+$/.test(v))
      .map((v) => BigInt(v));
    const url = String(formData.get('url') ?? '').trim();
    const textExcerpt = String(formData.get('textExcerpt') ?? '');

    const patch: Parameters<typeof updateKnowledgeSource>[2] = {
      title: title || undefined,
      summary: summary,
      language,
      purposeCategory,
      tags,
      // KL-05: no product ticked = available to every product (said on
      // the form). Re-scoping needs no re-index.
      scope: knowledgeScopeFromTicks(productIds),
    };
    if (source.kind === 'url' && url) patch.url = url;
    if (source.kind === 'text') patch.textExcerpt = textExcerpt;

    let stale = false;
    try {
      // KL-06: a change to the text, URL, summary or products marks the
      // source stale and queues a re-index; the old chunks serve until it
      // finishes.
      stale = (await updateKnowledgeSource(c, id, patch)).indexStatus === 'stale';
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = knowledgeSourceErrorMessage(err);
      if (m === null) throw err;
      redirect(`/knowledge/${id}?error=${encodeURIComponent(m)}`);
    }
    redirect(
      stale
        ? `/knowledge/${id}?message=${encodeURIComponent(
            'Saved. The change is being re-indexed; drafts use the previous version until it finishes.',
          )}`
        : `/knowledge/${id}`,
    );
  }

  // KL-06 (I103): never without the title typed; the service refuses too.
  async function destroy(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await deleteKnowledgeSource(c, id, { confirm: String(formData.get('confirm') ?? '') });
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = knowledgeSourceErrorMessage(err);
      if (m === null) throw err;
      redirect(`/knowledge/${id}?error=${encodeURIComponent(m)}`);
    }
    redirect(`/knowledge?message=${encodeURIComponent('Knowledge source deleted.')}`);
  }

  // KL-06 (I108): queue the run and return at once; the knowledge.index
  // job does the work and this page polls until it settles.
  async function reindex() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await requestKnowledgeIndex(c, id, { reason: 'reindex' });
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof KnowledgeIndexError
          ? err.message
          : knowledgeSourceErrorMessage(err) ?? (err instanceof Error ? err.message : 'index failed');
      redirect(`/knowledge/${id}?error=${encodeURIComponent(m)}`);
    }
    redirect(
      `/knowledge/${id}?message=${encodeURIComponent('Indexing queued. This page updates on its own.')}`,
    );
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/today">Today</Link> /{' '}
          <Link href="/knowledge">Knowledge</Link> / {source.title}
        </p>
        <h1>{source.title}</h1>
        <p>
          <span className="badge">{source.kind}</span>{' '}
          <ScopeChip scope={scope} productNames={productNames} />
        </p>
        {scope.needsScope ? (
          <p className="form-error" data-testid="needs-scope">
            Needs a scope: the products this source was attached to were deleted, so no
            draft or reply uses it. Tick products below, or save with none ticked to make
            it available to every product.
          </p>
        ) : null}

        <section>
          <h2>Source</h2>
          <dl>
            <dt>Kind</dt>
            <dd>
              <code>{source.kind}</code>
            </dd>
            <dt>Used for</dt>
            <dd>
              {scope.kind === 'workspace'
                ? 'Every product'
                : scope.needsScope
                  ? 'No product (needs a scope)'
                  : scope.productProfileIds
                      .map((pid) => productNames.get(pid.toString()) ?? `product ${pid}`)
                      .join(', ')}
            </dd>
            {source.kind === 'document' && document ? (
              <>
                <dt>Document</dt>
                <dd>
                  <Link href={`/documents/${document.id}`}>{document.name}</Link>
                  <span className="muted"> · {document.filename}</span>
                </dd>
              </>
            ) : null}
            {source.kind === 'url' && source.url ? (
              <>
                <dt>URL</dt>
                <dd>
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.url}
                  </a>
                </dd>
              </>
            ) : null}
            {source.kind === 'text' && source.textExcerpt ? (
              <>
                <dt>Excerpt</dt>
                <dd>
                  <pre className="draft-body">{source.textExcerpt}</pre>
                </dd>
              </>
            ) : null}
            <dt>Language</dt>
            <dd>
              <code>{source.language}</code>
            </dd>
            <dt>Purpose</dt>
            <dd>
              <code>{source.purposeCategory}</code>
            </dd>
            {source.tags.length > 0 ? (
              <>
                <dt>Tags</dt>
                <dd>{source.tags.join(', ')}</dd>
              </>
            ) : null}
            <dt>Created</dt>
            <dd>{source.createdAt.toLocaleString()}</dd>
          </dl>
        </section>

        {sp.message ? <p className="form-message">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <section>
          <h2>RAG indexing</h2>
          <p className="muted">
            Indexing routes this source through the workspace&apos;s active
            Vector Storage provider (see{' '}
            <Link href="/settings/integrations">Settings → Integrations</Link>).
            On the <code>pgvector</code> rail, chunks land in the local
            Postgres. On the <code>openai</code> rail, the file is uploaded
            to a per-product OpenAI Vector Store and chunked server-side.
          </p>
          <dl>
            <dt>Status</dt>
            <dd data-testid="index-status">
              <IndexStatusBadge status={source.indexStatus} />{' '}
              <span className="muted">{indexStatusExplanation(source, runActive)}</span>
            </dd>
            {source.indexedAt ? (
              <>
                <dt>Last indexed</dt>
                <dd>
                  {source.indexedAt.toLocaleString()}
                  {source.indexedEmbeddingModel ? (
                    <span className="muted"> · {source.indexedEmbeddingModel}</span>
                  ) : null}
                  {source.externalProviderId ? (
                    <span className="muted">
                      {' '}
                      · via <code>{source.externalProviderId}</code>
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
            {source.externalError ? (
              <>
                <dt>Attach warnings</dt>
                <dd className="muted">{source.externalError.slice(0, 300)}</dd>
              </>
            ) : null}
            {source.externalFileId ? (
              <>
                <dt>External file id</dt>
                <dd>
                  <code>{source.externalFileId}</code>
                </dd>
              </>
            ) : null}
          </dl>
          <form action={reindex}>
            <button type="submit">
              {source.indexedAt || source.indexStatus === 'indexed' ? 'Re-index' : 'Index now'}
            </button>
          </form>
          <IndexRunList jobs={indexJobs} />
          {moving ? <AutoRefresh reason="knowledge-index" /> : null}
        </section>

        <section>
          <h2>Edit</h2>
          <form action={saveEdits} className="edit-draft-form">
            <label>
              <span>Title</span>
              <input type="text" name="title" defaultValue={source.title} maxLength={240} required />
            </label>
            {source.kind === 'url' ? (
              <label>
                <span>URL</span>
                <input type="url" name="url" defaultValue={source.url ?? ''} required />
              </label>
            ) : null}
            {source.kind === 'text' ? (
              <label>
                <span>Excerpt</span>
                <textarea name="textExcerpt" rows={8} defaultValue={source.textExcerpt ?? ''} maxLength={200000} />
              </label>
            ) : null}
            <label>
              <span>Summary</span>
              <textarea name="summary" rows={3} defaultValue={source.summary ?? ''} maxLength={4000} />
            </label>
            <label>
              <span>Language</span>
              <input type="text" name="language" defaultValue={source.language} maxLength={8} />
            </label>
            <label>
              <span>Purpose</span>
              <select name="purposeCategory" defaultValue={source.purposeCategory}>
                <option value="general">General</option>
                <option value="technical">Technical specs</option>
                <option value="marketing">Marketing collateral</option>
                <option value="case_study">Case study</option>
                <option value="internal_note">Internal note</option>
                <option value="objection_handling">Objection handling</option>
              </select>
            </label>
            <label>
              <span>Tags (comma-separated)</span>
              <input type="text" name="tags" defaultValue={source.tags.join(', ')} maxLength={400} />
            </label>
            <p className="muted small" data-testid="scope-rule">
              {`${NO_PRODUCT_TICKED_COPY}.`}
            </p>
            <label>
              <span>Attached products</span>
              <select
                name="productProfileIds"
                multiple
                size={Math.min(8, Math.max(3, allProducts.length))}
                defaultValue={[...attachedSet]}
              >
                {allProducts.map((p) => (
                  <option key={p.id.toString()} value={p.id.toString()}>
                    {p.active ? p.name : `${p.name} (archived)`}
                  </option>
                ))}
              </select>
            </label>
            <div className="action-row">
              <button type="submit" className="primary-btn">
                Save
              </button>
            </div>
          </form>
        </section>

        {canAdminWorkspace(ctx) ? (
          <section>
            <h2>Admin</h2>
            <p className="muted">
              Deleting removes this source, its indexed passages and its copies in
              the vector store. Drafts stop using it at once. It cannot be undone.
            </p>
            <form action={destroy} className="inline-form" data-testid="delete-source">
              <label>
                <span>
                  Confirm by typing the title: <code>{source.title}</code>
                </span>
                <input
                  type="text"
                  name="confirm"
                  placeholder={source.title}
                  autoComplete="off"
                  required
                />
              </label>
              <button type="submit" className="ghost-btn">
                Delete permanently
              </button>
            </form>
          </section>
        ) : null}
      </AppShell>
  );
}
