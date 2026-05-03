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
  listOutreachDrafts,
  type OutreachDraftRow,
} from '@/lib/services/outreach';
import { hintsForDraft, type Hint } from '@/lib/services/hints';
import { HintBadgeList } from '@/components/HintBadge';
import type { OutreachDraftStatus } from '@/lib/db/schema/outreach';
import type { ProductProfile } from '@/lib/db/schema/products';

const STATUS_FILTERS: ReadonlyArray<{ key: 'all' | OutreachDraftStatus; label: string }> = [
  { key: 'all', label: 'All active' },
  { key: 'draft', label: 'Draft' },
  { key: 'needs_edit', label: 'Needs edit' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; product?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const sp = await searchParams;
  const requested = sp.status ?? 'all';
  const isValidStatus = STATUS_FILTERS.some((f) => f.key === requested);
  const statusKey = isValidStatus ? (requested as 'all' | OutreachDraftStatus) : 'all';
  const productFilter =
    sp.product && /^\d+$/.test(sp.product) ? BigInt(sp.product) : null;

  let products: ProductProfile[] = [];
  let drafts: OutreachDraftRow[] = [];
  let hintsByDraft: Map<string, Hint[]> = new Map();
  try {
    const ctx = await getWorkspaceContext();
    products = await listProductProfiles(ctx, { includeArchived: false });
    drafts = await listOutreachDrafts(ctx, {
      status: statusKey === 'all' ? undefined : (statusKey as OutreachDraftStatus),
      productProfileId: productFilter ?? undefined,
      limit: 200,
    });
    const hintEntries = await Promise.all(
      drafts.map(async ({ draft }) => {
        const h = await hintsForDraft(ctx, draft.id);
        return [draft.id.toString(), h] as const;
      }),
    );
    hintsByDraft = new Map(hintEntries);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <>
          <BrandHeader />
          <main>
            <h1>Drafts</h1>
            <section>
              <p>You don&apos;t belong to a workspace yet.</p>
            </section>
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
          <Link href="/dashboard">Dashboard</Link> / Drafts
        </p>
        <h1>Outreach drafts</h1>
        <p className="muted">
          Generated from review items, scoped to a product profile. Edit, approve,
          or reject. Approved drafts are queued for the (future) sending phase —
          nothing sends from here.
        </p>

        <form className="leads-controls" method="get">
          <label>
            Status
            <select name="status" defaultValue={statusKey}>
              {STATUS_FILTERS.map((f) => (
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
          {drafts.length === 0 ? (
            <p className="muted">
              No drafts in this view. Open a review item and click &ldquo;Generate
              draft&rdquo; against one of your active products.
            </p>
          ) : (
            <ul className="lead-list">
              {drafts.map(({ draft, product, sourceRecord, reviewItem }) => {
                const normalized = sourceRecord.normalizedData as Record<string, unknown>;
                const recordTitle =
                  (normalized.title as string | undefined) ??
                  sourceRecord.sourceUrl ??
                  `Record ${sourceRecord.id}`;
                return (
                  <li key={draft.id.toString()}>
                    <div className="lead-row">
                      <Link href={`/drafts/${draft.id}`}>
                        {draft.subject ?? `Draft ${draft.id}`}
                      </Link>
                      <span className={statusBadgeClass(draft.status)}>
                        {draft.status.replace('_', ' ')}
                      </span>
                      <span className="muted">→ {product.name}</span>
                    </div>
                    <p className="muted">
                      Lead: <Link href={`/review/${reviewItem.id}`}>{recordTitle}</Link>
                    </p>
                    <div className="lead-meta">
                      <span>via {draft.method}</span>
                      <span>conf {draft.confidence}</span>
                      <span>{draft.channel}/{draft.language}</span>
                      {draft.forbiddenStripped.length > 0 ? (
                        <span title={draft.forbiddenStripped.join(', ')}>
                          stripped {draft.forbiddenStripped.length}
                        </span>
                      ) : null}
                      <span>{draft.createdAt.toLocaleString()}</span>
                    </div>
                    <HintBadgeList hints={hintsByDraft.get(draft.id.toString()) ?? []} />
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

function statusBadgeClass(status: OutreachDraftStatus): string {
  switch (status) {
    case 'approved':
      return 'badge badge-good';
    case 'rejected':
      return 'badge badge-bad';
    case 'needs_edit':
      return 'badge';
    case 'superseded':
      return 'badge';
    case 'draft':
    default:
      return 'badge';
  }
}
