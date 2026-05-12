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
  archiveProductProfile,
  countProductProfileDependencies,
  deleteProductProfile,
  getProductProfile,
  restoreProductProfile,
  updateProductProfile,
} from '@/lib/services/product-profile';
import {
  ProductAngleSuggesterError,
  suggestStageAngle,
  type AngleStage,
  type SuggesterVendor,
} from '@/lib/services/product-angle-suggester';
import { getProductKnowledgeCoverage } from '@/lib/services/outreach-knowledge';
import { canAdminWorkspace } from '@/lib/services/context';
import { ProductFields, readArrayField, readNullableString } from '../_form';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function EditProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    saved?: string;
    autofill?: string;
    confidence?: string;
    sizes?: string;
    notes?: string;
  }>;
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
    if (isNextRedirectError(err)) throw err;
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/products');
    throw err;
  }

  let profile: Awaited<ReturnType<typeof getProductProfile>>;
  try {
    profile = await getProductProfile(ctx, id);
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
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
        discoveryAngle: readNullableString(formData, 'discoveryAngle'),
        engagementAngle: readNullableString(formData, 'engagementAngle'),
        pitchAngle: readNullableString(formData, 'pitchAngle'),
        forbiddenPhrases: readArrayField(formData, 'forbiddenPhrases'),
        language: String(formData.get('language') ?? 'en') || 'en',
        enrichDraftsWithResearch: formData.get('enrichDraftsWithResearch') === 'on',
        researchQuestionTemplate:
          String(formData.get('researchQuestionTemplate') ?? '').trim() || undefined,
      });
      redirect(`/products/${id}?saved=1`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
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

  async function suggestAngle(formData: FormData): Promise<void> {
    'use server';
    const ctxInner = await getWorkspaceContext();
    const stage = String(formData.get('stage') ?? '') as AngleStage;
    const vendor = String(formData.get('vendor') ?? 'anthropic') as SuggesterVendor;
    if (stage !== 'discovery' && stage !== 'engagement' && stage !== 'pitch') {
      redirect(`/products/${id}?error=Invalid+stage`);
    }
    if (vendor !== 'openai' && vendor !== 'anthropic') {
      redirect(`/products/${id}?error=Invalid+vendor`);
    }
    try {
      const result = await suggestStageAngle(ctxInner, id, stage, vendor);
      // Persist the suggestion straight to the matching column. The
      // operator can then edit + save via the main form normally.
      const patch: Record<string, string> = {};
      if (stage === 'discovery') patch.discoveryAngle = result.text;
      if (stage === 'engagement') patch.engagementAngle = result.text;
      if (stage === 'pitch') patch.pitchAngle = result.text;
      await updateProductProfile(ctxInner, id, patch);
      redirect(`/products/${id}?saved=1#angle-${stage}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof ProductAngleSuggesterError
          ? err.message
          : err instanceof ProductProfileServiceError
            ? err.message
            : 'failed';
      redirect(`/products/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  async function destroy(formData: FormData): Promise<void> {
    'use server';
    const ctxInner = await getWorkspaceContext();
    const confirmed = String(formData.get('confirm') ?? '').trim();
    if (confirmed !== profile.name) {
      redirect(
        `/products/${id}?error=${encodeURIComponent(`Type the product name "${profile.name}" to confirm`)}`,
      );
    }
    try {
      await deleteProductProfile(ctxInner, id);
      redirect('/products?deleted=1');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof ProductProfileServiceError ? err.message : 'failed';
      redirect(`/products/${id}?error=${encodeURIComponent(m)}`);
    }
  }

  const deps = canAdminWorkspace(ctx)
    ? await countProductProfileDependencies(ctx, id)
    : null;

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/products">Products</Link> / {profile.name}
        </p>
        <h1>{profile.name}</h1>
        {!profile.active ? <p className="badge">Archived</p> : null}

        <KnowledgeCoverageBadge
          workspaceId={ctx.workspaceId}
          productProfileId={id}
        />

        {sp.autofill === 'ok' ? (
          <div
            className={
              sp.confidence === 'low'
                ? 'form-error'
                : 'form-info'
            }
          >
            <p>
              <strong>Autofill complete</strong> · confidence:{' '}
              <code>{sp.confidence ?? 'medium'}</code>
              {sp.sizes
                ? (
                  <>
                    {' '}· extracted {sp.sizes
                      .split(',')
                      .map((s) => {
                        const [kind, len] = s.split(':');
                        return `${kind} ${len} chars`;
                      })
                      .join(', ')}
                  </>
                )
                : null}
            </p>
            {sp.notes ? (
              <p className="muted">
                <strong>AI notes:</strong> {sp.notes}
              </p>
            ) : null}
            {sp.confidence === 'low' || hasThinSource(sp.sizes) ? (
              <p>
                Low signal — likely a client-rendered SPA, paywall, or a
                scanned-image PDF the parser couldn&apos;t read. Paste a
                server-rendered marketing URL or run OCR on the PDF first.
              </p>
            ) : null}
            <p>
              Review every field below — especially target sectors and
              keywords — then activate via <em>Restore</em>.
            </p>
          </div>
        ) : null}
        {sp.saved === '1' ? <p className="form-info">Changes saved.</p> : null}

        <form action={update} className="card-form">
          <ProductFields
            profile={profile}
            formError={sp.error ?? null}
            submitLabel="Save changes"
            suggesterAction={suggestAngle}
          />
        </form>

        {canAdminWorkspace(ctx) && deps ? (
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

            <h3 style={{ marginTop: '1.5rem' }}>Delete</h3>
            {deps.qualifiedLeads + deps.qualifications + deps.outreachDrafts >
            0 ? (
              <p className="muted">
                Cannot delete — this profile is referenced by{' '}
                <strong>{deps.qualifiedLeads}</strong> qualified leads,{' '}
                <strong>{deps.qualifications}</strong> qualifications, and{' '}
                <strong>{deps.outreachDrafts}</strong> drafts. Archive instead
                so history is preserved.
              </p>
            ) : (
              <>
                <p className="muted">
                  No downstream activity references this profile — safe to
                  delete. Type the product name to confirm.
                </p>
                <form action={destroy} className="inline-form">
                  <label>
                    <span>Confirm name</span>
                    <input
                      type="text"
                      name="confirm"
                      placeholder={profile.name}
                      autoComplete="off"
                      required
                    />
                  </label>
                  <button type="submit" className="ghost-btn">
                    Permanently delete
                  </button>
                </form>
              </>
            )}
          </section>
        ) : null}
      </AppShell>
  );
}

function hasThinSource(sizes: string | undefined): boolean {
  if (!sizes) return false;
  for (const part of sizes.split(',')) {
    const [, lenStr] = part.split(':');
    const len = Number(lenStr);
    if (Number.isFinite(len) && len < 500) return true;
  }
  return false;
}

async function KnowledgeCoverageBadge({
  workspaceId,
  productProfileId,
}: {
  workspaceId: bigint;
  productProfileId: bigint;
}) {
  const coverage = await getProductKnowledgeCoverage(
    { workspaceId },
    productProfileId,
  );
  if (coverage.docs === 0 && coverage.chunks === 0) {
    return (
      <p className="muted" style={{ marginTop: '0.25rem', fontSize: '0.9em' }}>
        <span className="badge">no knowledge yet</span>{' '}
        Engagement + pitch drafts will run without RAG context. Upload
        datasheets / case studies on <Link href="/knowledge">/knowledge</Link> and
        tag them to this product to enrich those stages.
      </p>
    );
  }
  return (
    <p className="muted" style={{ marginTop: '0.25rem', fontSize: '0.9em' }}>
      <span
        className="badge"
        style={{
          background: 'oklch(0.85 0.14 145)',
          color: 'oklch(0.2 0 0)',
        }}
      >
        {coverage.docs} source{coverage.docs === 1 ? '' : 's'} · {coverage.chunks} chunk{coverage.chunks === 1 ? '' : 's'} indexed
      </span>{' '}
      — engagement + pitch composers will retrieve the top-k matching
      passages on each draft.
    </p>
  );
}
