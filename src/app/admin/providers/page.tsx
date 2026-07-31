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
import {
  AI_MODELS,
  ALLOWED_AI_PROVIDERS,
  ALLOWED_EMBEDDING_PROVIDERS,
  ALLOWED_RESEARCH_PROVIDERS,
  ALLOWED_SEARCH_PROVIDERS,
  ALLOWED_VECTOR_STORAGE_PROVIDERS,
  RESEARCH_MODELS,
  detectSystemDefaultProvider,
  type ProviderCapability,
  type ResolvedProvider,
} from '@/lib/services/provider-settings';
import { ProviderModelPair } from '@/components/ProviderModelPair';
import {
  PlatformSettingsError,
  getPlatformSettings,
  setPlatformSettings,
} from '@/lib/services/platform-settings';

/** Catalogue of platform-level provider keys the console manages. The
 *  secretKey doubles as the workspace-BYOK key name, so the resolver's
 *  workspace → platform(db) → env order applies uniformly. */
const PROVIDERS = [
  {
    secretKey: 'anthropic.apiKey',
    envVar: 'ANTHROPIC_API_KEY',
    name: 'Anthropic (Claude)',
    role: 'AI drafting, conversation review — the default AI provider.',
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
    secretKey: 'deepseek.apiKey',
    envVar: 'DEEPSEEK_API_KEY',
    name: 'DeepSeek',
    role: 'Very cost-efficient AI (deepseek-v4-flash / deepseek-v4-pro) — default for high-volume qualification.',
  },
  {
    secretKey: 'mistral.apiKey',
    envVar: 'MISTRAL_API_KEY',
    name: 'Mistral (OCR)',
    role: 'OCR for image-based / scanned PDFs — auto-selected whenever an uploaded PDF has no text layer (~$1 per 1000 pages).',
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

/** Complete capability → env-fallback map for the Health table. Rows
 *  Vendor → key-location metadata for the platform-status table. */
const VENDOR_KEY_META: Record<string, { secretKey: string; envVar: string }> = {
  anthropic: { secretKey: 'anthropic.apiKey', envVar: 'ANTHROPIC_API_KEY' },
  openai: { secretKey: 'openai.apiKey', envVar: 'OPENAI_API_KEY' },
  gemini: { secretKey: 'gemini.apiKey', envVar: 'GEMINI_API_KEY' },
  deepseek: { secretKey: 'deepseek.apiKey', envVar: 'DEEPSEEK_API_KEY' },
  mistral: { secretKey: 'mistral.apiKey', envVar: 'MISTRAL_API_KEY' },
  serpapi: { secretKey: 'serpapi.apiKey', envVar: 'SERPAPI_KEY' },
  perplexity: { secretKey: 'perplexity.apiKey', envVar: 'PERPLEXITY_API_KEY' },
};

/** Capabilities shown in the platform-status table, in display order. */
const STATUS_CAPABILITIES: ReadonlyArray<{
  cap: ProviderCapability;
  label: string;
  hasModel: boolean;
}> = [
  { cap: 'ai', label: 'AI — drafting & conversation', hasModel: true },
  { cap: 'qualification', label: 'Qualification — lead scoring', hasModel: true },
  { cap: 'research', label: 'Research — company deep-dives', hasModel: true },
  { cap: 'search', label: 'Web search — discovery', hasModel: false },
  { cap: 'embedding', label: 'Embeddings — semantic retrieval', hasModel: false },
  { cap: 'vector_storage', label: 'Vector storage', hasModel: false },
];

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
  const defaults = await getPlatformSettings();

  // What each capability EFFECTIVELY runs on platform-wide (before any
  // workspace override): console setting → env selector → auto-detect
  // (first vendor with a key — console keys count).
  const ENV_SELECTORS: Record<ProviderCapability, string | undefined> = {
    ai: process.env.AI_PROVIDER,
    embedding: process.env.EMBEDDING_PROVIDER,
    research: process.env.RESEARCH_PROVIDER,
    search: process.env.SEARCH_PROVIDER,
    vector_storage: process.env.VECTOR_STORAGE_PROVIDER,
    // No dedicated env var — qualification only has the console setting
    // and the workspace override, falling through to the general `ai`
    // provider when neither is set.
    qualification: undefined,
  };
  const effective = {} as Record<ProviderCapability, ResolvedProvider>;
  for (const cap of Object.keys(ENV_SELECTORS) as ProviderCapability[]) {
    const dbVal = defaults[`${cap}.provider`];
    const envVal = ENV_SELECTORS[cap]?.trim();
    effective[cap] = dbVal
      ? { id: dbVal, source: 'platform' }
      : envVal
        ? { id: envVal, source: 'env' }
        : await detectSystemDefaultProvider(cap);
  }
  const sourceLabel = (r: ResolvedProvider) =>
    r.source === 'platform'
      ? 'set here in the console'
      : r.source === 'env'
        ? 'server env var'
        : 'auto-detected (first vendor with a key)';


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

  async function saveDefaults(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const patch: Record<string, string | null> = {};
    for (const key of [
      'ai.provider',
      'ai.model',
      'qualification.provider',
      'qualification.model',
      'embedding.provider',
      'research.provider',
      'research.model',
      'search.provider',
      'vector_storage.provider',
    ]) {
      const raw = formData.get(key);
      if (raw === null) continue;
      const v = String(raw).trim();
      // '' / __inherit (plain selects) and __env__ / __default__
      // (ProviderModelPair tokens) all mean "clear — fall through".
      patch[key] =
        v === '' || v === '__inherit' || v === '__env__' || v === '__default__'
          ? null
          : v;
    }
    try {
      await setPlatformSettings(c, patch);
      redirect(
        `/admin/providers?msg=${encodeURIComponent('Platform defaults saved — live immediately for every workspace without its own selection.')}`,
      );
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof PlatformSettingsError ? err.message : 'save failed';
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

  // Per-vendor key check: a cheap live call with the key the cascade
  // resolves for THIS vendor — independent of which capability is
  // currently pointed at it. "Test active AI provider" alone left
  // non-active vendors (DeepSeek on qualification, Mistral on OCR,
  // search backends) undetectable until a production call failed.
  async function testVendorKey(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    if (!isSuperAdmin(c)) redirect('/dashboard');
    const secretKey = String(formData.get('secretKey') ?? '');
    const spec = PROVIDERS.find((p) => p.secretKey === secretKey);
    if (!spec) redirect('/admin/providers?err=Unknown+provider');
    try {
      const { resolveProviderKey } = await import('@/lib/services/secrets');
      const resolved = await resolveProviderKey(c, spec!.secretKey, spec!.envVar);
      if (!resolved) {
        redirect(
          `/admin/providers?err=${encodeURIComponent(`${spec!.name}: no key configured (console or env).`)}`,
        );
      }
      const key = resolved!.key;
      let ok = false;
      let detail = '';
      if (secretKey === 'anthropic.apiKey') {
        const { AnthropicAIProvider } = await import('@/lib/ai');
        const h = await new AnthropicAIProvider({ apiKey: key, model: 'claude-haiku-4-5' }).healthCheck();
        ok = h.ok;
        detail = h.detail ?? '';
      } else if (secretKey === 'openai.apiKey') {
        const { OpenAIAIProvider } = await import('@/lib/ai');
        const h = await new OpenAIAIProvider({ apiKey: key, model: 'gpt-4o-mini' }).healthCheck();
        ok = h.ok;
        detail = h.detail ?? '';
      } else if (secretKey === 'deepseek.apiKey') {
        const { DeepSeekAIProvider } = await import('@/lib/ai');
        const h = await new DeepSeekAIProvider({ apiKey: key }).healthCheck();
        ok = h.ok;
        detail = h.detail ?? '';
      } else if (secretKey === 'gemini.apiKey') {
        const { GeminiAIProvider } = await import('@/lib/ai/gemini');
        const h = await new GeminiAIProvider({ apiKey: key }).healthCheck();
        ok = h.ok;
        detail = h.detail ?? '';
      } else if (secretKey === 'mistral.apiKey') {
        // Free key validation — the models listing needs auth but bills nothing.
        const res = await fetch('https://api.mistral.ai/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        });
        ok = res.ok;
        if (!res.ok) detail = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
      } else if (secretKey === 'serpapi.apiKey') {
        const res = await fetch(
          `https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`,
        );
        ok = res.ok;
        if (!res.ok) detail = `HTTP ${res.status}`;
      } else if (secretKey === 'perplexity.apiKey') {
        const res = await fetch('https://api.perplexity.ai/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: 'sonar',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
        });
        ok = res.ok;
        if (!res.ok) detail = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
      }
      const src = resolved!.source === 'workspace' ? 'workspace BYOK' : 'console/env';
      const m = ok
        ? `${spec!.name} key OK (${src}).`
        : `${spec!.name} key FAILED (${src}) — ${detail || 'no detail'}`;
      redirect(`/admin/providers?${ok ? 'msg' : 'err'}=${encodeURIComponent(m)}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const m = err instanceof Error ? err.message : 'test failed';
      redirect(
        `/admin/providers?err=${encodeURIComponent(`${spec!.name}: ${m.slice(0, 300)}`)}`,
      );
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
                {active !== 'none' ? (
                  <form action={testVendorKey}>
                    <input type="hidden" name="secretKey" value={p.secretKey} />
                    <button
                      type="submit"
                      className="ghost-btn"
                      title="Runs a minimal live call against this vendor with the currently-resolved key"
                    >
                      Test key
                    </button>
                  </form>
                ) : null}
              </div>
            </article>
          );
        })}
      </section>

      <section>
        <h2>Platform default providers &amp; models</h2>
        <p className="muted small">
          What every workspace runs on unless it picks its own under
          Settings → Integrations — same controls as the workspace
          &ldquo;Active providers&rdquo;, but platform-wide.
          &ldquo;Automatic&rdquo; means: use the server env var if one is
          set, otherwise the first vendor that has a key (console keys
          count). Each row shows what is effectively active RIGHT NOW.
          Saved values apply immediately, no restart.
        </p>
        <form action={saveDefaults} className="form-grid" style={{ maxWidth: '46rem' }}>
          <fieldset className="provider-select">
            <legend>
              <strong>AI (drafting &amp; conversation)</strong>{' '}
              <span className="muted small">
                — running on <code>{effective.ai.id}</code> ({sourceLabel(effective.ai)})
              </span>
            </legend>
            <p className="muted small" style={{ margin: '0 0 0.5rem' }}>
              Outreach drafts, follow-ups, reply suggestions, translation —
              anything a lead actually reads. Worth spending on a stronger
              model.
            </p>
            <ProviderModelPair
              providers={ALLOWED_AI_PROVIDERS.filter((p) => p !== 'mock')}
              catalog={AI_MODELS}
              providerName="ai.provider"
              modelName="ai.model"
              initialProvider={defaults['ai.provider'] ?? null}
              initialModel={defaults['ai.model'] ?? null}
              envFallbackLabel={effective.ai.id}
              resolved={effective.ai}
              inheritLabel={`Automatic — currently ${effective.ai.id}`}
            />
          </fieldset>

          <fieldset className="provider-select">
            <legend>
              <strong>Qualification</strong>{' '}
              <span className="muted small">
                — running on <code>{effective.qualification.id}</code> ({sourceLabel(effective.qualification)})
              </span>
            </legend>
            <p className="muted small" style={{ margin: '0 0 0.5rem' }}>
              Scores every sourced lead — much higher volume than drafting.
              Kept separate from AI above so it can run on a cheaper/faster
              model without touching draft quality. Falls back to the AI
              provider above if left on Automatic and no vendor key is
              found.
            </p>
            <ProviderModelPair
              providers={ALLOWED_AI_PROVIDERS.filter((p) => p !== 'mock')}
              catalog={AI_MODELS}
              providerName="qualification.provider"
              modelName="qualification.model"
              initialProvider={defaults['qualification.provider'] ?? null}
              initialModel={defaults['qualification.model'] ?? null}
              envFallbackLabel={effective.qualification.id}
              resolved={effective.qualification}
              inheritLabel={`Automatic — currently ${effective.qualification.id}`}
            />
          </fieldset>

          <fieldset className="provider-select">
            <legend>
              <strong>Research (company deep-dives)</strong>{' '}
              <span className="muted small">
                — running on <code>{effective.research.id}</code> ({sourceLabel(effective.research)})
              </span>
            </legend>
            <ProviderModelPair
              providers={ALLOWED_RESEARCH_PROVIDERS.filter((p) => p !== 'mock')}
              catalog={RESEARCH_MODELS}
              providerName="research.provider"
              modelName="research.model"
              initialProvider={defaults['research.provider'] ?? null}
              initialModel={defaults['research.model'] ?? null}
              envFallbackLabel={effective.research.id}
              resolved={effective.research}
              inheritLabel={`Automatic — currently ${effective.research.id}`}
            />
          </fieldset>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
            {(
              [
                ['embedding.provider', 'Embeddings', ALLOWED_EMBEDDING_PROVIDERS, 'embedding'],
                ['search.provider', 'Web search', ALLOWED_SEARCH_PROVIDERS, 'search'],
                ['vector_storage.provider', 'Vector storage', ALLOWED_VECTOR_STORAGE_PROVIDERS, 'vector_storage'],
              ] as const
            ).map(([field, label, allowed, cap]) => (
              <label key={field}>
                <span>
                  {label}{' '}
                  <span className="muted small">
                    (now: <code>{effective[cap].id}</code>)
                  </span>
                </span>
                <select name={field} defaultValue={defaults[field] ?? '__inherit'}>
                  <option value="__inherit">
                    Automatic — currently {effective[cap].id}
                  </option>
                  {allowed.filter((p) => p !== 'mock').map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="action-row">
            <button type="submit" className="primary-btn">Save platform defaults</button>
          </div>
        </form>
      </section>

      <section>
        <h2>
          <ShieldCheck className="lucide" aria-hidden="true" /> Platform status
        </h2>
        <p className="muted small">
          What every capability effectively runs on RIGHT NOW, platform-wide
          (before any workspace&apos;s own override), and whether the vendor
          it resolved to has a key. Use each vendor card&apos;s
          &ldquo;Test key&rdquo; above for a live check.
        </p>
        <table className="data-table" style={{ marginTop: '0.75rem', maxWidth: '52rem' }}>
          <thead>
            <tr>
              <th>Capability</th>
              <th>Provider</th>
              <th>Model</th>
              <th>Chosen via</th>
              <th>Key</th>
            </tr>
          </thead>
          <tbody>
            {STATUS_CAPABILITIES.map(({ cap, label, hasModel }) => {
              const resolved = effective[cap];
              const model = hasModel ? defaults[`${cap}.model`] : undefined;
              const keyMeta = VENDOR_KEY_META[resolved.id];
              const keyState = !keyMeta
                ? { text: 'no key needed', ok: true }
                : storedByKey.has(keyMeta.secretKey)
                  ? { text: 'console', ok: true }
                  : process.env[keyMeta.envVar]?.trim()
                    ? { text: 'env var', ok: true }
                    : { text: 'MISSING', ok: false };
              return (
                <tr key={cap}>
                  <td>{label}</td>
                  <td><code>{resolved.id}</code></td>
                  <td>
                    {hasModel ? (
                      model ? (
                        <code>{model}</code>
                      ) : (
                        <span className="muted small">provider default</span>
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted small">{sourceLabel(resolved)}</td>
                  <td>
                    <span className={keyState.ok ? 'badge badge-good' : 'badge badge-bad'}>
                      {keyState.text}
                    </span>
                  </td>
                </tr>
              );
            })}
            {(() => {
              const keyState = storedByKey.has('mistral.apiKey')
                ? { text: 'console', ok: true }
                : process.env.MISTRAL_API_KEY?.trim()
                  ? { text: 'env var', ok: true }
                  : { text: 'MISSING', ok: false };
              return (
                <tr>
                  <td>OCR — scanned PDFs</td>
                  <td><code>mistral</code></td>
                  <td><code>{process.env.MISTRAL_OCR_MODEL?.trim() || 'mistral-ocr-latest'}</code></td>
                  <td className="muted small">
                    fixed — auto-routes whenever a PDF has no text layer
                  </td>
                  <td>
                    <span className={keyState.ok ? 'badge badge-good' : 'badge badge-bad'}>
                      {keyState.text}
                    </span>
                  </td>
                </tr>
              );
            })()}
          </tbody>
        </table>
        <form action={testAI} className="action-row" style={{ marginTop: '0.75rem' }}>
          <button type="submit" className="ghost-btn">
            Test active AI provider
          </button>
          <span className="muted small" style={{ alignSelf: 'center' }}>
            Live 1-token call with the key the AI capability resolves to.
          </span>
        </form>
        <p className="muted small">
          Resolution order everywhere: a workspace&apos;s own selection
          (Settings → Integrations) → the platform defaults saved above →
          server env vars → auto-detect (first vendor with a key).
        </p>
      </section>
    </div>
  );
}
