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
  DocumentServiceError,
  archiveDocument,
  getDocument,
  restoreDocument,
  updateDocument,
} from '@/lib/services/documents';
import { listDocumentSources } from '@/lib/services/knowledge-sources';
import { isPdfDocument } from '@/lib/services/document-extraction';
import {
  KnowledgeIndexError,
  describeOcrCost,
  estimateDocumentOcr,
  requestDocumentIndex,
  requestDocumentOcrReextract,
} from '@/lib/services/knowledge-indexing';
import { listProductProfiles } from '@/lib/services/product-profile';
import { listIndexingJobs } from '@/lib/services/rag';
import { isNextRedirectError } from '@/lib/server-redirect';
import { AutoRefresh } from '@/components/AutoRefresh';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { ScopeChip } from '@/app/knowledge/scope-chip';
import { IndexStatusBadge, indexStatusMoving } from '@/app/knowledge/index-status';
import { IndexRunList } from '@/app/knowledge/index-run-list';

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
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/documents');
    throw err;
  }

  let detail;
  try {
    detail = await getDocument(ctx, id);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof DocumentServiceError && err.code === 'not_found') {
      redirect('/documents');
    }
    throw err;
  }

  const { document, url } = detail;
  const isArchived = document.status === 'archived';
  // Storage key and checksum are operator detail: admins only.
  const isAdmin = canAdminWorkspace(ctx);

  // KL-05: a document reaches retrieval only through the knowledge
  // source(s) wrapping it, so this page shows those sources (with their
  // scope) and THEIR indexing runs. Before KL-05 it listed runs by
  // document id only, missed the source's runs, offered "Index now" on an
  // indexed document and the click wrote a second, unscoped copy (I039).
  const [referencingKs, indexJobs, products] = await Promise.all([
    listDocumentSources(ctx, document.id),
    listIndexingJobs(ctx, { documentId: document.id, limit: 5 }),
    listProductProfiles(ctx, { includeArchived: true }),
  ]);
  const productNames = new Map(products.map((p) => [p.id.toString(), p.name]));
  const hasSource = referencingKs.length > 0;
  // KL-06: poll while one of its sources is queued or indexing.
  const runActive = indexJobs.some((j) => j.status === 'queued' || j.status === 'running');
  const moving = referencingKs.some(({ source }) =>
    indexStatusMoving(source.indexStatus, runActive),
  );
  const everIndexed = referencingKs.some(
    ({ source }) => source.indexedAt !== null || source.indexStatus === 'indexed',
  );
  // Re-extract with OCR: an admin action on a PDF already in the
  // knowledge base, shown with what it costs.
  const ocrEstimate =
    isAdmin && !isArchived && hasSource && isPdfDocument(document)
      ? await estimateDocumentOcr(ctx, document)
      : null;

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

  // KL-06 (I108): queue a run per source and return at once; the
  // knowledge.index job does the work and this page polls the status.
  async function reindex() {
    'use server';
    const c = await getWorkspaceContext();
    let created = false;
    try {
      created = (await requestDocumentIndex(c, id)).createdSourceId !== null;
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'index failed';
      redirect(`/documents/${id}?error=${encodeURIComponent(m)}`);
    }
    const what = created
      ? 'Added to the knowledge base for every product; indexing queued.'
      : 'Re-indexing queued.';
    redirect(
      `/documents/${id}?message=${encodeURIComponent(`${what} This page updates on its own.`)}`,
    );
  }

  // KL-06: admin only, explicit, with the cost on the button's confirm.
  async function reextractOcr() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await requestDocumentOcrReextract(c, id);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof KnowledgeIndexError
          ? err.message
          : err instanceof Error
            ? err.message
            : 're-extract failed';
      redirect(`/documents/${id}?error=${encodeURIComponent(m)}`);
    }
    redirect(
      `/documents/${id}?message=${encodeURIComponent(
        'OCR re-extraction queued. The document is read again and re-indexed; this page updates on its own.',
      )}`,
    );
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/today">Today</Link> /{' '}
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
            {isAdmin ? (
              <>
                <dt>SHA-256</dt>
                <dd>
                  <code>{document.sha256.slice(0, 16)}…</code>
                </dd>
                <dt>Storage</dt>
                <dd>
                  <code>{document.storageProvider}</code>:{' '}
                  <code>{document.storageKey}</code>
                </dd>
              </>
            ) : null}
            <dt>Uploaded</dt>
            <dd>{document.createdAt.toLocaleString()}</dd>
            {document.extractedAt ? (
              <>
                <dt>Text extracted</dt>
                <dd data-testid="extraction">
                  <code>{document.extractor ?? 'text'}</code>
                  <span className="muted">
                    {' '}
                    · {document.extractedAt.toLocaleString()}
                    {document.pageCount ? ` · ${document.pageCount} pages` : ''}
                    {document.detectedLanguage ? ` · language ${document.detectedLanguage}` : ''}
                  </span>
                </dd>
              </>
            ) : null}
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
            <p>
              {/* A plain link to the authenticated download route. Not
                  next/link: it would prefetch the API route. The response
                  is an attachment, so the browser saves the file and stays
                  on this page; a failed download redirects back here (or
                  to /documents) with the reason as ?error=. */}
              <a href={url} className="primary-btn">
                Download {document.filename}
              </a>
            </p>
            <p className="muted small">
              The link works only for signed-in members of this workspace.
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
            {hasSource ? (
              <p className="muted">
                Indexing chunks the document content and embeds it for retrieval
                through its knowledge source{referencingKs.length === 1 ? '' : 's'} below,
                which decide which products may use it. Re-indexing refreshes them in
                place; it never changes their products.
              </p>
            ) : (
              <p className="muted">
                This document is not in the knowledge base yet. Indexing adds it for
                every product; to limit it to some products,{' '}
                <Link href={`/knowledge/new?document=${document.id}`}>
                  attach it to products
                </Link>{' '}
                instead.
              </p>
            )}
            <form action={reindex}>
              <button type="submit">
                {!hasSource ? 'Index for every product' : everIndexed ? 'Re-index' : 'Index now'}
              </button>
            </form>
            {ocrEstimate ? (
              ocrEstimate.available ? (
                <form action={reextractOcr} data-testid="reextract-ocr">
                  <p className="muted small">
                    Re-extract with OCR reads the PDF again with Mistral OCR — for a
                    scan, or a PDF whose text layer is garbled. {describeOcrCost(ocrEstimate)}
                  </p>
                  <ConfirmFormButton
                    className="ghost-btn"
                    message={`Re-extract ${document.filename} with OCR? ${describeOcrCost(ocrEstimate)} The document is then re-indexed.`}
                  >
                    Re-extract with OCR
                  </ConfirmFormButton>
                </form>
              ) : (
                <p className="muted small" data-testid="reextract-ocr-unavailable">
                  Re-extract with OCR is not available: {ocrEstimate.reason}
                </p>
              )
            ) : null}
            <IndexRunList jobs={indexJobs} />
            {moving ? <AutoRefresh reason="knowledge-index" /> : null}
          </section>
        ) : null}

        <section>
          <h2>Referenced by knowledge sources</h2>
          {referencingKs.length === 0 ? (
            <p className="muted">
              No knowledge sources reference this document yet.{' '}
              <Link href={`/knowledge/new?document=${document.id}`}>Create one</Link>.
            </p>
          ) : (
            <ul className="profile-list">
              {referencingKs.map(({ source, scope }) => (
                <li key={source.id.toString()}>
                  <Link href={`/knowledge/${source.id}`}>{source.title}</Link>{' '}
                  <ScopeChip scope={scope} productNames={productNames} />{' '}
                  <IndexStatusBadge status={source.indexStatus} />
                  {source.summary ? <p className="muted">{source.summary}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {isAdmin ? (
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
      </AppShell>
  );
}
