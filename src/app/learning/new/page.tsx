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
  createLesson,
  learningErrorMessage,
  type LessonCategory,
} from '@/lib/services/learning';
import {
  APPLIES_TO_LABELS,
  LESSON_CATEGORY_REGISTRY,
  MANUAL_LESSON_CATEGORIES,
} from '@/lib/services/learning-categories';
import { listProductProfiles } from '@/lib/services/product-profile';
import { isNextRedirectError } from '@/lib/server-redirect';
import { parseLessonForm } from '../lesson-form';

export default async function NewLessonPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let products;
  try {
    const ctx = await getWorkspaceContext();
    products = await listProductProfiles(ctx);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/learning');
    throw err;
  }

  async function create(formData: FormData): Promise<void> {
    'use server';
    const ctx = await getWorkspaceContext();
    const form = parseLessonForm(formData);
    try {
      const lesson = await createLesson(ctx, {
        category: form.category as LessonCategory,
        rule: form.rule,
        polarity: form.polarity,
        scope: form.scope,
        confidence: form.confidence,
      });
      redirect(`/learning/${lesson.id}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      if (err instanceof LearningServiceError) {
        redirect(`/learning/new?error=${encodeURIComponent(err.code)}`);
      }
      throw err;
    }
  }

  const errorMessage = learningErrorMessage(sp.error);

  return (
    <AppShell>
        <header className="page-intro" style={{ marginBottom: '1.25rem' }}>
          <p className="page-eyebrow">
            <Link href="/learning">Learning memory</Link> / New
          </p>
          <h1 className="page-title">New lesson</h1>
          <p className="page-lede">
            One sentence the platform should follow on similar future cases.
            The category decides where it is used: qualification, outreach
            drafts or reply suggestions.
          </p>
        </header>
        <form action={create} className="card-form">
          <div className="form-grid">
            {errorMessage ? <p className="mail-flash error">{errorMessage}</p> : null}

            <label>
              <span>Rule *</span>
              <textarea
                name="rule"
                rows={3}
                maxLength={1000}
                required
                placeholder="One sentence imperative, e.g. 'Skip councils for Vetrofluid offers.'"
              />
            </label>

            <label>
              <span>What is the rule about? *</span>
              <select name="category" required defaultValue="">
                <option value="" disabled>
                  Choose a category…
                </option>
                {MANUAL_LESSON_CATEGORIES.map((c) => {
                  const def = LESSON_CATEGORY_REGISTRY[c];
                  return (
                    <option key={c} value={c}>
                      {def.label} — used in{' '}
                      {def.appliesTo.map((a) => APPLIES_TO_LABELS[a]).join(', ')}
                    </option>
                  );
                })}
              </select>
              <small>
                There is no default: the category decides which step reads the
                rule. A rule filed under the wrong one is never used where you
                expect it.
              </small>
            </label>

            <details>
              <summary>What each category means</summary>
              <ul className="muted">
                {MANUAL_LESSON_CATEGORIES.map((c) => {
                  const def = LESSON_CATEGORY_REGISTRY[c];
                  return (
                    <li key={c}>
                      <strong>{def.label}</strong>: {def.description} Used in{' '}
                      {def.appliesTo.map((a) => APPLIES_TO_LABELS[a]).join(', ')}.
                    </li>
                  );
                })}
              </ul>
            </details>

            <label>
              <span>Direction</span>
              <select name="polarity" defaultValue="">
                <option value="">From the wording (avoid, skip, never… means Avoid)</option>
                <option value="prefer">Prefer: push similar records toward a fit</option>
                <option value="avoid">Avoid: push similar records away</option>
                <option value="neutral">Neutral: guidance only</option>
              </select>
              <small>
                Sector, contact-role and general rules can go either way. Writing
                and reply guidance is always neutral.
              </small>
            </label>

            <fieldset>
              <legend>Applies to</legend>
              <label className="checkbox-row">
                <input type="radio" name="scope" value="workspace" defaultChecked />
                All products in this workspace
              </label>
              <label className="checkbox-row">
                <input type="radio" name="scope" value="products" />
                Only the products selected below
              </label>
              {products.length > 0 ? (
                <select
                  name="productProfileIds"
                  multiple
                  size={Math.min(8, Math.max(3, products.length))}
                  defaultValue={[]}
                  aria-label="Products this rule applies to"
                >
                  {products.map((p) => (
                    <option key={p.id.toString()} value={p.id.toString()}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <small>This workspace has no products yet.</small>
              )}
            </fieldset>

            <label>
              <span>Confidence</span>
              <input
                name="confidence"
                type="number"
                min={0}
                max={100}
                step={5}
                defaultValue={65}
              />
              <small>0–100. Higher confidence lessons rank first when applied to prompts.</small>
            </label>

            <div className="form-actions">
              <button type="submit" className="primary-btn">
                Create lesson
              </button>
            </div>
          </div>
        </form>
      </AppShell>
  );
}
