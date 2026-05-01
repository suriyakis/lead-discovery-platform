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
  ProductProfileServiceError,
  archiveProductProfile,
  getProductProfile,
  restoreProductProfile,
  updateProductProfile,
} from '@/lib/services/product-profile';
import { canAdminWorkspace } from '@/lib/services/context';
import { ProductFields, readArrayField, readNullableString } from '../_form';

export default async function EditProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const { id: idStr } = await params;
  if (!/^\d+$/.test(idStr)) redirect('/products');
  const id = BigInt(idStr);
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/products');
    throw err;
  }

  let profile;
  try {
    profile = await getProductProfile(ctx, id);
  } catch (err) {
    if (err instanceof ProductProfileServiceError && err.code === 'not_found') {
      redirect('/products');
    }
    throw err;
  }

  async function update(formData: FormData): Promise<void> {
    'use server';
    const ctxInner = await getWorkspaceContext();
    const relevanceThresholdRaw = formData.get('relevanceThreshold');
    const relevanceThreshold =
      typeof relevanceThresholdRaw === 'string' && relevanceThresholdRaw !== ''
        ? Number(relevanceThresholdRaw)
        : undefined;

    try {
      await updateProductProfile(ctxInner, id, {
        name: String(formData.get('name') ?? '').trim(),
        shortDescription: readNullableString(formData, 'shortDescription'),
        fullDescription: readNullableString(formData, 'fullDescription'),
        targetCustomerTypes: readArrayField(formData, 'targetCustomerTypes'),
        targetSectors: readArrayField(formData, 'targetSectors'),
        targetProjectTypes: readArrayField(formData, 'targetProjectTypes'),
        includeKeywords: readArrayField(formData, 'includeKeywords'),
        excludeKeywords: readArrayField(formData, 'excludeKeywords'),
        qualificationCriteria: readNullableString(formData, 'qualificationCriteria'),
        disqualificationCriteria: readNullableString(formData, 'disqualificationCriteria'),
        relevanceThreshold,
        outreachInstructions: readNullableString(formData, 'outreachInstructions'),
        negativeOutreachInstructions: readNullableString(
          formData,
          'negativeOutreachInstructions',
        ),
        forbiddenPhrases: readArrayField(formData, 'forbiddenPhrases'),
        language: String(formData.get('language') ?? 'en') || 'en',
      });
      redirect(`/products/${id}?saved=1`);
    } catch (err) {
      if (err instanceof ProductProfileServiceError) {
        redirect(`/products/${id}?error=${encodeURIComponent(err.code)}`);
      }
      throw err;
    }
  }

  async function archive(): Promise<void> {
    'use server';
    const ctxInner = await getWorkspaceContext();
    await archiveProductProfile(ctxInner, id);
    redirect('/products');
  }

  async function restore(): Promise<void> {
    'use server';
    const ctxInner = await getWorkspaceContext();
    await restoreProductProfile(ctxInner, id);
    redirect(`/products/${id}`);
  }

  return (
    <>
      <BrandHeader />
      <main>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/products">Products</Link> / {profile.name}
        </p>
        <h1>{profile.name}</h1>
        {!profile.active ? <p className="badge">Archived</p> : null}

        <form action={update} className="card-form">
          <ProductFields
            profile={profile}
            formError={sp.error ?? null}
            submitLabel="Save changes"
          />
        </form>

        {canAdminWorkspace(ctx) ? (
          <section>
            <h2>Admin</h2>
            <p className="muted">
              {profile.active
                ? 'Archiving hides this profile from discovery and qualification but preserves history.'
                : 'Restoring brings this profile back into active discovery.'}
            </p>
            <form action={profile.active ? archive : restore}>
              <button type="submit" className="ghost-btn">
                {profile.active ? 'Archive' : 'Restore'}
              </button>
            </form>
          </section>
        ) : null}
      </main>
    </>
  );
}
