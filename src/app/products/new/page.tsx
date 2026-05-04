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
  ProductProfileServiceError,
  createProductProfile,
} from '@/lib/services/product-profile';
import { ProductFields, readArrayField, readNullableString } from '../_form';

export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  async function create(formData: FormData): Promise<void> {
    'use server';
    let ctx;
    try {
      ctx = await getWorkspaceContext();
    } catch (err) {
      if (err instanceof AuthRequiredError) redirect('/');
      if (err instanceof NoWorkspaceError) redirect('/products?err=no-workspace');
      throw err;
    }

    const name = String(formData.get('name') ?? '').trim();
    const relevanceThresholdRaw = formData.get('relevanceThreshold');
    const relevanceThreshold =
      typeof relevanceThresholdRaw === 'string' && relevanceThresholdRaw !== ''
        ? Number(relevanceThresholdRaw)
        : 50;

    try {
      const profile = await createProductProfile(ctx, {
        name,
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
      redirect(`/products/${profile.id}`);
    } catch (err) {
      if (err instanceof ProductProfileServiceError) {
        redirect(`/products/new?error=${encodeURIComponent(err.code)}`);
      }
      throw err;
    }
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/products">Products</Link> / New
        </p>
        <h1>New product profile</h1>
        <form action={create} className="card-form">
          <ProductFields formError={sp.error ?? null} submitLabel="Create" />
        </form>
      </AppShell>
  );
}
