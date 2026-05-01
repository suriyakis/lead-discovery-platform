import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BrandHeader } from '@/components/BrandHeader';
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
  createLesson,
} from '@/lib/services/learning';
import { listProductProfiles } from '@/lib/services/product-profile';

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
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/learning');
    throw err;
  }

  async function create(formData: FormData): Promise<void> {
    'use server';
    const ctx = await getWorkspaceContext();
    const category = String(formData.get('category') ?? '') as LessonCategory;
    const rule = String(formData.get('rule') ?? '').trim();
    const productRaw = String(formData.get('productProfileId') ?? '');
    const confidenceRaw = String(formData.get('confidence') ?? '65');
    try {
      const lesson = await createLesson(ctx, {
        category,
        rule,
        productProfileId: productRaw && /^\d+$/.test(productRaw) ? BigInt(productRaw) : null,
        confidence: Number(confidenceRaw) || 65,
      });
      redirect(`/learning/${lesson.id}`);
    } catch (err) {
      if (err instanceof LearningServiceError) {
        redirect(`/learning/new?error=${encodeURIComponent(err.code)}`);
      }
      throw err;
    }
  }

  return (
    <>
      <BrandHeader />
      <main>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/learning">Learning</Link> / New
        </p>
        <h1>New lesson</h1>
        <form action={create} className="card-form">
          <div className="form-grid">
            {sp.error ? <p className="form-error">Error: {sp.error}</p> : null}

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
              <span>Category *</span>
              <select name="category" required defaultValue="general_instruction">
                {LESSON_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Product (optional)</span>
              <select name="productProfileId" defaultValue="">
                <option value="">— Workspace-wide —</option>
                {products.map((p) => (
                  <option key={p.id.toString()} value={p.id.toString()}>
                    {p.name}
                  </option>
                ))}
              </select>
              <small>Leave blank to apply to every product profile in this workspace.</small>
            </label>

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
      </main>
    </>
  );
}
