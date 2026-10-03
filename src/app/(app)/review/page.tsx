import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Archive, Trash2 } from 'lucide-react';
import { CountBadge, StatusBadge } from '@/components/Badge';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { Pagination } from '@/components/Pagination';
import { SelectAllVisible } from '@/components/SelectAllVisible';
import { Field, Input } from '@/components/ui';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { countReviewItems, getStateCounts, listReviewItems } from '@/lib/services/review';
import { newDecisionKey } from '@/lib/services/learning-decisions';
import type { ReviewItemState } from '@/lib/db/schema/review';
import { REVIEW_ITEM_STATE_LABEL } from '@/lib/ui/labels';
import { ExpectedWorkspaceField } from '@/components/WorkspaceGuard';
import { bulkArchiveAction, bulkDeleteAction } from './actions';
import { NoWorkspaceState } from '@/components/NoWorkspaceState';

/** The state tabs, labelled from the one vocabulary (DS-09). */
const STATE_FILTERS: ReadonlyArray<{ key: 'all' | ReviewItemState; label: string }> = [
  { key: 'all', label: 'All' },
  ...(['new', 'needs_review', 'approved', 'rejected', 'ignored', 'archived'] as const).map(
    (key) => ({ key, label: REVIEW_ITEM_STATE_LABEL[key] }),
  ),
];

const BULK_FORM_ID = 'review-bulk-form';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_SIZE = 25;

function parseDateParam(raw: string | undefined, endOfDay: boolean): Date | null {
  if (!raw || !DATE_RE.test(raw)) return null;
  const d = new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    state?: string;
    from?: string;
    to?: string;
    page?: string;
    message?: string;
    error?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const sp = await searchParams;
  const requested = sp.state ?? 'new';
  const isValidState = STATE_FILTERS.some((f) => f.key === requested);
  const stateKey = isValidState ? (requested as 'all' | ReviewItemState) : 'new';
  const fromRaw = DATE_RE.test(sp.from ?? '') ? sp.from! : '';
  const toRaw = DATE_RE.test(sp.to ?? '') ? sp.to! : '';
  const createdAtFrom = parseDateParam(fromRaw, false);
  const createdAtTo = parseDateParam(toRaw, true);
  const pageParam = Number(sp.page ?? 1);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  let counts;
  let items;
  let total = 0;
  try {
    const ctx = await getWorkspaceContext();
    counts = await getStateCounts(ctx);
    const listFilter = {
      ...(stateKey === 'all' ? {} : { state: stateKey as ReviewItemState }),
      ...(createdAtFrom ? { createdAtFrom } : {}),
      ...(createdAtTo ? { createdAtTo } : {}),
    };
    total = await countReviewItems(ctx, listFilter);
    items = await listReviewItems(ctx, {
      ...listFilter,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) return <NoWorkspaceState />;
    throw err;
  }

  const showArchiveAction = stateKey !== 'archived';

  return (
    <>
        <header className="page-intro" style={{ marginBottom: '1.25rem' }}>
          <p className="page-eyebrow">Discovery</p>
          <h1 className="page-title">Review queue</h1>
          <p className="page-lede">
            Records harvested by connectors land here. Approve, reject, or
            comment to feed the learning layer.
          </p>
        </header>

        {sp.message ? (
          <p className="mail-flash info">{sp.message}</p>
        ) : null}
        {sp.error ? <p className="mail-flash error">{sp.error}</p> : null}

        <div className="state-tabs">
          {STATE_FILTERS.map((f) => {
            const count = f.key === 'all' ? counts.total : counts[f.key as keyof typeof counts];
            const active = f.key === stateKey;
            const params = new URLSearchParams();
            if (f.key !== 'new') params.set('state', f.key);
            if (fromRaw) params.set('from', fromRaw);
            if (toRaw) params.set('to', toRaw);
            const qs = params.toString();
            return (
              <Link
                key={f.key}
                href={qs ? `/review?${qs}` : '/review'}
                className={active ? 'tab active' : 'tab'}
              >
                {f.label}
                {/* Amber only where a decision waits (the nav count policy). */}
                <CountBadge
                  count={count ?? 0}
                  tone={f.key === 'needs_review' && (count ?? 0) > 0 ? 'attention' : 'neutral'}
                />
              </Link>
            );
          })}
        </div>

        <form className="leads-controls" method="get" style={{ marginTop: '0.85rem' }}>
          {stateKey !== 'new' ? (
            <input type="hidden" name="state" value={stateKey} />
          ) : null}
          {/* DS-10 pilot: the native date inputs as Field + Input. */}
          <Field label="From" layout="inline">
            <Input type="date" name="from" defaultValue={fromRaw} />
          </Field>
          <Field label="To" layout="inline">
            <Input type="date" name="to" defaultValue={toRaw} />
          </Field>
          <button type="submit">Apply</button>
        </form>

        <form
          id={BULK_FORM_ID}
          action={bulkArchiveAction}
          className="bulk-toolbar"
        >
          <input type="hidden" name="state" value={stateKey} />
          {/* MOB-06: both bulk actions are guarded. */}
          <ExpectedWorkspaceField />
          {/* KL-02: the bulk archive is one decision; a resubmit is a no-op. */}
          <input type="hidden" name="decisionKey" value={newDecisionKey()} />
          {fromRaw ? <input type="hidden" name="from" value={fromRaw} /> : null}
          {toRaw ? <input type="hidden" name="to" value={toRaw} /> : null}
          {page > 1 ? <input type="hidden" name="page" value={String(page)} /> : null}
          <div className="bulk-toolbar-info">
            {items.length > 0 ? <SelectAllVisible formId={BULK_FORM_ID} /> : null}
            <span className="bulk-toolbar-status">
              {items.length === 0
                ? 'No items match the current filter.'
                : `${items.length} on this page · ${total} total · up to 500 per action.`}
            </span>
          </div>
          <div className="bulk-toolbar-actions">
            {showArchiveAction ? (
              <button
                type="submit"
                formAction={bulkArchiveAction}
                className="ghost-btn"
                disabled={items.length === 0}
              >
                <Archive className="lucide" /> Archive selected
              </button>
            ) : null}
            <ConfirmFormButton
              formAction={bulkDeleteAction}
              message="Permanently delete the selected items? This cannot be undone. Items with recorded decisions or comments are kept — archive those instead."
              className="ghost-btn danger"
              disabled={items.length === 0}
            >
              <Trash2 className="lucide" /> Delete selected
            </ConfirmFormButton>
          </div>
        </form>

        <section>
          {items.length === 0 ? (
            <p className="muted">
              {total === 0
                ? stateKey === 'new'
                  ? 'No new items. Run a connector from the Connectors module to populate the queue.'
                  : stateKey === 'all'
                    ? 'No records yet.'
                    : `No records are ${REVIEW_ITEM_STATE_LABEL[stateKey].toLowerCase()}.`
                : `Page ${page} is past the end of the result set (${total} total). Use Prev to go back.`}
            </p>
          ) : (
            <ul className="profile-list bulk-selectable-list">
              {items.map(({ item, sourceRecord }) => {
                const normalized = sourceRecord.normalizedData as Record<string, unknown>;
                const title = (normalized.title as string | undefined) ?? sourceRecord.sourceUrl ?? `Record ${sourceRecord.id}`;
                const snippet = normalized.snippet as string | undefined;
                const domain = normalized.domain as string | undefined;
                return (
                  <li key={item.id.toString()}>
                    <label className="row-select">
                      <input
                        type="checkbox"
                        name="ids"
                        value={item.id.toString()}
                        form={BULK_FORM_ID}
                        data-tone="live"
                        aria-label={`Select review item ${title}`}
                      />
                    </label>
                    <Link href={`/review/${item.id}`}>{title}</Link>
                    {snippet ? <p className="muted">{snippet}</p> : null}
                    <div className="meta">
                      <StatusBadge set="review_item_state" value={item.state} />
                      {domain ? <span>{domain}</span> : null}
                      <span>system: {sourceRecord.sourceSystem}</span>
                      <span>conf {sourceRecord.confidence}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <Pagination
            basePath="/review"
            query={{
              state: stateKey === 'new' ? undefined : stateKey,
              from: fromRaw || undefined,
              to: toRaw || undefined,
            }}
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            unitLabel="items"
          />
        </section>
      </>
  );
}
