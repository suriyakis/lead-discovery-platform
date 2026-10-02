import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  listDocuments,
  uploadDocument,
} from '@/lib/services/documents';
import { NO_PRODUCT_TICKED_COPY, knowledgeScopeFromTicks } from '@/lib/services/knowledge-scope';
import {
  createKnowledgeSource,
  knowledgeSourceErrorMessage,
} from '@/lib/services/knowledge-sources';
import { listProductProfiles } from '@/lib/services/product-profile';
import { isNextRedirectError } from '@/lib/server-redirect';
import type { DocumentMeta } from '@/lib/db/schema/documents';
import type { ProductProfile } from '@/lib/db/schema/products';

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string; message?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const sp = await searchParams;
  const includeArchived = sp.archived === '1';

  let docs: DocumentMeta[] = [];
  let products: ProductProfile[] = [];
  try {
    const ctx = await getWorkspaceContext();
    docs = await listDocuments(ctx, { includeArchived });
    products = await listProductProfiles(ctx);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>Documents</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </AppShell>
      );
    }
    throw err;
  }

  // One form does the whole journey that used to take four manual steps
  // (upload → open doc → "Index now" → /knowledge/new → attach → index):
  //   1. upload (byte-identical re-uploads dedupe to the existing row)
  //   2. create the document's ONE knowledge source with an explicit
  //      scope (KL-05): the ticked products, or — no product ticked —
  //      every product (scope_kind 'workspace')
  //   3. KL-06: that create queues the source's one indexing run when the
  //      type is indexable; the knowledge.index job extracts (OCR once per
  //      file), embeds once and attaches per product. This request returns
  //      before any of it (I108) and the document page polls the status.
  // There are no document-level chunks any more: they were workspace-wide
  // even after the document was scoped to a product (I039).
  async function upload(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const file = formData.get('file');
    if (!(file instanceof File)) return;
    if (file.size === 0) return;
    const buffer = Buffer.from(await file.arrayBuffer());
    const name = String(formData.get('name') ?? '').trim() || null;
    const rawTags = String(formData.get('tags') ?? '');
    const tags = rawTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const productIds = formData
      .getAll('productProfileIds')
      .map((v) => String(v))
      .filter((v) => /^\d+$/.test(v))
      .map((v) => BigInt(v));

    const result = await uploadDocument(c, {
      filename: file.name,
      mimeType: file.type || null,
      body: buffer,
      name,
      tags,
    });
    if (result.deduplicated) {
      redirect(
        `/documents/${result.document.id}?message=${encodeURIComponent(
          `Identical file already in your library as “${result.document.name}” — nothing re-uploaded.`,
        )}`,
      );
    }

    const scope = knowledgeScopeFromTicks(productIds);
    const where =
      scope.kind === 'products'
        ? `attached to ${productIds.length} product${productIds.length === 1 ? '' : 's'}`
        : 'available to every product';

    let ks: Awaited<ReturnType<typeof createKnowledgeSource>>;
    try {
      ks = await createKnowledgeSource(c, {
        kind: 'document',
        title: result.document.name,
        documentId: result.document.id,
        language: 'en',
        purposeCategory: 'general',
        tags,
        scope,
      });
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        knowledgeSourceErrorMessage(err) ?? (err instanceof Error ? err.message : 'unknown error');
      redirect(
        `/documents/${result.document.id}?error=${encodeURIComponent(
          `Uploaded, but not added to the knowledge base: ${m.slice(0, 300)}`,
        )}`,
      );
    }

    const outcome =
      ks.indexStatus === 'failed'
        ? `Uploaded and ${where}. Not indexed automatically: the file type has no extractable text; use "Index now" below to force an attempt.`
        : `Uploaded and ${where}. Indexing in the background; this page updates on its own.`;
    redirect(
      `/documents/${result.document.id}?message=${encodeURIComponent(outcome)}`,
    );
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/today">Today</Link> / Documents
        </p>
        <h1>Documents</h1>
        <p className="muted">
          Files uploaded by your workspace — pricing sheets, product specs, case
          studies, anything you want to reference from the platform.
        </p>

        {sp.message ? <p className="form-info">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <section>
          <h2>Upload</h2>
          <p className="muted small">
            Text, PDF and DOCX files are chunked and indexed for retrieval
            automatically after upload, in the background — no extra steps.
            Scanned PDFs are read with OCR once, when an OCR key is
            configured. Identical re-uploads are detected and skipped.
          </p>
          <form action={upload} className="upload-form" encType="multipart/form-data">
            <label>
              <span>File</span>
              <input type="file" name="file" required />
            </label>
            <label>
              <span>Display name (optional, defaults to filename)</span>
              <input type="text" name="name" maxLength={200} />
            </label>
            <label>
              <span>Tags (comma-separated)</span>
              <input
                type="text"
                name="tags"
                placeholder="e.g. pricing, q3, internal"
                maxLength={400}
              />
            </label>
            {products.length > 0 ? (
              <fieldset className="provider-select">
                <legend>
                  Attach to products{' '}
                  <span className="muted small">
                    (optional — scopes the knowledge to those products&apos;
                    outreach &amp; replies)
                  </span>
                </legend>
                <p className="muted small" data-testid="scope-rule">
                  {`${NO_PRODUCT_TICKED_COPY}.`}
                </p>
                {products.map((p) => (
                  <label
                    key={p.id.toString()}
                    style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}
                  >
                    <input
                      type="checkbox"
                      name="productProfileIds"
                      value={p.id.toString()}
                    />
                    <span>{p.name}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <button type="submit" className="primary-btn">
              Upload
            </button>
          </form>
        </section>

        <section>
          <h2>
            Library{' '}
            <Link
              href={includeArchived ? '/documents' : '/documents?archived=1'}
              className="muted"
              style={{ fontWeight: 400, fontSize: '0.875rem' }}
            >
              [{includeArchived ? 'hide archived' : 'show archived'}]
            </Link>
          </h2>
          {docs.length === 0 ? (
            <p className="muted">No documents yet. Upload above to get started.</p>
          ) : (
            <ul className="lead-list">
              {docs.map((doc) => (
                <li key={doc.id.toString()}>
                  <div className="lead-row">
                    <Link href={`/documents/${doc.id}`}>{doc.name}</Link>
                    {doc.status === 'archived' ? (
                      <span className="badge">archived</span>
                    ) : null}
                  </div>
                  <div className="lead-meta">
                    <span>{doc.filename}</span>
                    <span>{doc.mimeType}</span>
                    <span>{formatBytes(doc.sizeBytes)}</span>
                    {doc.tags.length > 0 ? <span>tags: {doc.tags.join(', ')}</span> : null}
                    <span>{doc.createdAt.toLocaleString()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </AppShell>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
