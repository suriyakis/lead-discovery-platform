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
  countLessons,
  getLessonCategoryCounts,
  getLessonScopeProducts,
  listLessons,
  type ListLessonsFilter,
  type LessonCategoryCounts,
} from '@/lib/services/learning';
import {
  APPLIES_TO_LABELS,
  LESSON_CATEGORIES,
  getLessonCategoryDefinition,
  lessonCategoryLabel,
  lessonPolarityLabel,
  type LessonCategory,
} from '@/lib/services/learning-categories';
import {
  compactWorkspaceKnowledge,
  lastCompactionRun,
} from '@/lib/services/knowledge-compaction';
import { synthesizeWorkspaceLearning } from '@/lib/services/learning-synthesis';
import { isNextRedirectError } from '@/lib/server-redirect';
import { listProductProfiles } from '@/lib/services/product-profile';
import type { LessonLifecycle } from '@/lib/db/schema/learning';
import { bulkDisableAction, bulkEnableAction } from './actions';

const BULK_FORM_ID = 'learning-bulk-form';
const PAGE_SIZE = 25;

/** Lifecycles shown by default: rules in service or waiting for a decision. */
const DEFAULT_LIFECYCLES: readonly LessonLifecycle[] = ['active', 'proposed'];

function confidenceBadgeClass(conf: number): string {
  if (conf >= 75) return 'badge badge-good';
  if (conf < 40) return 'badge badge-bad';
  // Middle of the traffic light. A bare .badge is neutral now (I151).
  return 'badge badge-warn';
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

const RETIRED_REASON_LABELS: Record<string, string> = {
  stale: 'retired: unused',
  merged: 'retired: merged',
  superseded: 'retired: superseded',
  contradicted: 'retired: contradicted',
  operator_rejected: 'retired: rejected',
  source_decision_voided: 'retired: decision undone',
  absorbed_into_profile: 'retired: in the profile',
  product_deleted: 'retired: product deleted',
  category_removed: 'retired: category removed',
};

function lifecycleBadge(
  lifecycle: LessonLifecycle,
  retiredReason: string | null,
): { label: string; cls: string } | null {
  switch (lifecycle) {
    case 'active':
      return null;
    case 'proposed':
      return { label: 'proposed', cls: 'badge badge-warn' };
    case 'disabled':
      return { label: 'disabled', cls: 'badge' };
    case 'retired':
      return {
        label: (retiredReason && RETIRED_REASON_LABELS[retiredReason]) ?? 'retired',
        cls: 'badge',
      };
  }
}

function appliesToText(category: string): string | null {
  const def = getLessonCategoryDefinition(category);
  if (!def) return null;
  return def.appliesTo.map((a) => APPLIES_TO_LABELS[a]).join(' · ');
}

const CATEGORY_FILTERS = [
  { key: 'all' as const, label: 'All' },
  ...LESSON_CATEGORIES.map((c) => ({ key: c, label: lessonCategoryLabel(c) })),
];

export default async function LearningPage({
  searchParams,
}: {
  searchParams: Promise<{
    category?: string;
    enabled?: string;
    scope?: string;
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
  const needsScopeOnly = sp.scope === 'needs_scope';
  const pageParam = Number(sp.page ?? 1);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  let lessons;
  let counts: LessonCategoryCounts | null = null;
  let productNameById = new Map<string, string>();
  let scopeByLesson = new Map<string, bigint[]>();
  let needsScopeCount = 0;
  let isAdmin = false;
  let lastCompaction: Awaited<ReturnType<typeof lastCompactionRun>> = null;
  let total = 0;
  try {
    const ctx = await getWorkspaceContext();
    isAdmin = canAdminWorkspace(ctx);
    const lifecycleFilter = showDisabled ? {} : { lifecycle: DEFAULT_LIFECYCLES };
    counts = await getLessonCategoryCounts(ctx, lifecycleFilter);
    const listFilter: Omit<ListLessonsFilter, 'limit' | 'offset'> = {
      ...(categoryKey !== 'all' ? { category: categoryKey as LessonCategory } : {}),
      ...lifecycleFilter,
      ...(needsScopeOnly ? { needsScope: true } : {}),
    };
    total = await countLessons(ctx, listFilter);
    lessons = await listLessons(ctx, {
      ...listFilter,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
    needsScopeCount = await countLessons(ctx, { ...lifecycleFilter, needsScope: true });
    scopeByLesson = await getLessonScopeProducts(
      ctx,
      lessons.filter((l) => l.scopeKind === 'products').map((l) => l.id),
    );
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

  const filterQuery = (overrides: { category?: string; scope?: string | null } = {}) => {
    const params = new URLSearchParams();
    const cat = overrides.category ?? categoryKey;
    if (cat !== 'all') params.set('category', cat);
    if (showDisabled) params.set('enabled', 'all');
    const scope = overrides.scope === undefined ? (needsScopeOnly ? 'needs_scope' : null) : overrides.scope;
    if (scope) params.set('scope', scope);
    const qs = params.toString();
    return qs ? `/learning?${qs}` : '/learning';
  };

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
              evidence trail; retired ones stay on record with the reason,
              they are never deleted.
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

        {needsScopeCount > 0 ? (
          <p className="mail-flash error">
            {needsScopeCount} rule{needsScopeCount === 1 ? '' : 's'} lost every
            product {needsScopeCount === 1 ? 'it' : 'they'} applied to and{' '}
            {needsScopeCount === 1 ? 'is' : 'are'} not used anywhere.{' '}
            {needsScopeOnly ? (
              <Link href={filterQuery({ scope: null })}>Show all rules</Link>
            ) : (
              <Link href={filterQuery({ scope: 'needs_scope' })}>
                Show the rules that need a scope
              </Link>
            )}
          </p>
        ) : null}

        <div className="state-tabs">
          {CATEGORY_FILTERS.map((f) => {
            const active = f.key === categoryKey;
            const count = f.key === 'all' ? counts?.total ?? 0 : counts?.[f.key] ?? 0;
            const def = f.key === 'all' ? null : getLessonCategoryDefinition(f.key);
            return (
              <Link
                key={f.key}
                href={filterQuery({ category: f.key })}
                className={active ? 'tab active' : 'tab'}
                title={def ? def.description : undefined}
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
          {needsScopeOnly ? <input type="hidden" name="scope" value="needs_scope" /> : null}
          <label>
            <input
              type="checkbox"
              name="enabled"
              value="all"
              defaultChecked={showDisabled}
            />
            Show disabled and retired lessons
          </label>
          <button type="submit">Apply</button>
        </form>

        <form id={BULK_FORM_ID} action={bulkDisableAction} className="bulk-toolbar">
          {categoryKey !== 'all' ? (
            <input type="hidden" name="category" value={categoryKey} />
          ) : null}
          {showDisabled ? <input type="hidden" name="enabled" value="all" /> : null}
          {needsScopeOnly ? <input type="hidden" name="scope" value="needs_scope" /> : null}
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
                const scopedIds = scopeByLesson.get(l.id.toString()) ?? [];
                const scopeText =
                  l.scopeKind === 'workspace'
                    ? 'all products'
                    : scopedIds
                        .map((pid) => productNameById.get(pid.toString()) ?? `product #${pid}`)
                        .map((name) => `→ ${name}`)
                        .join(', ');
                const needsScope = l.scopeKind === 'products' && scopedIds.length === 0;
                const lifecycle = lifecycleBadge(l.lifecycle, l.retiredReason);
                const appliesTo = appliesToText(l.category);
                return (
                  <li key={l.id.toString()} className={l.lifecycle === 'active' ? '' : 'archived'}>
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
                      <span>{lessonCategoryLabel(l.category)}</span>
                      {l.polarity !== 0 ? (
                        <span className={l.polarity > 0 ? 'badge badge-good' : 'badge badge-bad'}>
                          {lessonPolarityLabel(l.polarity)}
                        </span>
                      ) : null}
                      {needsScope ? (
                        <span
                          className="badge badge-bad"
                          title="Every product this rule applied to was deleted. Open it to choose products or apply it to all products."
                        >
                          Needs a scope
                        </span>
                      ) : (
                        <span>{scopeText}</span>
                      )}
                      {appliesTo ? (
                        <span title="Where the platform uses this rule">{appliesTo}</span>
                      ) : null}
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
                      {lifecycle ? <span className={lifecycle.cls}>{lifecycle.label}</span> : null}
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
              scope: needsScopeOnly ? 'needs_scope' : undefined,
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
