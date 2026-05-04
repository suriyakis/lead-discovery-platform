// Phase 31: self-service account page. Any authenticated user can view
// their profile, change their display name, change their password
// (with old-password verification), and see which workspaces they
// belong to. Email changes still go through admin.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { AppShell } from '@/components/AppShell';
import { UserAvatar } from '@/components/UserAvatar';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import {
  UserServiceError,
  changeOwnPassword,
  updateOwnProfile,
} from '@/lib/services/users';
import { listMyWorkspaces } from '@/lib/services/workspace';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/auth';

export default async function AccountSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; error?: string }>;
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

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);
  if (!userRows[0]) redirect('/');
  const me = userRows[0];

  const memberships = await listMyWorkspaces(ctx.userId);

  async function saveName(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const name = String(formData.get('name') ?? '').trim() || null;
    try {
      await updateOwnProfile(c, { name });
      redirect('/settings/account?message=Name+saved');
    } catch (err) {
      const m = err instanceof UserServiceError ? err.message : 'failed';
      redirect(`/settings/account?error=${encodeURIComponent(m)}`);
    }
  }

  async function rotatePassword(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const oldPassword = String(formData.get('oldPassword') ?? '');
    const newPassword = String(formData.get('newPassword') ?? '');
    const confirm = String(formData.get('confirm') ?? '');
    if (newPassword !== confirm) {
      redirect(
        `/settings/account?error=${encodeURIComponent('New passwords do not match')}`,
      );
    }
    try {
      await changeOwnPassword(c, oldPassword, newPassword);
      redirect('/settings/account?message=Password+changed');
    } catch (err) {
      const m = err instanceof UserServiceError ? err.message : 'failed';
      redirect(`/settings/account?error=${encodeURIComponent(m)}`);
    }
  }

  return (
    <AppShell>
      <p className="muted">
        <Link href="/dashboard">Dashboard</Link> / Account
      </p>
      <h1
        style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}
      >
        <UserAvatar name={me.name} email={me.email} />
        {me.name ?? me.email}
        <span className="badge">
          {me.passwordHash ? '🔑 password' : '🔵 google'}
        </span>
      </h1>
      <p className="muted">
        <code>{me.email}</code> · platform role <code>{me.role}</code>
        {me.lastSignedInAt
          ? ` · last sign-in ${me.lastSignedInAt.toLocaleString()}`
          : ' · never signed in'}
      </p>
      {sp.message ? <p className="form-message">{sp.message}</p> : null}
      {sp.error ? <p className="form-error">{sp.error}</p> : null}

      <section>
        <h2>Profile</h2>
        <form action={saveName} className="inline-form">
          <label>
            <span>Display name</span>
            <input
              type="text"
              name="name"
              defaultValue={me.name ?? ''}
              maxLength={120}
            />
          </label>
          <button type="submit" className="primary-btn">
            Save name
          </button>
        </form>
        <p className="muted" style={{ marginTop: '0.5rem' }}>
          Email is read-only here. Ask a super-admin to change it on{' '}
          <Link href={`/admin/users/${me.id}`}>your admin profile</Link>.
        </p>
      </section>

      <section>
        <h2>Password</h2>
        {me.passwordHash ? (
          <p className="muted">
            Change your sign-in password. Other sessions are not affected;
            only the next sign-in needs the new password.
          </p>
        ) : (
          <p className="muted">
            You sign in via Google. Setting a password here also enables
            email + password sign-in. Leave the &ldquo;current password&rdquo;
            field blank.
          </p>
        )}
        <form action={rotatePassword} className="inline-form">
          <label>
            <span>Current password</span>
            <input
              type="password"
              name="oldPassword"
              autoComplete="current-password"
              placeholder={me.passwordHash ? '' : '— leave blank'}
            />
          </label>
          <label>
            <span>New password</span>
            <input
              type="password"
              name="newPassword"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>
          <label>
            <span>Confirm new password</span>
            <input
              type="password"
              name="confirm"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>
          <button type="submit" className="primary-btn">
            {me.passwordHash ? 'Change password' : 'Set password'}
          </button>
        </form>
      </section>

      <section>
        <h2>Workspace memberships ({memberships.length})</h2>
        {memberships.length === 0 ? (
          <p className="muted">You don&apos;t belong to any workspace yet.</p>
        ) : (
          <ul className="profile-list">
            {memberships.map((m) => (
              <li key={m.workspace.id.toString()}>
                <div className="lead-row">
                  <strong>{m.workspace.name}</strong>
                  <span className="muted">/{m.workspace.slug}</span>
                  <span className="badge">{m.role}</span>
                  {m.isActive ? (
                    <span className="badge badge-good">active</span>
                  ) : null}
                  {m.workspace.isDefault ? (
                    <span className="badge">🔒 default</span>
                  ) : null}
                  {m.workspace.status === 'archived' ? (
                    <span className="badge badge-bad">archived</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
