// Phase 25: super-admin create-workspace flow.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isNextRedirectError } from '@/lib/server-redirect';
import { eq } from 'drizzle-orm';
import { requirePlatformAdmin } from '@/lib/services/auth-context';
import {
  AdminServiceError,
  adminCreateWorkspace,
} from '@/lib/services/admin';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';
import { WorkspaceCreateForm } from '@/components/WorkspaceCreateForm';

export default async function AdminCreateWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; name?: string; slug?: string; owner?: string }>;
}) {
  await requirePlatformAdmin();
  const sp = await searchParams;

  const allUsers = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.accountStatus, 'active'))
    .orderBy(users.email);

  async function create(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
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
      if (isNextRedirectError(err)) throw err;
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
    <div className="dashboard-wrap">
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> /{' '}
        <Link href="/admin">Admin</Link> /{' '}
        <Link href="/admin/workspaces">Workspaces</Link> / New
      </p>
      <h1>Create workspace</h1>
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <WorkspaceCreateForm
        action={create}
        users={allUsers}
        initialName={sp.name ?? ''}
        initialSlug={sp.slug ?? ''}
        initialOwner={sp.owner ?? ''}
      />
    </div>
  );
}
