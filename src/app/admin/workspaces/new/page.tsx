// Phase 25: super-admin create-workspace flow.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { AppShell } from '@/components/AppShell';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { isSuperAdmin } from '@/lib/services/context';
import {
  AdminServiceError,
  adminCreateWorkspace,
} from '@/lib/services/admin';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';

export default async function AdminCreateWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; name?: string; slug?: string; owner?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }
  if (!isSuperAdmin(ctx)) {
    return (
      <AppShell>
        <h1>New workspace</h1>
        <p className="form-error">Super-admin only.</p>
      </AppShell>
    );
  }

  const allUsers = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.accountStatus, 'active'))
    .orderBy(users.email);

  async function create(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const name = String(formData.get('name') ?? '').trim();
    const slug = String(formData.get('slug') ?? '').trim().toLowerCase();
    const ownerUserId = String(formData.get('ownerUserId') ?? '');
    try {
      const ws = await adminCreateWorkspace(c, {
        name,
        slug,
        ownerUserId,
      });
      redirect(`/admin/workspaces/${ws.id}?message=Workspace+created`);
    } catch (err) {
      const m = err instanceof AdminServiceError ? err.message : 'failed';
      const params = new URLSearchParams({
        error: m,
        name,
        slug,
        owner: ownerUserId,
      });
      redirect(`/admin/workspaces/new?${params.toString()}`);
    }
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/admin">Admin</Link> /{' '}
        <Link href="/admin/workspaces">Workspaces</Link> / New
      </p>
      <h1>Create workspace</h1>
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <form action={create} className="edit-draft-form">
        <label>
          <span>Name</span>
          <input
            type="text"
            name="name"
            defaultValue={sp.name ?? ''}
            required
            maxLength={120}
          />
        </label>
        <label>
          <span>Slug</span>
          <input
            type="text"
            name="slug"
            defaultValue={sp.slug ?? ''}
            required
            maxLength={64}
            pattern="[a-z0-9][a-z0-9-]{0,62}[a-z0-9]"
            title="lowercase letters, numbers, hyphens"
            placeholder="acme-co"
          />
        </label>
        <label>
          <span>Owner</span>
          <select name="ownerUserId" defaultValue={sp.owner ?? ''} required>
            <option value="">— pick a user —</option>
            {allUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ? `${u.name} <${u.email}>` : u.email}
              </option>
            ))}
          </select>
        </label>
        <div className="action-row">
          <button type="submit" className="primary-btn">
            Create
          </button>
          <Link href="/admin/workspaces" className="ghost-btn">
            Cancel
          </Link>
        </div>
      </form>
    </AppShell>
  );
}
