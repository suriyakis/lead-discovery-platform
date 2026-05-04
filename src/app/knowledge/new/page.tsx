import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listProductProfiles } from '@/lib/services/product-profile';
import { listDocuments } from '@/lib/services/documents';
import {
  KnowledgeSourceServiceError,
  createKnowledgeSource,
} from '@/lib/services/knowledge-sources';
import type { ProductProfile } from '@/lib/db/schema/products';
import type { Document, KnowledgeSourceKind } from '@/lib/db/schema/documents';

export default async function NewKnowledgeSourcePage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; document?: string; product?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  const initialKind: KnowledgeSourceKind =
    sp.kind === 'url' || sp.kind === 'text' ? sp.kind : 'document';
  const initialDocId =
    sp.document && /^\d+$/.test(sp.document) ? sp.document : '';
  const preselectedProduct =
    sp.product && /^\d+$/.test(sp.product) ? sp.product : '';

  let products: ProductProfile[] = [];
  let docs: Document[] = [];
  try {
    const ctx = await getWorkspaceContext();
    products = await listProductProfiles(ctx, { includeArchived: false });
    docs = await listDocuments(ctx, { status: 'ready', limit: 1000 });
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>New knowledge source</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </AppShell>
      );
    }
    throw err;
  }

  async function create(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const kindRaw = String(formData.get('kind') ?? 'document');
    const kind: KnowledgeSourceKind =
      kindRaw === 'url' || kindRaw === 'text' ? kindRaw : 'document';
    const title = String(formData.get('title') ?? '').trim();
    const summary = String(formData.get('summary') ?? '').trim() || null;
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

    const documentIdRaw = String(formData.get('documentId') ?? '');
    const documentId =
      kind === 'document' && /^\d+$/.test(documentIdRaw)
        ? BigInt(documentIdRaw)
        : null;
    const url = kind === 'url' ? String(formData.get('url') ?? '').trim() : null;
    const textExcerpt =
      kind === 'text' ? String(formData.get('textExcerpt') ?? '') : null;

    try {
      const created = await createKnowledgeSource(c, {
        kind,
        title,
        documentId,
        url,
        textExcerpt,
        summary,
        language,
        purposeCategory,
        tags,
        productProfileIds: productIds,
      });
      redirect(`/knowledge/${created.id}`);
    } catch (err) {
      if (err instanceof KnowledgeSourceServiceError) {
        const params = new URLSearchParams({
          kind,
          error: err.message,
        });
        if (documentId) params.set('document', documentId.toString());
        redirect(`/knowledge/new?${params.toString()}`);
      }
      throw err;
    }
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/knowledge">Knowledge</Link> / New
        </p>
        <h1>New knowledge source</h1>
        {sp.error ? (
          <p className="form-error">{sp.error}</p>
        ) : null}

        <form action={create} className="edit-draft-form">
          <label>
            <span>Kind</span>
            <select name="kind" defaultValue={initialKind}>
              <option value="document">Document (file in this workspace)</option>
              <option value="url">URL (external link)</option>
              <option value="text">Text excerpt</option>
            </select>
          </label>

          <label>
            <span>Title</span>
            <input type="text" name="title" required maxLength={240} />
          </label>

          <fieldset className="ks-kind-fields">
            <legend className="muted">Document fields (when kind=document)</legend>
            <label>
              <span>Document</span>
              <select name="documentId" defaultValue={initialDocId}>
                <option value="">— pick a document —</option>
                {docs.map((d) => (
                  <option key={d.id.toString()} value={d.id.toString()}>
                    {d.name} ({d.filename})
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          <fieldset className="ks-kind-fields">
            <legend className="muted">URL fields (when kind=url)</legend>
            <label>
              <span>URL</span>
              <input type="url" name="url" placeholder="https://..." />
            </label>
          </fieldset>

          <fieldset className="ks-kind-fields">
            <legend className="muted">Text excerpt (when kind=text)</legend>
            <label>
              <span>Excerpt</span>
              <textarea name="textExcerpt" rows={6} maxLength={200000} />
            </label>
          </fieldset>

          <label>
            <span>Summary (optional)</span>
            <textarea name="summary" rows={3} maxLength={4000} />
          </label>

          <label>
            <span>Language</span>
            <input type="text" name="language" defaultValue="en" maxLength={8} />
          </label>

          <label>
            <span>Purpose</span>
            <select name="purposeCategory" defaultValue="general">
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
            <input type="text" name="tags" maxLength={400} />
          </label>

          <label>
            <span>Attach to products (Ctrl/Cmd-click for multiple)</span>
            <select name="productProfileIds" multiple size={Math.min(8, Math.max(3, products.length))}>
              {products.map((p) => (
                <option
                  key={p.id.toString()}
                  value={p.id.toString()}
                  selected={p.id.toString() === preselectedProduct}
                >
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <div className="action-row">
            <button type="submit" className="primary-btn">
              Create
            </button>
            <Link href="/knowledge" className="ghost-btn">
              Cancel
            </Link>
          </div>
        </form>
      </AppShell>
  );
}
