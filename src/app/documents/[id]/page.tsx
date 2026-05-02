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
  DocumentServiceError,
  archiveDocument,
  getDocument,
  restoreDocument,
  updateDocument,
} from '@/lib/services/documents';
import { listKnowledgeSources } from '@/lib/services/knowledge-sources';
import { indexDocument, listIndexingJobs } from '@/lib/services/rag';

export default async function DocumentDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/documents');
  const sp = await searchParams;
  const id = BigInt(idStr);

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/documents');
    throw err;
  }

  let detail;
  try {
    detail = await getDocument(ctx, id);
  } catch (err) {
    if (err instanceof DocumentServiceError && err.code === 'not_found') {
      redirect('/documents');
    }
    throw err;
  }

  const { document, url } = detail;
  const isArchived = document.status === 'archived';

  // Knowledge sources that reference this document
  const allKs = await listKnowledgeSources(ctx, { kind: 'document', limit: 1000 });
  const referencingKs = allKs.filter(
    (r) => r.source.documentId !== null && r.source.documentId === document.id,
  );
  const indexJobs = await listIndexingJobs(ctx, { documentId: document.id, limit: 5 });

  async function saveEdits(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const name = String(formData.get('name') ?? '').trim();
    const rawTags = String(formData.get('tags') ?? '');
    const tags = rawTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    await updateDocument(c, id, {
      name: name || undefined,
      tags,
    });
    redirect(`/documents/${id}`);
  }

  async function archive() {
    'use server';
    const c = await getWorkspaceContext();
    await archiveDocument(c, id);
    redirect(`/documents/${id}`);
  }

  async function restore() {
    'use server';
    const c = await getWorkspaceContext();
    await restoreDocument(c, id);
    redirect(`/documents/${id}`);
  }

  async function reindex() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const result = await indexDocument(c, id);
      redirect(
        `/documents/${id}?message=Indexed+${result.chunkCount}+chunks`,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : 'index failed';
      redirect(`/documents/${id}?error=${encodeURIComponent(m)}`);
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
          <Link href="/documents">Documents</Link> / {document.name}
        </p>
        <h1>{document.name}</h1>
        <p>
          <span className={isArchived ? 'badge badge-bad' : 'badge badge-good'}>
            {document.status}
          </span>
        </p>

        <section>
          <h2>Metadata</h2>
          <dl>
            <dt>Filename</dt>
            <dd>{document.filename}</dd>
            <dt>MIME type</dt>
            <dd>
              <code>{document.mimeType}</code>
            </dd>
            <dt>Size</dt>
            <dd>{document.sizeBytes.toLocaleString()} bytes</dd>
            <dt>SHA-256</dt>
            <dd>
              <code>{document.sha256.slice(0, 16)}…</code>
            </dd>
            <dt>Storage</dt>
            <dd>
              <code>{document.storageProvider}</code>:{' '}
              <code>{document.storageKey}</code>
            </dd>
            <dt>Uploaded</dt>
            <dd>{document.createdAt.toLocaleString()}</dd>
            {document.tags.length > 0 ? (
              <>
                <dt>Tags</dt>
                <dd>{document.tags.join(', ')}</dd>
              </>
            ) : null}
          </dl>
        </section>

        {!isArchived ? (
          <section>
            <h2>Download</h2>
            <p className="muted">
              The link below uses the storage provider&apos;s URL strategy
              (presigned for S3, file:// for local).
            </p>
            <p>
              <a href={url} target="_blank" rel="noreferrer" className="primary-btn">
                Download {document.filename}
              </a>
            </p>
          </section>
        ) : null}

        {!isArchived ? (
          <section>
            <h2>Edit</h2>
            <form action={saveEdits} className="edit-draft-form">
              <label>
                <span>Display name</span>
                <input
                  type="text"
                  name="name"
                  defaultValue={document.name}
                  maxLength={200}
                />
              </label>
              <label>
                <span>Tags (comma-separated)</span>
                <input
                  type="text"
                  name="tags"
                  defaultValue={document.tags.join(', ')}
                  maxLength={400}
                />
              </label>
              <div className="action-row">
                <button type="submit" className="primary-btn">
                  Save
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {sp.message ? <p className="form-message">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        {!isArchived ? (
          <section>
            <h2>RAG indexing</h2>
            <p className="muted">
              Indexing chunks the document content and embeds it for retrieval.
              Re-index whenever the bytes change or you want to refresh embeddings.
            </p>
            <form action={reindex}>
              <button type="submit">
                {indexJobs.some((j) => j.status === 'succeeded')
                  ? 'Re-index'
                  : 'Index now'}
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
        ) : null}

        <section>
          <h2>Referenced by knowledge sources</h2>
          {referencingKs.length === 0 ? (
            <p className="muted">
              No knowledge sources reference this document yet.{' '}
              <Link href="/knowledge/new">Create one</Link>.
            </p>
          ) : (
            <ul className="profile-list">
              {referencingKs.map(({ source }) => (
                <li key={source.id.toString()}>
                  <Link href={`/knowledge/${source.id}`}>{source.title}</Link>
                  {source.summary ? <p className="muted">{source.summary}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {canAdminWorkspace(ctx) ? (
          <section>
            <h2>Admin</h2>
            {isArchived ? (
              <form action={restore}>
                <button type="submit">Restore</button>
              </form>
            ) : (
              <form action={archive}>
                <button type="submit" className="ghost-btn">
                  Archive
                </button>
              </form>
            )}
          </section>
        ) : null}
      </main>
    </>
  );
}
