import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus, Sparkles } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  ProductProfileServiceError,
  countProductProfileDependencies,
  deleteProductProfile,
  listProductProfiles,
} from '@/lib/services/product-profile';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let profiles;
  let ctx;
  try {
    ctx = await getWorkspaceContext();
    profiles = await listProductProfiles(ctx, { includeArchived: true });
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>Products</h1>
            <section>
              <p>You don&apos;t belong to a workspace yet.</p>
            </section>
          </AppShell>
      );
    }
    throw err;
  }

  // Pull dependency counts in parallel so each row knows whether
  // delete is safe (no activity) or blocked (real work would be lost).
  const isAdmin = canAdminWorkspace(ctx);
  const deletableIds = isAdmin
    ? new Set(
        (await Promise.all(
          profiles.map(async (p) => {
            const d = await countProductProfileDependencies(ctx, p.id);
            return d.qualifications + d.outreachDrafts + d.qualifiedLeads === 0
              ? p.id.toString()
              : null;
          }),
        )).filter((x): x is string => x !== null),
      )
    : new Set<string>();

  async function destroy(formData: FormData): Promise<void> {
    'use server';
    const ctxInner = await getWorkspaceContext();
    const idStr = String(formData.get('id') ?? '');
    if (!/^\d+$/.test(idStr)) {
      redirect('/products?error=Bad+id');
    }
    try {
      await deleteProductProfile(ctxInner, BigInt(idStr));
      redirect('/products?deleted=1');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof ProductProfileServiceError ? err.message : 'failed';
      redirect(`/products?error=${encodeURIComponent(m)}`);
    }
  }

  const active = profiles.filter((p) => p.active);
  const archived = profiles.filter((p) => !p.active);

  return (
    <AppShell>
        <div className="page-header">
          <div className="page-intro">
            <p className="page-eyebrow">Catalog</p>
            <h1 className="page-title">Product profiles</h1>
            <p className="page-lede">
              Define what you sell. Discovery, qualification, and outreach
              all read from these.
            </p>
          </div>
          <div className="action-row">
            <Link href="/products/autofill" className="primary-btn">
              <Sparkles className="primary-btn-icon" aria-hidden="true" />
              <span>Autofill from URL / PDFs</span>
            </Link>
            <Link href="/products/new" className="ghost-btn">
              <Plus className="primary-btn-icon" aria-hidden="true" />
              <span>New product (manual)</span>
            </Link>
          </div>
        </div>

        {sp.deleted === '1' ? (
          <p className="form-info">Product deleted.</p>
        ) : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <section>
          <h2>Active ({active.length})</h2>
          {active.length === 0 ? (
            <p className="muted">
              No active products yet. Create one to start configuring discovery and outreach.
            </p>
          ) : (
            <ul className="profile-list">
              {active.map((p) => (
                <li key={p.id.toString()}>
                  <Link href={`/products/${p.id}`}>{p.name}</Link>
                  {p.shortDescription ? (
                    <p className="muted">{p.shortDescription}</p>
                  ) : null}
                  <div className="meta">
                    <span>
                      {p.includeKeywords.length} include · {p.excludeKeywords.length} exclude
                    </span>
                    <span>threshold {p.relevanceThreshold}</span>
                  </div>
                  {isAdmin && deletableIds.has(p.id.toString()) ? (
                    <form action={destroy} style={{ marginTop: '0.5rem' }}>
                      <input type="hidden" name="id" value={p.id.toString()} />
                      <button type="submit" className="ghost-btn">
                        Delete
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {archived.length > 0 ? (
          <section>
            <h2>Archived ({archived.length})</h2>
            <ul className="profile-list">
              {archived.map((p) => (
                <li key={p.id.toString()} className="archived">
                  <Link href={`/products/${p.id}`}>{p.name}</Link>
                  {p.shortDescription ? <p className="muted">{p.shortDescription}</p> : null}
                  {isAdmin && deletableIds.has(p.id.toString()) ? (
                    <form action={destroy} style={{ marginTop: '0.5rem' }}>
                      <input type="hidden" name="id" value={p.id.toString()} />
                      <button type="submit" className="ghost-btn">
                        Delete
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </AppShell>
  );
}
