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
  archiveProductProfile,
  batchCountProductProfileDependencies,
  deleteProductProfile,
  listProductProfiles,
  restoreProductProfile,
} from '@/lib/services/product-profile';
import { isNextRedirectError } from '@/lib/server-redirect';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string; error?: string; message?: string }>;
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

  // Pull dependency counts in one batched round-trip rather than N
  // per-row queries — three GROUP BY scans regardless of how many
  // products this workspace has.
  const isAdmin = canAdminWorkspace(ctx);
  const deletableIds = new Set<string>();
  if (isAdmin) {
    const deps = await batchCountProductProfileDependencies(
      ctx,
      profiles.map((p) => p.id),
    );
    for (const p of profiles) {
      const d = deps.get(p.id.toString());
      if (
        d &&
        d.qualifications + d.outreachDrafts + d.qualifiedLeads === 0
      ) {
        deletableIds.add(p.id.toString());
      }
    }
  }

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

  async function archive(formData: FormData): Promise<void> {
    'use server';
    const ctxInner = await getWorkspaceContext();
    const idStr = String(formData.get('id') ?? '');
    if (!/^\d+$/.test(idStr)) redirect('/products?error=Bad+id');
    try {
      await archiveProductProfile(ctxInner, BigInt(idStr));
      redirect('/products?message=Product+set+inactive');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m =
        err instanceof ProductProfileServiceError ? err.message : 'failed';
      redirect(`/products?error=${encodeURIComponent(m)}`);
    }
  }

  async function restore(formData: FormData): Promise<void> {
    'use server';
    const ctxInner = await getWorkspaceContext();
    const idStr = String(formData.get('id') ?? '');
    if (!/^\d+$/.test(idStr)) redirect('/products?error=Bad+id');
    try {
      await restoreProductProfile(ctxInner, BigInt(idStr));
      redirect('/products?message=Product+activated');
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
        {sp.message ? <p className="form-info">{sp.message}</p> : null}
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        {renderProductSection({
          title: `Active (${active.length})`,
          emptyHint:
            'No active products yet. Create one to start configuring discovery and outreach.',
          products: active,
          variant: 'active',
          isAdmin,
          deletableIds,
          destroy,
          archive,
          restore,
        })}

        {archived.length > 0
          ? renderProductSection({
              title: `Inactive (${archived.length})`,
              emptyHint: '',
              products: archived,
              variant: 'inactive',
              isAdmin,
              deletableIds,
              destroy,
              archive,
              restore,
            })
          : null}
      </AppShell>
  );
}

interface ProductCardSectionProps {
  title: string;
  emptyHint: string;
  products: ReadonlyArray<{
    id: bigint;
    name: string;
    shortDescription: string | null;
    includeKeywords: readonly string[];
    excludeKeywords: readonly string[];
    relevanceThreshold: number;
    active: boolean;
  }>;
  variant: 'active' | 'inactive';
  isAdmin: boolean;
  deletableIds: Set<string>;
  destroy: (formData: FormData) => Promise<void>;
  archive: (formData: FormData) => Promise<void>;
  restore: (formData: FormData) => Promise<void>;
}

function renderProductSection(props: ProductCardSectionProps) {
  const { title, emptyHint, products, variant, isAdmin, deletableIds, destroy, archive, restore } = props;
  return (
    <section>
      <h2>{title}</h2>
      {products.length === 0 ? (
        <p className="muted">{emptyHint}</p>
      ) : (
        <ul className="product-card-grid">
          {products.map((p) => {
            const idStr = p.id.toString();
            const isActive = variant === 'active';
            return (
              <li
                key={idStr}
                className={`product-card${isActive ? '' : ' product-card-inactive'}`}
              >
                <div className="product-card-header">
                  <Link href={`/products/${p.id}`} className="product-card-title">
                    {p.name}
                  </Link>
                  <span
                    className={`product-card-status${
                      isActive ? ' is-active' : ' is-inactive'
                    }`}
                    title={isActive ? 'Used in discovery + qualification + outreach' : 'Hidden from automation'}
                  >
                    {isActive ? '● Active' : '○ Inactive'}
                  </span>
                </div>
                {p.shortDescription ? (
                  <p className="product-card-desc">{p.shortDescription}</p>
                ) : null}
                <div className="product-card-meta">
                  <span>{p.includeKeywords.length} include</span>
                  <span>·</span>
                  <span>{p.excludeKeywords.length} exclude</span>
                  <span>·</span>
                  <span>threshold {p.relevanceThreshold}</span>
                </div>
                {isAdmin ? (
                  <div className="product-card-actions">
                    {isActive ? (
                      <form action={archive}>
                        <input type="hidden" name="id" value={idStr} />
                        <button
                          type="submit"
                          className="ghost-btn"
                          title="Set inactive — hides this product from discovery / qualification / outreach automation"
                        >
                          Set inactive
                        </button>
                      </form>
                    ) : (
                      <form action={restore}>
                        <input type="hidden" name="id" value={idStr} />
                        <button
                          type="submit"
                          className="ghost-btn"
                          title="Re-activate — product is used again by automation"
                        >
                          Activate
                        </button>
                      </form>
                    )}
                    <Link href={`/products/${p.id}`} className="ghost-btn">
                      Edit
                    </Link>
                    {deletableIds.has(idStr) ? (
                      <form action={destroy}>
                        <input type="hidden" name="id" value={idStr} />
                        <button type="submit" className="ghost-btn danger">
                          Delete
                        </button>
                      </form>
                    ) : (
                      <Link
                        href={`/products/${p.id}#delete-section`}
                        className="ghost-btn danger"
                      >
                        Delete…
                      </Link>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
