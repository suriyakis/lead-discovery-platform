import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { listProductProfiles } from '@/lib/services/product-profile';

export default async function ProductsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  let profiles;
  try {
    const ctx = await getWorkspaceContext();
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

  const active = profiles.filter((p) => p.active);
  const archived = profiles.filter((p) => !p.active);

  return (
    <AppShell>
        <div className="page-header">
          <div>
            <p className="muted">
              <Link href="/dashboard">Dashboard</Link> / Products
            </p>
            <h1>Product profiles</h1>
            <p className="muted">
              Define what you sell. Discovery, qualification, and outreach all read from these.
            </p>
          </div>
          <Link href="/products/new" className="primary-btn">
            + New product
          </Link>
        </div>

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
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </AppShell>
  );
}
