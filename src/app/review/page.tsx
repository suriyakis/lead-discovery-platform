import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
import { auth, signOut } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { getStateCounts, listReviewItems } from '@/lib/services/review';
import type { ReviewItemState } from '@/lib/db/schema/review';

const STATE_FILTERS: ReadonlyArray<{ key: 'all' | ReviewItemState; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'ignored', label: 'Ignored' },
  { key: 'archived', label: 'Archived' },
];

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const sp = await searchParams;
  const requested = sp.state ?? 'new';
  const isValidState = STATE_FILTERS.some((f) => f.key === requested);
  const stateKey = isValidState ? (requested as 'all' | ReviewItemState) : 'new';

  let counts;
  let items;
  try {
    const ctx = await getWorkspaceContext();
    counts = await getStateCounts(ctx);
    items = await listReviewItems(
      ctx,
      stateKey === 'all' ? {} : { state: stateKey as ReviewItemState },
    );
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <>
          <BrandHeader />
          <main>
            <h1>Review</h1>
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
          <Link href="/dashboard">Dashboard</Link> / Review
        </p>
        <h1>Review queue</h1>
        <p className="muted">
          Records harvested by connectors land here. Approve, reject, or comment to feed the
          learning layer.
        </p>

        <div className="state-tabs">
          {STATE_FILTERS.map((f) => {
            const count = f.key === 'all' ? counts.total : counts[f.key as keyof typeof counts];
            const active = f.key === stateKey;
            return (
              <Link
                key={f.key}
                href={f.key === 'new' ? '/review' : `/review?state=${f.key}`}
                className={active ? 'tab active' : 'tab'}
              >
                {f.label}
                <span className="tab-count">{count ?? 0}</span>
              </Link>
            );
          })}
        </div>

        <section>
          {items.length === 0 ? (
            <p className="muted">
              {stateKey === 'new'
                ? 'No new items. Run a connector from the Connectors module to populate the queue (Phase 6+ adds connector UI; for now the queue is seeded automatically when the runner produces source records).'
                : `No items in state "${stateKey}".`}
            </p>
          ) : (
            <ul className="profile-list">
              {items.map(({ item, sourceRecord }) => {
                const normalized = sourceRecord.normalizedData as Record<string, unknown>;
                const title = (normalized.title as string | undefined) ?? sourceRecord.sourceUrl ?? `Record ${sourceRecord.id}`;
                const snippet = normalized.snippet as string | undefined;
                const domain = normalized.domain as string | undefined;
                return (
                  <li key={item.id.toString()}>
                    <Link href={`/review/${item.id}`}>{title}</Link>
                    {snippet ? <p className="muted">{snippet}</p> : null}
                    <div className="meta">
                      {domain ? <span>{domain}</span> : null}
                      <span>state: {item.state}</span>
                      <span>system: {sourceRecord.sourceSystem}</span>
                      <span>conf {sourceRecord.confidence}</span>
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
