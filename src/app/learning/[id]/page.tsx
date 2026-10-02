import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  LearningServiceError,
  disableLesson,
  enableLesson,
  getLesson,
  getLessonScopeProducts,
  learningErrorMessage,
  updateLesson,
  type LessonCategory,
} from '@/lib/services/learning';
import {
  APPLIES_TO_LABELS,
  LESSON_CATEGORIES,
  LESSON_CATEGORY_REGISTRY,
  getLessonCategoryDefinition,
  isLessonCategory,
  lessonCategoryLabel,
  lessonPolarityFormValue,
  lessonPolarityLabel,
} from '@/lib/services/learning-categories';
import type { LearningLesson } from '@/lib/db/schema/learning';
import type { ProductProfile } from '@/lib/db/schema/products';
import { canAdminWorkspace, type WorkspaceContext } from '@/lib/services/context';
import { listProductProfiles } from '@/lib/services/product-profile';
import { isNextRedirectError } from '@/lib/server-redirect';
import { parseLessonForm } from '../lesson-form';

const RETIRED_REASON_TEXT: Record<string, string> = {
  stale: 'it had low confidence and was not used for a long time',
  merged: 'it was merged into another rule',
  superseded: 'a newer rule replaced it',
  contradicted: 'it contradicted a stronger rule',
  operator_rejected: 'an operator rejected it',
  source_decision_voided: 'the decision it was learned from was undone',
  absorbed_into_profile: 'the product profile now says the same thing',
  product_deleted: 'its product was deleted',
  category_removed: 'its category was removed: nothing ever used it',
};

export default async function EditLessonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/learning');
  const id = BigInt(idStr);
  const sp = await searchParams;

  let ctx: WorkspaceContext;
  let lesson: LearningLesson;
  let products: ProductProfile[];
  let scopedIds: bigint[] = [];
  try {
    ctx = await getWorkspaceContext();
    lesson = await getLesson(ctx, id);
    products = await listProductProfiles(ctx, { includeArchived: true });
    scopedIds = (await getLessonScopeProducts(ctx, [id])).get(id.toString()) ?? [];
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/learning');
    if (err instanceof LearningServiceError && err.code === 'not_found') redirect('/learning');
    throw err;
  }
  const isAdmin = canAdminWorkspace(ctx);

  async function update(formData: FormData): Promise<void> {
    'use server';
    const c = await getWorkspaceContext();
    const form = parseLessonForm(formData);
    try {
      await updateLesson(c, id, {
        rule: form.rule,
        category: form.category as LessonCategory,
        ...(form.polarity !== undefined ? { polarity: form.polarity } : {}),
        scope: form.scope,
        confidence: form.confidence,
      });
      redirect(`/learning/${id}?saved=1`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      if (err instanceof LearningServiceError) {
        redirect(`/learning/${id}?error=${encodeURIComponent(err.code)}`);
      }
      throw err;
    }
  }

  async function setStatus(formData: FormData): Promise<void> {
    'use server';
    const c = await getWorkspaceContext();
    const intent = String(formData.get('intent') ?? '');
    try {
      if (intent === 'disable') {
        await disableLesson(c, id);
      } else if (intent === 'enable' || intent === 'restore') {
        await enableLesson(c, id);
      }
      redirect(`/learning/${id}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      if (err instanceof LearningServiceError) {
        redirect(`/learning/${id}?error=${encodeURIComponent(err.code)}`);
      }
      throw err;
    }
  }

  const confidenceBadgeCls =
    lesson.confidence >= 75
      ? 'badge badge-good'
      : lesson.confidence < 40
        ? 'badge badge-bad'
        : 'badge badge-warn';
  const productNameById = new Map(products.map((p) => [p.id.toString(), p.name]));
  const needsScope = lesson.scopeKind === 'products' && scopedIds.length === 0;
  const scopeText =
    lesson.scopeKind === 'workspace'
      ? 'all products'
      : scopedIds
          .map((pid) => `→ ${productNameById.get(pid.toString()) ?? `product #${pid}`}`)
          .join(', ');
  const def = getLessonCategoryDefinition(lesson.category);
  // The edit select offers every registry category; a legacy row whose
  // category left the registry shows it once so the form does not lie.
  const categoryOptions: string[] = isLessonCategory(lesson.category)
    ? [...LESSON_CATEGORIES]
    : [lesson.category, ...LESSON_CATEGORIES];
  const errorMessage = learningErrorMessage(sp.error);
  const lifecycleBadgeCls =
    lesson.lifecycle === 'active'
      ? 'badge badge-good'
      : lesson.lifecycle === 'proposed'
        ? 'badge badge-warn'
        : 'badge badge-bad';

  return (
    <AppShell>
        <header className="page-intro" style={{ marginBottom: '1.25rem' }}>
          <p className="page-eyebrow">
            <Link href="/learning">Learning memory</Link> / Lesson {lesson.id.toString()}
          </p>
          <h1 className="page-title">
            {lesson.rule.length > 80 ? `${lesson.rule.slice(0, 80)}…` : lesson.rule}
          </h1>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '0.5rem',
              marginTop: '0.5rem',
            }}
          >
            <span className={confidenceBadgeCls}>conf {lesson.confidence}</span>
            <span className="badge">{lessonCategoryLabel(lesson.category)}</span>
            {lesson.polarity !== 0 ? (
              <span className={lesson.polarity > 0 ? 'badge badge-good' : 'badge badge-bad'}>
                {lessonPolarityLabel(lesson.polarity)}
              </span>
            ) : null}
            <span className={lifecycleBadgeCls}>{lesson.lifecycle}</span>
            {needsScope ? (
              <span className="badge badge-bad">Needs a scope</span>
            ) : (
              <span className="muted" style={{ marginLeft: '0.25rem' }}>
                {scopeText}
              </span>
            )}
          </div>
          {def ? (
            <p className="muted">
              Used in {def.appliesTo.map((a) => APPLIES_TO_LABELS[a]).join(', ')}.
            </p>
          ) : (
            <p className="muted">
              This category was removed from the platform; choose a current one to use the rule
              again.
            </p>
          )}
        </header>

        <form action={update} className="card-form">
          <div className="form-grid">
            {sp.saved ? <p className="mail-flash info">Saved.</p> : null}
            {errorMessage ? <p className="mail-flash error">{errorMessage}</p> : null}

            <label>
              <span>Rule</span>
              <textarea
                name="rule"
                rows={4}
                maxLength={1000}
                required
                defaultValue={lesson.rule}
              />
            </label>

            <label>
              <span>What is the rule about?</span>
              <select name="category" defaultValue={lesson.category}>
                {categoryOptions.map((c) => (
                  <option key={c} value={c}>
                    {isLessonCategory(c)
                      ? `${LESSON_CATEGORY_REGISTRY[c].label} — used in ${LESSON_CATEGORY_REGISTRY[c].appliesTo
                          .map((a) => APPLIES_TO_LABELS[a])
                          .join(', ')}`
                      : `${lessonCategoryLabel(c)} (removed)`}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Direction</span>
              <select name="polarity" defaultValue={lessonPolarityFormValue(lesson.polarity)}>
                <option value="prefer">Prefer: push similar records toward a fit</option>
                <option value="avoid">Avoid: push similar records away</option>
                <option value="neutral">Neutral: guidance only</option>
              </select>
            </label>

            <fieldset>
              <legend>Applies to</legend>
              <label className="checkbox-row">
                <input
                  type="radio"
                  name="scope"
                  value="workspace"
                  defaultChecked={lesson.scopeKind === 'workspace'}
                />
                All products in this workspace
              </label>
              <label className="checkbox-row">
                <input
                  type="radio"
                  name="scope"
                  value="products"
                  defaultChecked={lesson.scopeKind === 'products'}
                />
                Only the products selected below
              </label>
              {products.length > 0 ? (
                <select
                  name="productProfileIds"
                  multiple
                  size={Math.min(8, Math.max(3, products.length))}
                  defaultValue={scopedIds.map((p) => p.toString())}
                  aria-label="Products this rule applies to"
                >
                  {products.map((p) => (
                    <option key={p.id.toString()} value={p.id.toString()}>
                      {p.name}
                      {p.active ? '' : ' (archived)'}
                    </option>
                  ))}
                </select>
              ) : (
                <small>This workspace has no products yet.</small>
              )}
              {needsScope ? (
                <small>
                  Every product this rule applied to was deleted, so it is not used anywhere.
                  Select products or apply it to all products.
                </small>
              ) : null}
            </fieldset>

            <label>
              <span>Confidence</span>
              <input
                name="confidence"
                type="number"
                min={0}
                max={100}
                step={5}
                defaultValue={lesson.confidence}
              />
            </label>

            <div className="form-actions">
              <button type="submit" className="primary-btn">
                Save changes
              </button>
            </div>
          </div>
        </form>

        <section>
          <h2>Status</h2>
          {lesson.lifecycle === 'active' ? (
            <p className="muted">
              {needsScope
                ? 'Active, but it has no product left, so no prompt receives it.'
                : 'Active. The platform includes this rule wherever its category is used.'}
            </p>
          ) : lesson.lifecycle === 'proposed' ? (
            <p className="muted">
              Proposed by the platform. It is not used until someone enables it.
            </p>
          ) : lesson.lifecycle === 'disabled' ? (
            <p className="muted">
              Disabled. The rule is kept but no prompt or scoring step receives it.
            </p>
          ) : (
            <p className="muted">
              Retired because{' '}
              {(lesson.retiredReason && RETIRED_REASON_TEXT[lesson.retiredReason]) ??
                'it was taken out of service'}
              .{lesson.retiredNote ? ` ${lesson.retiredNote}` : ''}
              {lesson.mergedIntoId ? (
                <>
                  {' '}
                  See <Link href={`/learning/${lesson.mergedIntoId}`}>the rule that replaced it</Link>.
                </>
              ) : null}
            </p>
          )}
          {lesson.lifecycle === 'retired' ? (
            isAdmin ? (
              <form action={setStatus}>
                <input type="hidden" name="intent" value="restore" />
                <button type="submit" className="ghost-btn">
                  Restore lesson
                </button>
              </form>
            ) : (
              <p className="muted">A workspace admin can restore it.</p>
            )
          ) : (
            <div className="action-row" style={{ display: 'flex', gap: '0.5rem' }}>
              {lesson.lifecycle !== 'active' ? (
                <form action={setStatus}>
                  <input type="hidden" name="intent" value="enable" />
                  <button type="submit" className="ghost-btn">
                    Enable lesson
                  </button>
                </form>
              ) : null}
              {lesson.lifecycle !== 'disabled' ? (
                <form action={setStatus}>
                  <input type="hidden" name="intent" value="disable" />
                  <button type="submit" className="ghost-btn">
                    Disable lesson
                  </button>
                </form>
              ) : null}
            </div>
          )}
        </section>
      </AppShell>
  );
}
