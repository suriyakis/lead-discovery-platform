import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CheckCircle2, MinusCircle } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { Pagination } from '@/components/Pagination';
import { SelectAllVisible } from '@/components/SelectAllVisible';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  LESSON_CATEGORIES,
  countLessons,
  getLessonCategoryCounts,
  listLessons,
  type LessonCategoryCounts,
} from '@/lib/services/learning';
import {
  compactWorkspaceKnowledge,
  lastCompactionRun,
} from '@/lib/services/knowledge-compaction';
import { synthesizeWorkspaceLearning } from '@/lib/services/learning-synthesis';
import { isNextRedirectError } from '@/lib/server-redirect';
import { listProductProfiles } from '@/lib/services/product-profile';
import { bulkDisableAction, bulkEnableAction } from './actions';

const BULK_FORM_ID = 'learning-bulk-form';
const PAGE_SIZE = 25;

function confidenceBadgeClass(conf: number): string {
  if (conf >= 75) return 'badge badge-good';
  if (conf < 40) return 'badge badge-bad';
  return 'badge';
}

/** Provenance badge: who taught the platform this rule. */
function sourceLabel(source: string): { label: string; title: string } | null {
  switch (source) {
    case 'synthesis':
      return {
        label: '✦ auto-learned',
        title: 'Proposed by the weekly self-learning pass from recent activity patterns',
      };
    case 'draft_edit':
      return {
        label: '✎ from your edits',
        title: 'Learned by comparing an AI draft with the operator’s edited version',
      };
    default:
      return null; // operator-taught is the norm — no badge noise
  }
}

const CATEGORY_FILTERS = [
  { key: 'all' as const, label: 'All' },
  ...LESSON_CATEGORIES.map((c) => ({ key: c, label: c.replace(/_/g, ' ') })),
];

export default async function LearningPage({
  searchParams,
}: {
  searchParams: Promise<{
    category?: string;
    enabled?: string;
    page?: string;
    message?: string;
    error?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  const categoryKey = sp.category && CATEGORY_FILTERS.some((f) => f.key === sp.category)
    ? sp.category
    : 'all';
  const showDisabled = sp.enabled === 'all';
  const pageParam = Number(sp.page ?? 1);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  let lessons;
  let counts: LessonCategoryCounts | null = null;
  let productNameById = new Map<string, string>();
  let isAdmin = false;
  let lastCompaction: Awaited<ReturnType<typeof lastCompactionRun>> = null;
  let total = 0;
  try {
    const ctx = await getWorkspaceContext();
    isAdmin = canAdminWorkspace(ctx);
    const enabledFilter = showDisabled ? {} : { enabled: true as const };
    counts = await getLessonCategoryCounts(ctx, enabledFilter);
    const listFilter = {
      ...(categoryKey !== 'all'
        ? { category: categoryKey as (typeof LESSON_CATEGORIES)[number] }
        : {}),
      ...enabledFilter,
    };
    total = await countLessons(ctx, listFilter);
    lessons = await listLessons(ctx, {
      ...listFilter,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
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

  async function runSynthesis() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      const s = await synthesizeWorkspaceLearning(c);
      const msg = !s.ran
        ? s.skippedReason === 'insufficient_events'
          ? `Not enough recent activity to learn from yet (${s.eventsExamined} events in the last 14 days — need 10+).`
          : 'Skipped — no tokens left for the AI pass.'
        : s.lessonsCreated > 0
          ? `Learned ${s.lessonsCreated} new rule${s.lessonsCreated === 1 ? '' : 's'} from ${s.eventsExamined} recent events.`
          : `Examined ${s.eventsExamined} recent events — no reliable new pattern found.`;
      redirect(`/learning?message=${encodeURIComponent(msg)}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'synthesis failed';
      redirect(`/learning?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
        <div className="page-header">
          <div className="page-intro">
            <p className="page-eyebrow">Knowledge base</p>
            <h1 className="page-title">Learning memory</h1>
            <p className="page-lede">
              Structured lessons the platform follows when qualifying and
              writing outreach. It learns from four channels: your review
              comments, your edits to AI drafts, how leads actually reply,
              and a weekly AI pass that mines recent activity for patterns.
              Confidence self-adjusts — rules confirmed by outcomes rise,
              contradicted ones sink and eventually retire.
            </p>
          </div>
          <div className="action-row">
            <Link href="/learning/new" className="primary-btn">
              + New lesson
            </Link>
          </div>
        </div>

        {sp.message ? <p className="mail-flash info">{sp.message}</p> : null}
        {sp.error ? <p className="mail-flash error">{sp.error}</p> : null}

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
            <div className="action-row" style={{ display: 'flex', gap: '0.5rem' }}>
              <form action={runCompaction}>
                <button type="submit" className="ghost-btn">
                  Compact now
                </button>
              </form>
              <form action={runSynthesis}>
                <button
                  type="submit"
                  className="ghost-btn"
                  title="AI pass over the last 14 days of decisions, replies and edits — proposes new rules the base doesn't cover yet"
                >
                  ✦ Synthesize now
                </button>
              </form>
            </div>
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

        <form id={BULK_FORM_ID} action={bulkDisableAction} className="bulk-toolbar">
          {categoryKey !== 'all' ? (
            <input type="hidden" name="category" value={categoryKey} />
          ) : null}
          {showDisabled ? <input type="hidden" name="enabled" value="all" /> : null}
          {page > 1 ? <input type="hidden" name="page" value={String(page)} /> : null}
          <div className="bulk-toolbar-info">
            {lessons.length > 0 ? <SelectAllVisible formId={BULK_FORM_ID} /> : null}
            <span className="bulk-toolbar-status">
              {lessons.length === 0
                ? 'No lessons match the current filter.'
                : `${lessons.length} on this page · ${total} total · up to 500 per action.`}
            </span>
          </div>
          <div className="bulk-toolbar-actions">
            {showDisabled ? (
              <button
                type="submit"
                formAction={bulkEnableAction}
                className="ghost-btn"
                disabled={lessons.length === 0}
              >
                <CheckCircle2 className="lucide" /> Enable selected
              </button>
            ) : null}
            <button
              type="submit"
              formAction={bulkDisableAction}
              className="ghost-btn"
              disabled={lessons.length === 0}
            >
              <MinusCircle className="lucide" /> Disable selected
            </button>
          </div>
        </form>

        <section>
          {lessons.length === 0 ? (
            <p className="muted">
              {total === 0
                ? 'No lessons yet. Comments on review items that mention things like "don’t target X" or "tone too formal" auto-extract into lessons. You can also create one manually.'
                : `Page ${page} is past the end of the result set (${total} total). Use Prev to go back.`}
            </p>
          ) : (
            <ul className="profile-list bulk-selectable-list">
              {lessons.map((l) => {
                const productId = l.productProfileId?.toString();
                const productName = productId
                  ? productNameById.get(productId) ?? `product #${productId}`
                  : null;
                return (
                  <li key={l.id.toString()} className={l.enabled ? '' : 'archived'}>
                    <label className="row-select">
                      <input
                        type="checkbox"
                        name="ids"
                        value={l.id.toString()}
                        form={BULK_FORM_ID}
                        aria-label={`Select lesson ${l.rule.slice(0, 60)}`}
                      />
                    </label>
                    <Link href={`/learning/${l.id}`}>{l.rule}</Link>
                    <div className="meta">
                      <span className={confidenceBadgeClass(l.confidence)}>
                        conf {l.confidence}
                      </span>
                      <span>{l.category.replace(/_/g, ' ')}</span>
                      <span>
                        {productName ? `→ ${productName}` : 'workspace-wide'}
                      </span>
                      {(() => {
                        const s = sourceLabel(l.source);
                        return s ? (
                          <span className="badge" title={s.title}>
                            {s.label}
                          </span>
                        ) : null;
                      })()}
                      {l.applicationCount > 0 ? (
                        <span title="How many times qualification/outreach pulled this rule into a prompt">
                          used {l.applicationCount}×
                        </span>
                      ) : null}
                      {!l.enabled ? <span>disabled</span> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <Pagination
            basePath="/learning"
            query={{
              category: categoryKey === 'all' ? undefined : categoryKey,
              enabled: showDisabled ? 'all' : undefined,
            }}
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            unitLabel="lessons"
          />
        </section>
      </AppShell>
  );
}
