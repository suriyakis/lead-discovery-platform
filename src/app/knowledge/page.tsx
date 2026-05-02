import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listProductProfiles } from '@/lib/services/product-profile';
import {
  listKnowledgeSources,
  type KnowledgeSourceRow,
} from '@/lib/services/knowledge-sources';
import type { ProductProfile } from '@/lib/db/schema/products';
import type { KnowledgeSourceKind } from '@/lib/db/schema/documents';

const KIND_FILTERS: ReadonlyArray<{ key: 'all' | KnowledgeSourceKind; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'document', label: 'Documents' },
  { key: 'url', label: 'URLs' },
  { key: 'text', label: 'Text excerpts' },
];

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; product?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  const requested = sp.kind ?? 'all';
  const isValid = KIND_FILTERS.some((f) => f.key === requested);
  const kindKey = isValid ? (requested as 'all' | KnowledgeSourceKind) : 'all';

  const productFilter =
    sp.product && /^\d+$/.test(sp.product) ? BigInt(sp.product) : null;

  let products: ProductProfile[] = [];
  let sources: KnowledgeSourceRow[] = [];
  try {
    const ctx = await getWorkspaceContext();
    products = await listProductProfiles(ctx, { includeArchived: false });
    sources = await listKnowledgeSources(ctx, {
      kind: kindKey === 'all' ? undefined : (kindKey as KnowledgeSourceKind),
      productProfileId: productFilter ?? undefined,
      limit: 200,
    });
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <>
          <BrandHeader />
          <main>
            <h1>Knowledge</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </main>
        </>
      );
    }
    throw err;
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
          <Link href="/dashboard">Dashboard</Link> / Knowledge
        </p>
        <div className="page-header">
          <h1>Knowledge sources</h1>
          <Link href="/knowledge/new" className="primary-btn">
            New source
          </Link>
        </div>
        <p className="muted">
          Things this workspace knows about its products and sectors —
          documents, reference URLs, distilled snippets. Future RAG phases
          chunk and embed these for AI grounding.
        </p>

        <form className="leads-controls" method="get">
          <label>
            Kind
            <select name="kind" defaultValue={kindKey}>
              {KIND_FILTERS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Product
            <select name="product" defaultValue={productFilter?.toString() ?? ''}>
              <option value="">All products</option>
              {products.map((p) => (
                <option key={p.id.toString()} value={p.id.toString()}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Apply</button>
        </form>

        <section>
          {sources.length === 0 ? (
            <p className="muted">
              No knowledge sources yet.{' '}
              <Link href="/knowledge/new">Create one</Link>.
            </p>
          ) : (
            <ul className="lead-list">
              {sources.map(({ source, document }) => (
                <li key={source.id.toString()}>
                  <div className="lead-row">
                    <Link href={`/knowledge/${source.id}`}>{source.title}</Link>
                    <span className="badge">{source.kind}</span>
                  </div>
                  {source.summary ? <p className="muted">{source.summary}</p> : null}
                  <div className="lead-meta">
                    {source.kind === 'document' && document ? (
                      <span>{document.filename}</span>
                    ) : null}
                    {source.kind === 'url' && source.url ? (
                      <span>{shortUrl(source.url)}</span>
                    ) : null}
                    {source.kind === 'text' && source.textExcerpt ? (
                      <span>{source.textExcerpt.slice(0, 80)}…</span>
                    ) : null}
                    {source.tags.length > 0 ? <span>tags: {source.tags.join(', ')}</span> : null}
                    <span>{source.language}</span>
                    <span>{source.createdAt.toLocaleString()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}
