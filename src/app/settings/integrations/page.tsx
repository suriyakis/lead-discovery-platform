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
import { canAdminWorkspace } from '@/lib/services/context';
import {
  SecretsServiceError,
  deleteSecret,
  hasSecret,
  setSecret,
} from '@/lib/services/secrets';
import { getSearchProvider } from '@/lib/search';

const SERPAPI_SECRET_KEY = 'serpapi.apiKey';
const SERPAPI_ENV = 'SERPAPI_KEY';

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; err?: string; tested?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  let workspaceHasKey = false;
  let platformHasKey = false;
  try {
    ctx = await getWorkspaceContext();
    workspaceHasKey = await hasSecret(ctx, SERPAPI_SECRET_KEY);
    platformHasKey = !!process.env[SERPAPI_ENV] && process.env[SERPAPI_ENV]!.trim() !== '';
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) {
      return (
        <AppShell>
            <h1>Integrations</h1>
            <section>
              <p>You don&apos;t belong to a workspace yet.</p>
            </section>
          </AppShell>
      );
    }
    throw err;
  }

  const isAdmin = canAdminWorkspace(ctx);
  const effectiveSource: 'workspace' | 'platform' | 'none' = workspaceHasKey
    ? 'workspace'
    : platformHasKey
      ? 'platform'
      : 'none';

  // ---- server actions ----
  async function saveKey(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const value = String(formData.get('apiKey') ?? '').trim();
    try {
      await setSecret(c, SERPAPI_SECRET_KEY, value);
      redirect('/settings/integrations?ok=saved');
    } catch (err) {
      if (err instanceof SecretsServiceError) {
        redirect(`/settings/integrations?err=${encodeURIComponent(err.code)}`);
      }
      throw err;
    }
  }

  async function clearKey() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await deleteSecret(c, SERPAPI_SECRET_KEY);
      redirect('/settings/integrations?ok=cleared');
    } catch (err) {
      if (err instanceof SecretsServiceError) {
        redirect(`/settings/integrations?err=${encodeURIComponent(err.code)}`);
      }
      throw err;
    }
  }

  async function testConnection() {
    'use server';
    const c = await getWorkspaceContext();
    const provider = getSearchProvider();
    if (provider.id === 'mock') {
      redirect('/settings/integrations?tested=mock');
    }
    const result = await provider.testConnection(c);
    const param = result.ok ? 'ok' : 'fail';
    redirect(
      `/settings/integrations?tested=${param}&detail=${encodeURIComponent(result.detail ?? '')}`,
    );
  }

  return (
    <AppShell>
        <p className="muted">
          <Link href="/dashboard">Dashboard</Link> / Settings
        </p>
        <h1>Settings</h1>
        <SettingsNav />

        {sp.ok ? (
          <p className="form-success">
            {sp.ok === 'saved'
              ? 'Workspace key saved.'
              : sp.ok === 'cleared'
                ? 'Workspace key cleared.'
                : 'Done.'}
          </p>
        ) : null}
        {sp.err ? <p className="form-error">Error: {sp.err}</p> : null}
        {sp.tested ? (
          <p className={sp.tested === 'ok' ? 'form-success' : 'form-error'}>
            {sp.tested === 'mock'
              ? 'Mock search provider — no live key needed (set SEARCH_PROVIDER=serpapi to test).'
              : sp.tested === 'ok'
                ? 'Connection ok.'
                : `Connection failed.`}
          </p>
        ) : null}

        <section>
          <h2>SerpAPI</h2>
          <p className="muted">
            Powers the <code>internet_search</code> connector. Per workspace, you can either bring
            your own SerpAPI key (charges go to your account) or use the platform default
            (charges go to the platform owner).
          </p>

          <dl>
            <dt>Effective key source</dt>
            <dd>
              {effectiveSource === 'workspace' ? (
                <>
                  <span className="badge badge-good">Workspace key</span>
                  <span className="muted"> — your SerpAPI account is charged.</span>
                </>
              ) : effectiveSource === 'platform' ? (
                <>
                  <span className="badge">Platform default</span>
                  <span className="muted"> — platform-provided key in use.</span>
                </>
              ) : (
                <>
                  <span className="badge badge-bad">Not configured</span>
                  <span className="muted"> — internet_search runs will fail with no_key.</span>
                </>
              )}
            </dd>
            <dt>Workspace key</dt>
            <dd>
              {workspaceHasKey ? <code>••• stored</code> : <code>not set</code>}
            </dd>
            <dt>Platform default</dt>
            <dd>
              {platformHasKey ? (
                <code>configured (server env)</code>
              ) : (
                <code>not configured</code>
              )}
            </dd>
          </dl>

          {isAdmin ? (
            <>
              <form action={saveKey} className="inline-form">
                <label>
                  <span>Set workspace SerpAPI key</span>
                  <input
                    name="apiKey"
                    type="password"
                    autoComplete="new-password"
                    placeholder="paste your serpapi.com api key"
                    minLength={1}
                    maxLength={4096}
                    required
                  />
                </label>
                <button type="submit" className="primary-btn">
                  Save
                </button>
              </form>

              <div className="action-row">
                {workspaceHasKey ? (
                  <form action={clearKey}>
                    <button type="submit" className="ghost-btn">
                      Clear workspace key
                    </button>
                  </form>
                ) : null}
                <form action={testConnection}>
                  <button type="submit">Test connection</button>
                </form>
              </div>
            </>
          ) : (
            <p className="muted">
              Only workspace admins and owners can manage integration keys.
            </p>
          )}
        </section>

        <section>
          <h2>Future integrations</h2>
          <p className="muted">
            Email (SMTP/IMAP), CRM (HubSpot, Pipedrive), additional search providers (Gemini
            Search Grounding) and AI models will land here as their respective phases ship.
            The same BYOK-or-platform-default pattern applies.
          </p>
        </section>
      </AppShell>
  );
}
