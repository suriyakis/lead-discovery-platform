import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Archive, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listLeads, type LeadRow } from '@/lib/services/qualification';
import { listProductProfiles } from '@/lib/services/product-profile';
import { ensureQualifiedLead } from '@/lib/services/pipeline';
import type { ProductProfile } from '@/lib/db/schema/products';
import { bulkArchiveAction, bulkDeleteAction } from './actions';

const SORT_OPTIONS = [
  { key: 'score', label: 'Relevance score' },
  { key: 'recent', label: 'Most recent' },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]['key'];

const BULK_FORM_ID = 'leads-bulk-form';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateParam(raw: string | undefined, endOfDay: boolean): Date | null {
  if (!raw || !DATE_RE.test(raw)) return null;
  // Anchor in UTC to avoid TZ surprises; end-of-day for the "to" bound.
  const d = new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    product?: string;
    mode?: string;
    sort?: string;
    from?: string;
    to?: string;
    message?: string;
    error?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const sp = await searchParams;
  const productFilter = sp.product && /^\d+$/.test(sp.product) ? BigInt(sp.product) : null;
  const includeAll = sp.mode === 'all';
  const sortKey: SortKey = sp.sort === 'recent' ? 'recent' : 'score';
  const fromRaw = DATE_RE.test(sp.from ?? '') ? sp.from! : '';
  const toRaw = DATE_RE.test(sp.to ?? '') ? sp.to! : '';
  const createdAtFrom = parseDateParam(fromRaw, false);
  const createdAtTo = parseDateParam(toRaw, true);

  let products: ProductProfile[] = [];
  let leads: LeadRow[] = [];
  try {
    const ctx = await getWorkspaceContext();
    products = await listProductProfiles(ctx, { includeArchived: false });
    leads = await listLeads(ctx, {
      productProfileId: productFilter ?? undefined,
      relevantOnly: !includeAll,
      limit: 200,
      createdAtFrom: createdAtFrom ?? undefined,
      createdAtTo: createdAtTo ?? undefined,
    });
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>Leads</h1>
            <section>
              <p>You don&apos;t belong to a workspace yet.</p>
            </section>
          </AppShell>
      );
    }
    throw err;
  }

  const sortedLeads = sortKey === 'recent'
    ? [...leads].sort((a, b) =>
        b.qualification.createdAt.getTime() - a.qualification.createdAt.getTime(),
      )
    : leads;

  async function promote(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const reviewItemIdRaw = String(formData.get('reviewItemId') ?? '');
    const productIdRaw = String(formData.get('productProfileId') ?? '');
    if (!/^\d+$/.test(reviewItemIdRaw) || !/^\d+$/.test(productIdRaw)) return;
    const created = await ensureQualifiedLead(
      c,
      BigInt(reviewItemIdRaw),
      BigInt(productIdRaw),
    );
    redirect(`/pipeline/${created.id}`);
  }

  // Hidden inputs that round-trip the current filter so bulk actions
  // return the user to the same view.
  const filterInputs = (
    <>
      {productFilter ? (
        <input type="hidden" name="product" value={productFilter.toString()} />
      ) : null}
      <input type="hidden" name="mode" value={includeAll ? 'all' : 'relevant'} />
      <input type="hidden" name="sort" value={sortKey} />
      {fromRaw ? <input type="hidden" name="from" value={fromRaw} /> : null}
      {toRaw ? <input type="hidden" name="to" value={toRaw} /> : null}
    </>
  );

  return (
    <AppShell>
        <header className="page-intro" style={{ marginBottom: '1.25rem' }}>
          <p className="page-eyebrow">Discovery</p>
          <h1 className="page-title">Leads</h1>
          <p className="page-lede">
            Records the classification engine flagged as relevant against
            one of your product profiles. Highest relevance first.
          </p>
        </header>

        {sp.message ? (
          <p className="mail-flash info">{sp.message}</p>
        ) : null}
        {sp.error ? <p className="mail-flash error">{sp.error}</p> : null}

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
          <label>
            From
            <input type="date" name="from" defaultValue={fromRaw} />
          </label>
          <label>
            To
            <input type="date" name="to" defaultValue={toRaw} />
          </label>
          <button type="submit">Apply</button>
        </form>

        <form
          id={BULK_FORM_ID}
          action={bulkArchiveAction}
          className="bulk-toolbar"
        >
          {filterInputs}
          <div className="bulk-toolbar-info">
            {sortedLeads.length === 0
              ? 'No leads match the current filter.'
              : `${sortedLeads.length} lead${sortedLeads.length === 1 ? '' : 's'} shown. Tick rows to act on them (up to 500 at a time).`}
          </div>
          <div className="bulk-toolbar-actions">
            <button
              type="submit"
              formAction={bulkArchiveAction}
              className="ghost-btn"
              disabled={sortedLeads.length === 0}
            >
              <Archive className="lucide" /> Archive selected
            </button>
            <ConfirmFormButton
              formAction={bulkDeleteAction}
              message="Permanently delete the selected leads? This cannot be undone."
              className="ghost-btn danger"
              disabled={sortedLeads.length === 0}
            >
              <Trash2 className="lucide" /> Delete selected
            </ConfirmFormButton>
          </div>
        </form>

        <section>
          {sortedLeads.length === 0 ? (
            <p className="muted">
              {includeAll
                ? 'No classifications match. Try widening date / product filters or run a connector to harvest records.'
                : 'No relevant leads match. Try widening filters or switching Show to "All classifications".'}
            </p>
          ) : (
            <ul className="lead-list bulk-selectable-list">
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
                      <label className="row-select">
                        <input
                          type="checkbox"
                          name="ids"
                          value={qualification.id.toString()}
                          form={BULK_FORM_ID}
                          aria-label={`Select lead ${title}`}
                        />
                      </label>
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
                    {reviewItem && qualification.isRelevant ? (
                      <form action={promote} style={{ marginTop: '0.5rem' }}>
                        <input type="hidden" name="reviewItemId" value={reviewItem.id.toString()} />
                        <input type="hidden" name="productProfileId" value={product.id.toString()} />
                        <button type="submit">Promote to pipeline →</button>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </AppShell>
  );
}
