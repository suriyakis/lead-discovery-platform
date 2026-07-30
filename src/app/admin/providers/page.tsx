import { redirect } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { auth } from '@/lib/auth';
import {
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { isSuperAdmin } from '@/lib/services/context';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  SecretsServiceError,
  deletePlatformSecret,
  listPlatformSecretKeys,
  setPlatformSecret,
} from '@/lib/services/secrets';
import { getAIProviderForCtx } from '@/lib/ai';

/** Catalogue of platform-level provider keys the console manages. The
 *  secretKey doubles as the workspace-BYOK key name, so the resolver's
 *  workspace → platform(db) → env order applies uniformly. */
const PROVIDERS = [
  {
    secretKey: 'anthropic.apiKey',
    envVar: 'ANTHROPIC_API_KEY',
    name: 'Anthropic (Claude)',
    role: 'AI drafting, qualification, conversation review — the default AI provider.',
  },
  {
    secretKey: 'openai.apiKey',
    envVar: 'OPENAI_API_KEY',
    name: 'OpenAI',
    role: 'Embeddings (semantic search over knowledge + lessons); optional AI provider.',
  },
  {
    secretKey: 'gemini.apiKey',
    envVar: 'GEMINI_API_KEY',
    name: 'Google Gemini',
    role: 'Grounded web search — the engine behind lead discovery — and research.',
  },
  {
    secretKey: 'serpapi.apiKey',
    envVar: 'SERPAPI_KEY',
    name: 'SerpAPI',
    role: 'Alternative web-search backend (optional).',
  },
  {
    secretKey: 'perplexity.apiKey',
    envVar: 'PERPLEXITY_API_KEY',
    name: 'Perplexity',
    role: 'Alternative research backend (optional).',
  },
] as const;

const ENV_DEFAULTS = [
  ['AI_PROVIDER', process.env.AI_PROVIDER],
  ['EMBEDDING_PROVIDER', process.env.EMBEDDING_PROVIDER],
  ['SEARCH_PROVIDER', process.env.SEARCH_PROVIDER],
  ['RESEARCH_PROVIDER', process.env.RESEARCH_PROVIDER],
] as const;

export default async function AdminProvidersPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  try {
    ctx = await getWorkspaceContext();
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof NoWorkspaceError) redirect('/');
    throw err;
  }
  if (!isSuperAdmin(ctx)) redirect('/dashboard');

  const stored = await listPlatformSecretKeys(ctx);
  const storedByKey = new Map(stored.map((s) => [s.key, s]));

  async function saveKey(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const secretKey = String(formData.get('secretKey') ?? '');
    const value = String(formData.get('value') ?? '');
    if (!PROVIDERS.some((p) => p.secretKey === secretKey)) {
      redirect('/admin/providers?err=Unknown+provider');
    }
    try {
      await setPlatformSecret(c, secretKey, value);
      redirect(
        `/admin/providers?msg=${encodeURIComponent(`${secretKey} saved — active immediately for every workspace without its own key.`)}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof SecretsServiceError ? err.message : 'save failed';
      redirect(`/admin/providers?err=${encodeURIComponent(m)}`);
    }
  }

  async function removeKey(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const secretKey = String(formData.get('secretKey') ?? '');
    if (!PROVIDERS.some((p) => p.secretKey === secretKey)) {
      redirect('/admin/providers?err=Unknown+provider');
    }
    try {
      await deletePlatformSecret(c, secretKey);
      redirect(
        `/admin/providers?msg=${encodeURIComponent(`${secretKey} removed. The env-var fallback (if any) applies again.`)}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof SecretsServiceError ? err.message : 'delete failed';
      redirect(`/admin/providers?err=${encodeURIComponent(m)}`);
    }
  }

  async function testAI() {
    'use server';
    const c = await getWorkspaceContext();
    if (!isSuperAdmin(c)) redirect('/dashboard');
    try {
      const provider = await getAIProviderForCtx(c, 'ai.generate');
      const health = await provider.healthCheck();
      const m = health.ok
        ? `AI provider OK: ${provider.id} (${provider.model})`
        : `AI provider FAILED: ${provider.id} — ${health.detail ?? 'no detail'}`;
      redirect(`/admin/providers?${health.ok ? 'msg' : 'err'}=${encodeURIComponent(m)}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'test failed';
      redirect(`/admin/providers?err=${encodeURIComponent(m)}`);
    }
  }

  return (
    <div className="dashboard-wrap">
      <header className="page-intro">
        <p className="page-eyebrow">Platform console</p>
        <h1 className="page-title">
          <KeyRound className="lucide" aria-hidden="true" /> Providers
        </h1>
        <p className="page-lede">
          Platform-wide API keys — what every workspace runs on unless it
          brings its own key (BYOK) under Settings → Integrations. Keys are
          stored AES-256-GCM encrypted, never displayed after saving, and
          take effect immediately without a restart. Resolution order:
          workspace BYOK → console key → server env var.
        </p>
      </header>

      {sp.msg ? <p className="form-info">{sp.msg}</p> : null}
      {sp.err ? <p className="form-error">{sp.err}</p> : null}

      <section>
        {PROVIDERS.map((p) => {
          const row = storedByKey.get(p.secretKey);
          const envSet = Boolean(process.env[p.envVar]?.trim());
          const active = row ? 'console key' : envSet ? 'env var' : 'none';
          return (
            <article key={p.secretKey} className="provider-select" style={{ marginBottom: '0.85rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div>
                  <strong>{p.name}</strong>{' '}
                  <code className="muted small">{p.secretKey}</code>
                  <p className="muted small" style={{ margin: '0.2rem 0 0' }}>{p.role}</p>
                </div>
                <div className="meta">
                  <span
                    className={
                      active === 'none' ? 'badge badge-bad' : 'badge badge-good'
                    }
                    title={`Env var ${p.envVar}: ${envSet ? 'set' : 'not set'}`}
                  >
                    active: {active}
                  </span>
                  {row ? (
                    <span className="muted small">
                      saved {row.updatedAt.toLocaleString()}
                    </span>
                  ) : null}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <form action={saveKey} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <input type="hidden" name="secretKey" value={p.secretKey} />
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <span className="muted small">
                      {row ? 'Replace key' : 'Set key'}
                    </span>
                    <input
                      name="value"
                      type="password"
                      autoComplete="off"
                      placeholder="paste API key"
                      style={{ minWidth: '20rem' }}
                      required
                    />
                  </label>
                  <button type="submit" className="primary-btn">Save</button>
                </form>
                {row ? (
                  <form action={removeKey}>
                    <input type="hidden" name="secretKey" value={p.secretKey} />
                    <button type="submit" className="ghost-btn">Remove console key</button>
                  </form>
                ) : null}
              </div>
            </article>
          );
        })}
      </section>

      <section>
        <h2>
          <ShieldCheck className="lucide" aria-hidden="true" /> Health & defaults
        </h2>
        <form action={testAI} className="action-row">
          <button type="submit" className="ghost-btn">
            Test active AI provider
          </button>
          <span className="muted small" style={{ alignSelf: 'center' }}>
            Runs a live health check with the currently-resolved key.
          </span>
        </form>
        <table className="data-table" style={{ marginTop: '0.75rem', maxWidth: '32rem' }}>
          <thead>
            <tr>
              <th>Env default</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {ENV_DEFAULTS.map(([k, v]) => (
              <tr key={k}>
                <td><code>{k}</code></td>
                <td>{v?.trim() ? <code>{v}</code> : <span className="muted">unset</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Env defaults pick WHICH provider runs each function; the keys above
          authenticate it. A workspace can override providers per-function
          under its own Settings → Integrations.
        </p>
      </section>
    </div>
  );
}
