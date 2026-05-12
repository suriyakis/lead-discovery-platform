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
import {
  listOutreachDrafts,
  type OutreachDraftRow,
} from '@/lib/services/outreach';
import { hintsForDraft, type Hint } from '@/lib/services/hints';
import { HintBadgeList } from '@/components/HintBadge';
import { EmptyState } from '@/components/EmptyState';
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
        <AppShell>
            <h1>Drafts</h1>
            <section>
              <p>You don&apos;t belong to a workspace yet.</p>
            </section>
          </AppShell>
      );
    }
    throw err;
  }

  return (
    <AppShell>
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
                      <span className={statusBadgeClass(draft.status)}>
                        {draft.status.replace('_', ' ')}
                      </span>
                      <span
                        className="badge"
                        style={{
                          background: stageBg(draft.stage),
                          color: 'oklch(0.2 0 0)',
                        }}
                      >
                        {draft.stage}
                      </span>
                      <span className="muted">→ {product.name}</span>
                    </div>
                    <p className="muted">
                      Lead: <Link href={`/review/${reviewItem.id}`}>{recordTitle}</Link>
                    </p>
                    <div className="lead-meta">
                      <span>via {draft.method}</span>
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
      </AppShell>
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

// Sequential color scale for outreach stages — cold (discovery) →
// warm (pitch) → terminal (closing). Mirrors stage progression so
// visual scanning is immediate.
function stageBg(stage: string): string {
  switch (stage) {
    case 'discovery':
      return 'oklch(0.85 0.13 240)'; // cold blue
    case 'engagement':
      return 'oklch(0.85 0.12 195)'; // teal
    case 'pitch':
      return 'oklch(0.85 0.14 145)'; // green-warm
    case 'closing':
      return 'oklch(0.86 0 0)'; // gray terminal
    default:
      return 'oklch(0.88 0 0)';
  }
}
