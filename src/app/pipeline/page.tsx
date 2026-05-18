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
  getStateCounts,
  listLeads,
  type PipelineLeadRow,
} from '@/lib/services/pipeline';
import { hintsForLeads, type Hint } from '@/lib/services/hints';
import { HintBadgeList } from '@/components/HintBadge';
import { EmptyState } from '@/components/EmptyState';
import type { PipelineState } from '@/lib/db/schema/pipeline';
import type { ProductProfile } from '@/lib/db/schema/products';

const STATES: ReadonlyArray<{ key: 'all' | PipelineState; label: string }> = [
  { key: 'all', label: 'All open' },
  { key: 'relevant', label: 'Relevant' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'replied', label: 'Replied' },
  { key: 'contact_identified', label: 'Contact identified' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'handed_over', label: 'Handed over' },
  { key: 'synced_to_crm', label: 'Synced to CRM' },
  { key: 'closed', label: 'Closed' },
];

const KANBAN_COLUMNS: ReadonlyArray<{ key: PipelineState; label: string }> = [
  { key: 'relevant', label: 'Relevant' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'replied', label: 'Replied' },
  { key: 'contact_identified', label: 'Identified' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'handed_over', label: 'Handed over' },
  { key: 'synced_to_crm', label: 'Synced' },
];

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; product?: string; view?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  const requested = sp.state ?? 'all';
  const isValid = STATES.some((f) => f.key === requested);
  const stateKey = isValid ? (requested as 'all' | PipelineState) : 'all';

  const productFilter =
    sp.product && /^\d+$/.test(sp.product) ? BigInt(sp.product) : null;
  const view = sp.view === 'kanban' ? 'kanban' : 'list';

  let products: ProductProfile[] = [];
  let leads: PipelineLeadRow[] = [];
  let hintsByLead: Map<string, Hint[]> = new Map();
  let counts: Record<PipelineState, number> = {
    raw_discovered: 0,
    relevant: 0,
    contacted: 0,
    replied: 0,
    contact_identified: 0,
    qualified: 0,
    handed_over: 0,
    synced_to_crm: 0,
    closed: 0,
  };
  try {
    const ctx = await getWorkspaceContext();
    products = await listProductProfiles(ctx, { includeArchived: false });
    counts = await getStateCounts(ctx);
    leads = await listLeads(ctx, {
      state: stateKey === 'all' ? undefined : (stateKey as PipelineState),
      productProfileId: productFilter ?? undefined,
      includeClosed: stateKey !== 'all',
      limit: 500,
    });
    // For kanban + 'all open', exclude closed unless asked.
    if (view === 'kanban' && stateKey === 'all') {
      leads = leads.filter((r) => r.lead.state !== 'closed');
    }
    // Batched: one pass for top qualification per product, one pass
    // for pending drafts — 2 queries total regardless of lead count.
    hintsByLead = await hintsForLeads(
      ctx,
      leads.map((r) => r.lead),
    );
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>Pipeline</h1>
            <p>You don&apos;t belong to a workspace yet.</p>
          </AppShell>
      );
    }
    throw err;
  }

  return (
    <AppShell>
        <header className="page-intro" style={{ marginBottom: '1.25rem' }}>
          <p className="page-eyebrow">Pipeline</p>
          <h1 className="page-title">Qualified leads pipeline</h1>
          <p className="page-lede">
            Commercial pipeline on top of the discovery / classification
            stack. A lead lands here once it crosses into{' '}
            <code>relevant</code>.
          </p>
        </header>

        <FunnelStrip counts={counts} />

        <form className="leads-controls" method="get">
          <label>
            View
            <select name="view" defaultValue={view}>
              <option value="list">List</option>
              <option value="kanban">Kanban</option>
            </select>
          </label>
          <label>
            State
            <select name="state" defaultValue={stateKey}>
              {STATES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
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

        {view === 'kanban' ? (
          <section>
            <div className="kanban">
              {KANBAN_COLUMNS.map((col) => {
                const colLeads = leads.filter((r) => r.lead.state === col.key);
                return (
                  <div key={col.key} className="kanban-col">
                    <div className="kanban-col-head">
                      <strong>{col.label}</strong>
                      <span className="muted">{counts[col.key]}</span>
                    </div>
                    {colLeads.length === 0 ? (
                      <p className="muted" style={{ fontSize: '0.825rem' }}>—</p>
                    ) : (
                      <ul className="kanban-list">
                        {colLeads.map(({ lead, product, reviewItem }) => {
                          const normalized = reviewItem
                            ? ({} as Record<string, unknown>)
                            : ({} as Record<string, unknown>);
                          void normalized;
                          return (
                            <li key={lead.id.toString()}>
                              <Link href={`/pipeline/${lead.id}`}>
                                {lead.contactName ?? `Lead ${lead.id}`}
                              </Link>
                              <p className="muted">{product.name}</p>
                              {lead.contactEmail ? (
                                <p className="muted">{lead.contactEmail}</p>
                              ) : null}
                              <HintBadgeList hints={hintsByLead.get(lead.id.toString()) ?? []} />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ) : (
          <section>
            {leads.length === 0 ? (
              <EmptyState
                title="No leads in this view"
                hint="Leads are promoted from the Leads page via Promote to pipeline on a qualified record. Try widening filters above."
                ctaLabel="Open leads"
                ctaHref="/leads"
              />
            ) : (
              <ul className="lead-list">
                {leads.map(({ lead, product, reviewItem }) => {
                  const normalized = reviewItem.id
                    ? ({} as Record<string, unknown>)
                    : ({} as Record<string, unknown>);
                  void normalized;
                  return (
                    <li key={lead.id.toString()}>
                      <div className="lead-row">
                        <Link href={`/pipeline/${lead.id}`}>
                          {lead.contactName ?? `Lead ${lead.id}`}
                        </Link>
                        <span className={badgeFor(lead.state)}>
                          {lead.state.replace(/_/g, ' ')}
                        </span>
                        <span className={stageBadgeClass(lead.currentStage)}>
                          {lead.currentStage ?? 'discovery'}
                        </span>
                        <span className="muted">
                          →{' '}
                          <Link href={`/products/${product.id}`}>
                            {product.name}
                          </Link>
                        </span>
                      </div>
                      <div className="lead-meta">
                        {lead.contactEmail ? <span>{lead.contactEmail}</span> : null}
                        {lead.contactRole ? <span>{lead.contactRole}</span> : null}
                        {lead.assignedToUserId ? (
                          <span>assigned: {lead.assignedToUserId.slice(0, 8)}…</span>
                        ) : null}
                        <span>updated {lead.updatedAt.toLocaleString()}</span>
                      </div>
                      <HintBadgeList hints={hintsByLead.get(lead.id.toString()) ?? []} />

                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </AppShell>
  );
}

function stageBadgeClass(stage: string | null | undefined): string {
  switch (stage) {
    case 'discovery':
      return 'badge badge-stage-discovery';
    case 'engagement':
      return 'badge badge-stage-engagement';
    case 'pitch':
      return 'badge badge-stage-pitch';
    case 'closing':
      return 'badge badge-stage-closing';
    default:
      return 'badge';
  }
}

function badgeFor(state: PipelineState): string {
  if (state === 'closed') return 'badge';
  if (state === 'qualified' || state === 'handed_over' || state === 'synced_to_crm') {
    return 'badge badge-good';
  }
  return 'badge';
}

/** Horizontal funnel at the top of /pipeline. Each bar is also a link
 *  that re-applies the page filters with state=X so the operator can
 *  drill in with one click. Cold → warm sequential colors mirror the
 *  conversation arc. */
function FunnelStrip({ counts }: { counts: Record<PipelineState, number> }) {
  const stages: Array<{ key: PipelineState; label: string }> = [
    { key: 'relevant', label: 'Relevant' },
    { key: 'contacted', label: 'Contacted' },
    { key: 'replied', label: 'Replied' },
    { key: 'contact_identified', label: 'Identified' },
    { key: 'qualified', label: 'Qualified' },
    { key: 'handed_over', label: 'Handed over' },
    { key: 'synced_to_crm', label: 'Synced' },
  ];
  const max = Math.max(1, ...stages.map((s) => counts[s.key]));
  return (
    <section className="pipeline-funnel-card">
      <p className="pipeline-funnel-head">Pipeline funnel — click a bar to filter</p>
      <div className="pipeline-funnel-rows">
        {stages.map(({ key, label }) => {
          const n = counts[key];
          const pct = Math.round((n / max) * 100);
          return (
            <Link
              key={key}
              href={`/pipeline?state=${key}`}
              className="pipeline-funnel-row"
            >
              <span className="pipeline-funnel-row-label">{label}</span>
              <div className="pipeline-funnel-track">
                <div
                  className="pipeline-funnel-fill"
                  style={{
                    width: `${pct}%`,
                    ['--pipeline-stage-color' as string]: stateColor(key),
                  }}
                />
              </div>
              <span className="pipeline-funnel-row-count">{n}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function stateColor(state: PipelineState): string {
  // Cold (blue) → warm (gold) gradient. Higher chroma so each
  // stripe pops on the dark card backdrop.
  if (state === 'relevant') return 'oklch(0.72 0.17 245)';
  if (state === 'contacted') return 'oklch(0.74 0.15 210)';
  if (state === 'replied') return 'oklch(0.76 0.15 185)';
  if (state === 'contact_identified') return 'oklch(0.78 0.16 160)';
  if (state === 'qualified') return 'oklch(0.78 0.18 140)';
  if (state === 'handed_over') return 'oklch(0.8 0.19 120)';
  if (state === 'synced_to_crm') return 'oklch(0.82 0.19 95)';
  return 'oklch(0.7 0 0)';
}
