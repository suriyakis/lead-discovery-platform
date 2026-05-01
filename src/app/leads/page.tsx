import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listLeads, type LeadRow } from '@/lib/services/qualification';
import { listProductProfiles } from '@/lib/services/product-profile';
import type { ProductProfile } from '@/lib/db/schema/products';

const SORT_OPTIONS = [
  { key: 'score', label: 'Relevance score' },
  { key: 'recent', label: 'Most recent' },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]['key'];

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string; mode?: string; sort?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const sp = await searchParams;
  const productFilter = sp.product && /^\d+$/.test(sp.product) ? BigInt(sp.product) : null;
  const includeAll = sp.mode === 'all';
  const sortKey: SortKey = sp.sort === 'recent' ? 'recent' : 'score';

  let products: ProductProfile[] = [];
  let leads: LeadRow[] = [];
  try {
    const ctx = await getWorkspaceContext();
    products = await listProductProfiles(ctx, { includeArchived: false });
    leads = await listLeads(ctx, {
      productProfileId: productFilter ?? undefined,
      relevantOnly: !includeAll,
      limit: 200,
    });
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <>
          <BrandHeader />
          <main>
            <h1>Leads</h1>
            <section>
              <p>You don&apos;t belong to a workspace yet.</p>
            </section>
          </main>
        </>
      );
    }
    throw err;
  }

  const sortedLeads = sortKey === 'recent'
    ? [...leads].sort((a, b) =>
        b.qualification.createdAt.getTime() - a.qualification.createdAt.getTime(),
      )
    : leads;

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
          <Link href="/dashboard">Dashboard</Link> / Leads
        </p>
        <h1>Leads</h1>
        <p className="muted">
          Records the classification engine flagged as relevant against one of your product
          profiles. Highest relevance first.
        </p>

        <form className="leads-controls" method="get">
          <label>
            Product
            <select name="product" defaultValue={productFilter?.toString() ?? ''}>
              <option value="">All active products</option>
              {products.map((p) => (
                <option key={p.id.toString()} value={p.id.toString()}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Show
            <select name="mode" defaultValue={includeAll ? 'all' : 'relevant'}>
              <option value="relevant">Relevant only</option>
              <option value="all">All classifications</option>
            </select>
          </label>
          <label>
            Sort
            <select name="sort" defaultValue={sortKey}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Apply</button>
        </form>

        <section>
          {sortedLeads.length === 0 ? (
            <p className="muted">
              {includeAll
                ? 'No classifications yet. Run a connector to harvest records.'
                : 'No relevant leads yet. Try widening the filter or running more connectors.'}
            </p>
          ) : (
            <ul className="lead-list">
              {sortedLeads.map(({ qualification, product, sourceRecord, reviewItem }) => {
                const normalized = sourceRecord.normalizedData as Record<string, unknown>;
                const title =
                  (normalized.title as string | undefined) ??
                  sourceRecord.sourceUrl ??
                  `Record ${sourceRecord.id}`;
                const snippet = normalized.snippet as string | undefined;
                const domain = normalized.domain as string | undefined;
                const linkHref = reviewItem
                  ? `/review/${reviewItem.id}`
                  : `/review?state=all`;
                return (
                  <li key={qualification.id.toString()}>
                    <div className="lead-row">
                      <Link href={linkHref}>{title}</Link>
                      <span
                        className={
                          qualification.isRelevant ? 'badge badge-good' : 'badge badge-bad'
                        }
                      >
                        score {qualification.relevanceScore}
                      </span>
                      <span className="muted">→ {product.name}</span>
                    </div>
                    {snippet ? <p className="muted">{snippet}</p> : null}
                    {qualification.qualificationReason ? (
                      <p className="qual-reason qual-reason-good">
                        {qualification.qualificationReason}
                      </p>
                    ) : null}
                    {qualification.rejectionReason ? (
                      <p className="qual-reason qual-reason-bad">
                        {qualification.rejectionReason}
                      </p>
                    ) : null}
                    <div className="lead-meta">
                      {domain ? <span>{domain}</span> : null}
                      <span>conf {qualification.confidence}</span>
                      <span>via {qualification.method}</span>
                      {reviewItem ? <span>review: {reviewItem.state}</span> : null}
                      <span>{qualification.createdAt.toLocaleString()}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
