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
  LESSON_CATEGORIES,
  LearningServiceError,
  type LessonCategory,
  disableLesson,
  enableLesson,
  getLesson,
  updateLesson,
} from '@/lib/services/learning';
import type { LearningLesson } from '@/lib/db/schema/learning';
import type { ProductProfile } from '@/lib/db/schema/products';
import type { WorkspaceContext } from '@/lib/services/context';
import { listProductProfiles } from '@/lib/services/product-profile';

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
  try {
    ctx = await getWorkspaceContext();
    lesson = await getLesson(ctx, id);
    products = await listProductProfiles(ctx);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/learning');
    if (err instanceof LearningServiceError && err.code === 'not_found') redirect('/learning');
    throw err;
  }

  async function update(formData: FormData): Promise<void> {
    'use server';
    const c = await getWorkspaceContext();
    const rule = String(formData.get('rule') ?? '').trim();
    const category = String(formData.get('category') ?? '') as LessonCategory;
    const productRaw = String(formData.get('productProfileId') ?? '');
    const confidenceRaw = String(formData.get('confidence') ?? '65');
    try {
      await updateLesson(c, id, {
        rule,
        category,
        productProfileId: productRaw && /^\d+$/.test(productRaw) ? BigInt(productRaw) : null,
        confidence: Number(confidenceRaw) || 65,
      });
      redirect(`/learning/${id}?saved=1`);
    } catch (err) {
      if (err instanceof LearningServiceError) {
        redirect(`/learning/${id}?error=${encodeURIComponent(err.code)}`);
      }
      throw err;
    }
  }

  async function toggle(): Promise<void> {
    'use server';
    const c = await getWorkspaceContext();
    if (lesson.enabled) {
      await disableLesson(c, id);
    } else {
      await enableLesson(c, id);
    }
    redirect(`/learning/${id}`);
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/learning">Learning</Link> / Lesson {lesson.id.toString()}
        </p>
        <h1>{lesson.rule.length > 60 ? `${lesson.rule.slice(0, 60)}…` : lesson.rule}</h1>
        <p>
          <span className="badge">{lesson.category}</span>{' '}
          <span className="badge">{lesson.enabled ? 'enabled' : 'disabled'}</span>
        </p>

        <form action={update} className="card-form">
          <div className="form-grid">
            {sp.saved ? <p className="muted">Saved.</p> : null}
            {sp.error ? <p className="form-error">Error: {sp.error}</p> : null}

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
              <span>Category</span>
              <select name="category" defaultValue={lesson.category}>
                {LESSON_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Product</span>
              <select
                name="productProfileId"
                defaultValue={lesson.productProfileId?.toString() ?? ''}
              >
                <option value="">— Workspace-wide —</option>
                {products.map((p) => (
                  <option key={p.id.toString()} value={p.id.toString()}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

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
          <p className="muted">
            {lesson.enabled
              ? 'Enabled. This lesson is included when classification or draft generation asks the learning layer for relevant lessons.'
              : 'Disabled. The lesson is preserved but not surfaced to the qualification or outreach prompts.'}
          </p>
          <form action={toggle}>
            <button type="submit" className="ghost-btn">
              {lesson.enabled ? 'Disable lesson' : 'Enable lesson'}
            </button>
          </form>
        </section>
      </AppShell>
  );
}
