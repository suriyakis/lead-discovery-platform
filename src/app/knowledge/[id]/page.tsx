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
import { listProductProfiles } from '@/lib/services/product-profile';
import {
  KnowledgeSourceServiceError,
  deleteKnowledgeSource,
  getKnowledgeSource,
  updateKnowledgeSource,
} from '@/lib/services/knowledge-sources';
import { indexKnowledgeSource, listIndexingJobs } from '@/lib/services/rag';
import type { ProductProfile } from '@/lib/db/schema/products';

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
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/knowledge');
    throw err;
  }

  let detail;
  try {
    detail = await getKnowledgeSource(ctx, id);
  } catch (err) {
    if (err instanceof KnowledgeSourceServiceError && err.code === 'not_found') {
      redirect('/knowledge');
    }
    throw err;
  }

  const { source, document } = detail;
  const allProducts: ProductProfile[] = await listProductProfiles(ctx, { includeArchived: false });
  const attachedSet = new Set(source.productProfileIds.map((id) => id.toString()));
  const indexJobs = await listIndexingJobs(ctx, { knowledgeSourceId: source.id, limit: 5 });

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
      productProfileIds: productIds,
    };
    if (source.kind === 'url' && url) patch.url = url;
    if (source.kind === 'text') patch.textExcerpt = textExcerpt;

    await updateKnowledgeSource(c, id, patch);
    redirect(`/knowledge/${id}`);
  }

  async function destroy() {
    'use server';
    const c = await getWorkspaceContext();
    await deleteKnowledgeSource(c, id);
    redirect('/knowledge');
  }

  async function reindex() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const result = await indexKnowledgeSource(c, id);
      redirect(`/knowledge/${id}?message=Indexed+${result.chunkCount}+chunks`);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'index failed';
      redirect(`/knowledge/${id}?error=${encodeURIComponent(m)}`);
    }
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
          <Link href="/knowledge">Knowledge</Link> / {source.title}
        </p>
        <h1>{source.title}</h1>
        <p>
          <span className="badge">{source.kind}</span>
        </p>

        <section>
          <h2>Source</h2>
          <dl>
            <dt>Kind</dt>
            <dd>
              <code>{source.kind}</code>
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
            Indexing splits this source into chunks and embeds them for
            similarity retrieval. Re-index after edits.
          </p>
          <form action={reindex}>
            <button type="submit">
              {indexJobs.some((j) => j.status === 'succeeded') ? 'Re-index' : 'Index now'}
            </button>
          </form>
          {indexJobs.length > 0 ? (
            <ul className="timeline" style={{ marginTop: '0.75rem' }}>
              {indexJobs.map((j) => (
                <li key={j.id.toString()}>
                  <span className="muted">{j.createdAt.toLocaleString()}</span>{' '}
                  <strong>{j.status}</strong>
                  {j.chunkCount > 0 ? ` · ${j.chunkCount} chunks` : ''}
                  {j.embeddingModel ? ` · ${j.embeddingModel}` : ''}
                  {j.error ? ` · ${j.error.slice(0, 200)}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
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
            <label>
              <span>Attached products</span>
              <select
                name="productProfileIds"
                multiple
                size={Math.min(8, Math.max(3, allProducts.length))}
              >
                {allProducts.map((p) => (
                  <option
                    key={p.id.toString()}
                    value={p.id.toString()}
                    selected={attachedSet.has(p.id.toString())}
                  >
                    {p.name}
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
            <form action={destroy}>
              <button type="submit" className="ghost-btn">
                Delete (cannot be undone)
              </button>
            </form>
          </section>
        ) : null}
      </main>
    </>
  );
}
