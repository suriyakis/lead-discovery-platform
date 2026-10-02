// /drafts — outreach drafts. MOB-02: the default view is "Awaiting
// approval" (status draft or needs_edit): exactly the drafts the attention
// summary's drafts.approve key counts, so the Outreach badge, Today's
// "Drafts awaiting approval" tile and this list agree. "All active" keeps
// the old view (adds approved and rejected).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
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
import { hintsForDrafts, type Hint } from '@/lib/services/hints';
import { DRAFT_APPROVAL_STATUSES } from '@/lib/attention/service';
import { HintBadgeList } from '@/components/HintBadge';
import { EmptyState } from '@/components/EmptyState';
import { BadgeGroup, StatusBadge } from '@/components/Badge';
import type { OutreachDraftStatus } from '@/lib/db/schema/outreach';
import type { ProductProfile } from '@/lib/db/schema/products';
import { labelFor, OUTREACH_DRAFT_STATUS_LABEL } from '@/lib/ui/labels';
import { NoWorkspaceState } from '@/components/NoWorkspaceState';

type DraftFilterKey = 'awaiting' | 'all' | OutreachDraftStatus;

const STATUS_FILTERS: ReadonlyArray<{ key: DraftFilterKey; label: string }> = [
  { key: 'awaiting', label: 'Awaiting approval' },
  { key: 'all', label: 'All active' },
  ...(['draft', 'needs_edit', 'approved', 'rejected'] as const).map((key) => ({
    key,
    label: OUTREACH_DRAFT_STATUS_LABEL[key],
  })),
];

/** The view a plain /drafts opens: drafts.approve's rows. */
const DEFAULT_DRAFT_FILTER: DraftFilterKey = 'awaiting';

/** The listOutreachDrafts status filter of a view (undefined = all active). */
function statusesFor(key: DraftFilterKey): OutreachDraftStatus | OutreachDraftStatus[] | undefined {
  if (key === 'awaiting') return [...DRAFT_APPROVAL_STATUSES];
  if (key === 'all') return undefined;
  return key;
}

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; product?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const sp = await searchParams;
  const requested = sp.status ?? DEFAULT_DRAFT_FILTER;
  const isValidStatus = STATUS_FILTERS.some((f) => f.key === requested);
  const statusKey = isValidStatus ? (requested as DraftFilterKey) : DEFAULT_DRAFT_FILTER;
  const productFilter =
    sp.product && /^\d+$/.test(sp.product) ? BigInt(sp.product) : null;

  let products: ProductProfile[] = [];
  let drafts: OutreachDraftRow[] = [];
  let hintsByDraft: Map<string, Hint[]> = new Map();
  try {
    const ctx = await getWorkspaceContext();
    products = await listProductProfiles(ctx, { includeArchived: false });
    drafts = await listOutreachDrafts(ctx, {
      status: statusesFor(statusKey),
      productProfileId: productFilter ?? undefined,
      limit: 200,
    });
    // Batched: one outreach_queue scan instead of one per draft.
    hintsByDraft = await hintsForDrafts(
      ctx,
      drafts.map((r) => r.draft),
    );
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) return <NoWorkspaceState />;
    throw err;
  }

  return (
    <>
        <header className="page-intro" style={{ marginBottom: '1.25rem' }}>
          <p className="page-eyebrow">Outreach</p>
          <h1 className="page-title">Drafts</h1>
          <p className="page-lede">
            Generated from review items, scoped to a product profile. Edit,
            approve, or reject. Approved drafts get queued from the draft
            detail page — nothing sends from this list.
          </p>
        </header>

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
            <EmptyState
              title="No drafts in this view"
              hint="Drafts appear here when a lead is qualified or replies. Open a qualified lead and click Generate draft."
              ctaLabel="Open pipeline"
              ctaHref="/pipeline"
            />
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
                      <BadgeGroup>
                        <StatusBadge set="outreach_draft_status" value={draft.status} />
                        <StatusBadge set="outreach_stage" value={draft.stage} />
                      </BadgeGroup>
                      <span className="muted">→ {product.name}</span>
                    </div>
                    <p className="muted">
                      Lead: <Link href={`/review/${reviewItem.id}`}>{recordTitle}</Link>
                    </p>
                    <div className="lead-meta">
                      <span>via {labelFor('outreach_draft_method', draft.method)}</span>
                      {draft.model ? (
                        <span title={`Model: ${draft.model}`}>
                          {shortModel(draft.model)}
                        </span>
                      ) : null}
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
      </>
  );
}

function shortModel(model: string): string {
  // Display compact model names: "claude-opus-4-7..." → "opus-4.7",
  // "gpt-5-nano" → "gpt-5-nano", "gpt-4o-mini" → "gpt-4o-mini".
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus-4.7';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.startsWith('gpt-5-nano')) return 'gpt-5-nano';
  if (m.startsWith('gpt-5')) return 'gpt-5';
  if (m.startsWith('gpt-4o-mini')) return 'gpt-4o-mini';
  if (m.startsWith('gpt-4o')) return 'gpt-4o';
  return model.length > 16 ? `${model.slice(0, 15)}…` : model;
}
