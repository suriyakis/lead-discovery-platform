import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  LESSON_CATEGORIES,
  getLessonCategoryCounts,
  listLessons,
  type LessonCategoryCounts,
} from '@/lib/services/learning';
import {
  compactWorkspaceKnowledge,
  lastCompactionRun,
} from '@/lib/services/knowledge-compaction';
import { listProductProfiles } from '@/lib/services/product-profile';

function confidenceBadgeClass(conf: number): string {
  if (conf >= 75) return 'badge badge-good';
  if (conf < 40) return 'badge badge-bad';
  return 'badge';
}

const CATEGORY_FILTERS = [
  { key: 'all' as const, label: 'All' },
  ...LESSON_CATEGORIES.map((c) => ({ key: c, label: c.replace(/_/g, ' ') })),
];

export default async function LearningPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; enabled?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  const categoryKey = sp.category && CATEGORY_FILTERS.some((f) => f.key === sp.category)
    ? sp.category
    : 'all';
  const showDisabled = sp.enabled === 'all';

  let lessons;
  let counts: LessonCategoryCounts | null = null;
  let productNameById = new Map<string, string>();
  let isAdmin = false;
  let lastCompaction: Awaited<ReturnType<typeof lastCompactionRun>> = null;
  try {
    const ctx = await getWorkspaceContext();
    isAdmin = canAdminWorkspace(ctx);
    const enabledFilter = showDisabled ? {} : { enabled: true as const };
    counts = await getLessonCategoryCounts(ctx, enabledFilter);
    lessons = await listLessons(ctx, {
      ...(categoryKey !== 'all'
        ? { category: categoryKey as (typeof LESSON_CATEGORIES)[number] }
        : {}),
      ...enabledFilter,
      limit: 500,
    });
    const products = await listProductProfiles(ctx, { includeArchived: true });
    productNameById = new Map(products.map((p) => [p.id.toString(), p.name]));
    lastCompaction = await lastCompactionRun(ctx);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>Learning memory</h1>
            <section>
              <p>You don&apos;t belong to a workspace yet.</p>
            </section>
          </AppShell>
      );
    }
    throw err;
  }

  async function runCompaction() {
    'use server';
    const c = await getWorkspaceContext();
    await compactWorkspaceKnowledge(c);
    redirect('/learning');
  }

  return (
    <AppShell>
        <div className="page-header">
          <div className="page-intro">
            <p className="page-eyebrow">Knowledge base</p>
            <h1 className="page-title">Learning memory</h1>
            <p className="page-lede">
              Structured lessons distilled from review feedback. Qualification
              and outreach prompts read these to refine their behavior.
            </p>
          </div>
          <div className="action-row">
            <Link href="/learning/new" className="primary-btn">
              + New lesson
            </Link>
          </div>
        </div>

        <section className="compaction-panel">
          <div>
            <strong>Knowledge compaction</strong>
            <p className="muted">
              Weekly AI pass that merges near-duplicate lessons and retires
              stale low-confidence ones. Survivor lessons keep the full
              evidence trail; retired ones are disabled, not deleted.
            </p>
            {lastCompaction ? (
              <p className="muted">
                Last run: {lastCompaction.at.toLocaleString()} ·{' '}
                merged {String(lastCompaction.summary.mergedClusters ?? 0)}{' '}
                clusters · retired{' '}
                {String(
                  (Number(lastCompaction.summary.retiredMergedCount ?? 0) +
                    Number(lastCompaction.summary.retiredStaleCount ?? 0)),
                )}{' '}
                lessons
              </p>
            ) : (
              <p className="muted">No compaction has run yet for this workspace.</p>
            )}
          </div>
          {isAdmin ? (
            <form action={runCompaction}>
              <button type="submit" className="ghost-btn">
                Compact now
              </button>
            </form>
          ) : null}
        </section>

        <div className="state-tabs">
          {CATEGORY_FILTERS.map((f) => {
            const active = f.key === categoryKey;
            const params = new URLSearchParams();
            if (f.key !== 'all') params.set('category', f.key);
            if (showDisabled) params.set('enabled', 'all');
            const qs = params.toString();
            const count = f.key === 'all' ? counts?.total ?? 0 : counts?.[f.key] ?? 0;
            return (
              <Link
                key={f.key}
                href={qs ? `/learning?${qs}` : '/learning'}
                className={active ? 'tab active' : 'tab'}
              >
                {f.label}
                <span className="tab-count">{count}</span>
              </Link>
            );
          })}
        </div>
        <form className="leads-controls" method="get" style={{ marginTop: '0.85rem' }}>
          {categoryKey !== 'all' ? (
            <input type="hidden" name="category" value={categoryKey} />
          ) : null}
          <label>
            <input
              type="checkbox"
              name="enabled"
              value="all"
              defaultChecked={showDisabled}
            />
            Show disabled lessons
          </label>
          <button type="submit">Apply</button>
        </form>

        <section>
          {lessons.length === 0 ? (
            <p className="muted">
              No lessons yet. Comments on review items that mention things like &quot;don&apos;t
              target X&quot; or &quot;tone too formal&quot; auto-extract into lessons. You can also
              create one manually.
            </p>
          ) : (
            <ul className="profile-list">
              {lessons.map((l) => {
                const productId = l.productProfileId?.toString();
                const productName = productId
                  ? productNameById.get(productId) ?? `product #${productId}`
                  : null;
                return (
                  <li key={l.id.toString()} className={l.enabled ? '' : 'archived'}>
                    <Link href={`/learning/${l.id}`}>{l.rule}</Link>
                    <div className="meta">
                      <span className={confidenceBadgeClass(l.confidence)}>
                        conf {l.confidence}
                      </span>
                      <span>{l.category.replace(/_/g, ' ')}</span>
                      <span>
                        {productName ? `→ ${productName}` : 'workspace-wide'}
                      </span>
                      {!l.enabled ? <span>disabled</span> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </AppShell>
  );
}
