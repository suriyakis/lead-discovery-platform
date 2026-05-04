import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { SettingsNav } from '@/components/SettingsNav';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { CrmServiceError, createCrmConnection } from '@/lib/services/crm';

export default async function NewCrmConnectionPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  try {
    await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/settings/crm');
    throw err;
  }

  async function create(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const system = String(formData.get('system') ?? 'csv');
    const name = String(formData.get('name') ?? '').trim();
    const credential = String(formData.get('credential') ?? '');
    const baseUrl = String(formData.get('baseUrl') ?? '').trim();
    try {
      const created = await createCrmConnection(c, {
        system,
        name,
        credential: credential || null,
        config: baseUrl ? { baseUrl } : {},
      });
      redirect(`/settings/crm/${created.id}`);
    } catch (err) {
      if (err instanceof CrmServiceError) {
        redirect(`/settings/crm/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> /{' '}
          <Link href="/settings/crm">CRM</Link> / New
        </p>
        <SettingsNav />
        <h1>New CRM connection</h1>
        {sp.error ? <p className="form-error">{sp.error}</p> : null}

        <form action={create} className="edit-draft-form">
          <label>
            <span>System</span>
            <select name="system" defaultValue="hubspot">
              <option value="hubspot">HubSpot</option>
              <option value="csv">CSV (export-only, no remote calls)</option>
            </select>
          </label>
          <label>
            <span>Display name</span>
            <input type="text" name="name" required maxLength={120} />
          </label>
          <label>
            <span>Credential / API token (HubSpot only — leave blank for CSV)</span>
            <input type="password" name="credential" autoComplete="new-password" />
          </label>
          <label>
            <span>Base URL (optional — only override for testing)</span>
            <input type="text" name="baseUrl" placeholder="https://api.hubapi.com" />
          </label>
          <div className="action-row">
            <button type="submit" className="primary-btn">
              Create
            </button>
            <Link href="/settings/crm" className="ghost-btn">
              Cancel
            </Link>
          </div>
        </form>
      </AppShell>
  );
}
