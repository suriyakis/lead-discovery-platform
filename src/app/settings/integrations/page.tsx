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
import { getSearchProviderForCtx } from '@/lib/search';
import { getAIProviderForCtx } from '@/lib/ai';
import { getEmbeddingProviderForCtx } from '@/lib/embeddings';
import { getResearchProviderForCtx } from '@/lib/research';
import {
  ALLOWED_AI_PROVIDERS,
  ALLOWED_EMBEDDING_PROVIDERS,
  ALLOWED_RESEARCH_PROVIDERS,
  ALLOWED_SEARCH_PROVIDERS,
  ProviderSettingsError,
  getProviderSettings,
  resolveActiveProvider,
  updateProviderSettings,
  type AiProviderId,
  type EmbeddingProviderId,
  type ResearchProviderId,
  type SearchProviderId,
} from '@/lib/services/provider-settings';

const SERPAPI_SECRET_KEY = 'serpapi.apiKey';
const SERPAPI_ENV = 'SERPAPI_KEY';
const OPENAI_SECRET_KEY = 'openai.apiKey';
const OPENAI_ENV = 'OPENAI_API_KEY';
const ANTHROPIC_SECRET_KEY = 'anthropic.apiKey';
const ANTHROPIC_ENV = 'ANTHROPIC_API_KEY';
const GEMINI_SECRET_KEY = 'gemini.apiKey';
const GEMINI_ENV = 'GEMINI_API_KEY';
const PERPLEXITY_SECRET_KEY = 'perplexity.apiKey';
const PERPLEXITY_ENV = 'PERPLEXITY_API_KEY';

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    ok?: string;
    err?: string;
    tested?: string;
    provider?: string;
    detail?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const sp = await searchParams;

  let ctx;
  let workspaceHasKey = false;
  let platformHasKey = false;
  let workspaceHasOpenai = false;
  let platformHasOpenai = false;
  let workspaceHasAnthropic = false;
  let platformHasAnthropic = false;
  let workspaceHasGemini = false;
  let platformHasGemini = false;
  let workspaceHasPerplexity = false;
  let platformHasPerplexity = false;
  try {
    ctx = await getWorkspaceContext();
    workspaceHasKey = await hasSecret(ctx, SERPAPI_SECRET_KEY);
    platformHasKey = !!process.env[SERPAPI_ENV] && process.env[SERPAPI_ENV]!.trim() !== '';
    workspaceHasOpenai = await hasSecret(ctx, OPENAI_SECRET_KEY);
    platformHasOpenai =
      !!process.env[OPENAI_ENV] && process.env[OPENAI_ENV]!.trim() !== '';
    workspaceHasAnthropic = await hasSecret(ctx, ANTHROPIC_SECRET_KEY);
    platformHasAnthropic =
      !!process.env[ANTHROPIC_ENV] && process.env[ANTHROPIC_ENV]!.trim() !== '';
    workspaceHasGemini = await hasSecret(ctx, GEMINI_SECRET_KEY);
    platformHasGemini =
      !!process.env[GEMINI_ENV] && process.env[GEMINI_ENV]!.trim() !== '';
    workspaceHasPerplexity = await hasSecret(ctx, PERPLEXITY_SECRET_KEY);
    platformHasPerplexity =
      !!process.env[PERPLEXITY_ENV] && process.env[PERPLEXITY_ENV]!.trim() !== '';
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
  const openaiEffectiveSource: 'workspace' | 'platform' | 'none' = workspaceHasOpenai
    ? 'workspace'
    : platformHasOpenai
      ? 'platform'
      : 'none';
  const anthropicEffectiveSource: 'workspace' | 'platform' | 'none' = workspaceHasAnthropic
    ? 'workspace'
    : platformHasAnthropic
      ? 'platform'
      : 'none';
  const geminiEffectiveSource: 'workspace' | 'platform' | 'none' = workspaceHasGemini
    ? 'workspace'
    : platformHasGemini
      ? 'platform'
      : 'none';
  const perplexityEffectiveSource: 'workspace' | 'platform' | 'none' =
    workspaceHasPerplexity
      ? 'workspace'
      : platformHasPerplexity
        ? 'platform'
        : 'none';
  const aiProviderEnv = process.env.AI_PROVIDER ?? 'mock';
  const researchProviderEnv = process.env.RESEARCH_PROVIDER ?? 'mock';

  // Phase 45: per-workspace provider selection. Read the row + resolve
  // each capability so the UI shows both "what you've configured" and
  // "what's actually active" (which may differ when workspace is null
  // and env is set, or vice versa).
  const providerSettings = await getProviderSettings(ctx);
  const aiActive = await resolveActiveProvider(ctx, 'ai', aiProviderEnv);
  const embeddingActive = await resolveActiveProvider(
    ctx,
    'embedding',
    process.env.EMBEDDING_PROVIDER,
  );
  const researchActive = await resolveActiveProvider(
    ctx,
    'research',
    researchProviderEnv,
  );
  const searchActive = await resolveActiveProvider(
    ctx,
    'search',
    process.env.SEARCH_PROVIDER,
  );

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

  async function saveOpenai(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const value = String(formData.get('apiKey') ?? '').trim();
    try {
      await setSecret(c, OPENAI_SECRET_KEY, value);
      redirect('/settings/integrations?ok=saved&provider=openai');
    } catch (err) {
      if (err instanceof SecretsServiceError) {
        redirect(
          `/settings/integrations?err=${encodeURIComponent(err.code)}&provider=openai`,
        );
      }
      throw err;
    }
  }

  async function clearOpenai() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await deleteSecret(c, OPENAI_SECRET_KEY);
      redirect('/settings/integrations?ok=cleared&provider=openai');
    } catch (err) {
      if (err instanceof SecretsServiceError) {
        redirect(
          `/settings/integrations?err=${encodeURIComponent(err.code)}&provider=openai`,
        );
      }
      throw err;
    }
  }

  async function saveAnthropic(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const value = String(formData.get('apiKey') ?? '').trim();
    try {
      await setSecret(c, ANTHROPIC_SECRET_KEY, value);
      redirect('/settings/integrations?ok=saved&provider=anthropic');
    } catch (err) {
      if (err instanceof SecretsServiceError) {
        redirect(
          `/settings/integrations?err=${encodeURIComponent(err.code)}&provider=anthropic`,
        );
      }
      throw err;
    }
  }

  async function clearAnthropic() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await deleteSecret(c, ANTHROPIC_SECRET_KEY);
      redirect('/settings/integrations?ok=cleared&provider=anthropic');
    } catch (err) {
      if (err instanceof SecretsServiceError) {
        redirect(
          `/settings/integrations?err=${encodeURIComponent(err.code)}&provider=anthropic`,
        );
      }
      throw err;
    }
  }

  async function saveGemini(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const value = String(formData.get('apiKey') ?? '').trim();
    try {
      await setSecret(c, GEMINI_SECRET_KEY, value);
      redirect('/settings/integrations?ok=saved&provider=gemini');
    } catch (err) {
      if (err instanceof SecretsServiceError) {
        redirect(
          `/settings/integrations?err=${encodeURIComponent(err.code)}&provider=gemini`,
        );
      }
      throw err;
    }
  }

  async function clearGemini() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await deleteSecret(c, GEMINI_SECRET_KEY);
      redirect('/settings/integrations?ok=cleared&provider=gemini');
    } catch (err) {
      if (err instanceof SecretsServiceError) {
        redirect(
          `/settings/integrations?err=${encodeURIComponent(err.code)}&provider=gemini`,
        );
      }
      throw err;
    }
  }

  async function savePerplexity(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const value = String(formData.get('apiKey') ?? '').trim();
    try {
      await setSecret(c, PERPLEXITY_SECRET_KEY, value);
      redirect('/settings/integrations?ok=saved&provider=perplexity');
    } catch (err) {
      if (err instanceof SecretsServiceError) {
        redirect(
          `/settings/integrations?err=${encodeURIComponent(err.code)}&provider=perplexity`,
        );
      }
      throw err;
    }
  }

  async function saveActiveProviders(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const ai = String(formData.get('aiProvider') ?? '');
    const embedding = String(formData.get('embeddingProvider') ?? '');
    const research = String(formData.get('researchProvider') ?? '');
    const search = String(formData.get('searchProvider') ?? '');
    const aiPick = ai === '__env__' ? null : (ai as AiProviderId);
    const embeddingPick = embedding === '__env__' ? null : (embedding as EmbeddingProviderId);
    const researchPick = research === '__env__' ? null : (research as ResearchProviderId);
    const searchPick = search === '__env__' ? null : (search as SearchProviderId);
    try {
      await updateProviderSettings(c, {
        aiProvider: aiPick,
        embeddingProvider: embeddingPick,
        researchProvider: researchPick,
        searchProvider: searchPick,
      });
      redirect('/settings/integrations?ok=providers-saved');
    } catch (err) {
      if (err instanceof ProviderSettingsError) {
        redirect(`/settings/integrations?err=${encodeURIComponent(err.code)}&provider=active`);
      }
      throw err;
    }
  }

  async function clearPerplexity() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await deleteSecret(c, PERPLEXITY_SECRET_KEY);
      redirect('/settings/integrations?ok=cleared&provider=perplexity');
    } catch (err) {
      if (err instanceof SecretsServiceError) {
        redirect(
          `/settings/integrations?err=${encodeURIComponent(err.code)}&provider=perplexity`,
        );
      }
      throw err;
    }
  }

  async function testSearchConnection() {
    'use server';
    const c = await getWorkspaceContext();
    const provider = await getSearchProviderForCtx(c);
    if (provider.id === 'mock') {
      redirect('/settings/integrations?tested=mock&provider=search');
    }
    let result: { ok: boolean; detail?: string };
    try {
      result = await provider.testConnection(c);
    } catch (err) {
      result = {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    const param = result.ok ? 'ok' : 'fail';
    redirect(
      `/settings/integrations?tested=${param}&provider=search&detail=${encodeURIComponent(result.detail ?? '')}`,
    );
  }

  async function testAIConnection() {
    'use server';
    const c = await getWorkspaceContext();
    let result: { ok: boolean; detail?: string };
    try {
      const provider = await getAIProviderForCtx(c);
      if (provider.id === 'mock') {
        redirect('/settings/integrations?tested=mock&provider=ai');
      }
      result = await provider.healthCheck();
    } catch (err) {
      result = {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    const param = result.ok ? 'ok' : 'fail';
    redirect(
      `/settings/integrations?tested=${param}&provider=ai&detail=${encodeURIComponent(result.detail ?? '')}`,
    );
  }

  async function testEmbeddingConnection() {
    'use server';
    const c = await getWorkspaceContext();
    let result: { ok: boolean; detail?: string };
    try {
      const provider = await getEmbeddingProviderForCtx(c);
      if (provider.id === 'mock') {
        redirect('/settings/integrations?tested=mock&provider=embedding');
      }
      result = await provider.healthCheck();
    } catch (err) {
      result = {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    const param = result.ok ? 'ok' : 'fail';
    redirect(
      `/settings/integrations?tested=${param}&provider=embedding&detail=${encodeURIComponent(result.detail ?? '')}`,
    );
  }

  async function testResearchConnection() {
    'use server';
    const c = await getWorkspaceContext();
    let result: { ok: boolean; detail?: string };
    try {
      const provider = await getResearchProviderForCtx(c);
      if (provider.id === 'mock') {
        redirect('/settings/integrations?tested=mock&provider=research');
      }
      result = await provider.testConnection();
    } catch (err) {
      result = {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    const param = result.ok ? 'ok' : 'fail';
    redirect(
      `/settings/integrations?tested=${param}&provider=research&detail=${encodeURIComponent(result.detail ?? '')}`,
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
                : sp.ok === 'providers-saved'
                  ? 'Active providers saved.'
                  : 'Done.'}
          </p>
        ) : null}
        {sp.err ? <p className="form-error">Error: {sp.err}</p> : null}
        {sp.tested ? (
          <p className={sp.tested === 'ok' ? 'form-success' : 'form-error'}>
            <strong>
              {sp.provider
                ? `${sp.provider[0]!.toUpperCase()}${sp.provider.slice(1)} test:`
                : 'Test:'}
            </strong>{' '}
            {sp.tested === 'mock'
              ? `Active ${sp.provider ?? ''} provider is mock — no live key needed. Pick a real provider in Active providers above to test the real connection.`
              : sp.tested === 'ok'
                ? 'Connection ok.'
                : sp.detail
                  ? `Connection failed — ${sp.detail}`
                  : 'Connection failed.'}
          </p>
        ) : null}

        <section>
          <h2>Active providers</h2>
          <p className="muted">
            Pick which provider drives each capability for this workspace.
            Choose <em>inherit env default</em> to fall back to the
            platform-level setting (`AI_PROVIDER` / `RESEARCH_PROVIDER`
            / etc.). The actual API key for the chosen provider is set
            in the per-provider sections below.
          </p>
          {isAdmin ? (
            <form action={saveActiveProviders} className="active-providers-grid">
              <ProviderSelect
                label="AI provider"
                name="aiProvider"
                workspaceValue={providerSettings.aiProvider}
                envFallback={aiProviderEnv}
                resolved={aiActive}
                options={ALLOWED_AI_PROVIDERS}
              />
              <ProviderSelect
                label="Embedding provider"
                name="embeddingProvider"
                workspaceValue={providerSettings.embeddingProvider}
                envFallback={process.env.EMBEDDING_PROVIDER ?? 'mock'}
                resolved={embeddingActive}
                options={ALLOWED_EMBEDDING_PROVIDERS}
              />
              <ProviderSelect
                label="Research provider"
                name="researchProvider"
                workspaceValue={providerSettings.researchProvider}
                envFallback={researchProviderEnv}
                resolved={researchActive}
                options={ALLOWED_RESEARCH_PROVIDERS}
              />
              <ProviderSelect
                label="Search provider"
                name="searchProvider"
                workspaceValue={providerSettings.searchProvider}
                envFallback={process.env.SEARCH_PROVIDER ?? 'mock'}
                resolved={searchActive}
                options={ALLOWED_SEARCH_PROVIDERS}
              />
              <div className="action-row" style={{ gridColumn: '1 / -1' }}>
                <button type="submit" className="primary-btn">
                  Save active providers
                </button>
              </div>
            </form>
          ) : (
            <p className="muted">
              Only workspace admins and owners can change active providers.
            </p>
          )}
        </section>

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
                <form action={testSearchConnection}>
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
          <h2>OpenAI</h2>
          <p className="muted">
            Powers the embedding provider (RAG retrieval) when{' '}
            <code>EMBEDDING_PROVIDER=openai</code>. Per workspace you can
            either bring your own OpenAI key (charges go to your account)
            or use the platform default (charges go to the platform owner).
          </p>

          <dl>
            <dt>Effective key source</dt>
            <dd>
              {openaiEffectiveSource === 'workspace' ? (
                <>
                  <span className="badge badge-good">Workspace key</span>
                  <span className="muted"> — your OpenAI account is charged.</span>
                </>
              ) : openaiEffectiveSource === 'platform' ? (
                <>
                  <span className="badge">Platform default</span>
                  <span className="muted"> — platform-provided key in use.</span>
                </>
              ) : (
                <>
                  <span className="badge badge-bad">Not configured</span>
                  <span className="muted"> — embedding calls will fail with no_key.</span>
                </>
              )}
            </dd>
            <dt>Workspace key</dt>
            <dd>{workspaceHasOpenai ? <code>••• stored</code> : <code>not set</code>}</dd>
            <dt>Platform default</dt>
            <dd>
              {platformHasOpenai ? (
                <code>configured (server env)</code>
              ) : (
                <code>not configured</code>
              )}
            </dd>
          </dl>

          {isAdmin ? (
            <>
              <form action={saveOpenai} className="inline-form">
                <label>
                  <span>Set workspace OpenAI key</span>
                  <input
                    name="apiKey"
                    type="password"
                    autoComplete="new-password"
                    placeholder="sk-..."
                    minLength={1}
                    maxLength={4096}
                    required
                  />
                </label>
                <button type="submit" className="primary-btn">
                  Save
                </button>
              </form>
              <div className="action-row" style={{ marginTop: '0.5rem' }}>
                {workspaceHasOpenai ? (
                  <form action={clearOpenai}>
                    <button type="submit" className="ghost-btn">
                      Clear workspace OpenAI key
                    </button>
                  </form>
                ) : null}
                <form action={testEmbeddingConnection}>
                  <button type="submit">Test embedding key</button>
                </form>
                <form action={testAIConnection}>
                  <button type="submit">Test as AI provider</button>
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
          <h2>Anthropic</h2>
          <p className="muted">
            Powers the AI provider when{' '}
            <code>AI_PROVIDER=anthropic</code> (default model{' '}
            <code>claude-haiku-4-5</code>). Used for outreach drafts,
            qualification reasoning, reply classification, and the
            RAG-grounded reply assistant. Per workspace you can either
            bring your own Anthropic key or use the platform default.
          </p>
          <p className="muted">
            <strong>Active AI provider:</strong>{' '}
            <code>{aiActive.id}</code>{' '}
            <span className="muted small">(via {aiActive.source})</span>
            {aiActive.id === 'mock' ? (
              <>
                {' '}
                — mock returns deterministic placeholder text. Pick a
                real provider in <em>Active providers</em> at the top, or
                set <code>AI_PROVIDER</code> in the server env.
              </>
            ) : null}
          </p>

          <dl>
            <dt>Effective key source</dt>
            <dd>
              {anthropicEffectiveSource === 'workspace' ? (
                <>
                  <span className="badge badge-good">Workspace key</span>
                  <span className="muted"> — your Anthropic account is charged.</span>
                </>
              ) : anthropicEffectiveSource === 'platform' ? (
                <>
                  <span className="badge">Platform default</span>
                  <span className="muted"> — platform-provided key in use.</span>
                </>
              ) : (
                <>
                  <span className="badge badge-bad">Not configured</span>
                  <span className="muted">
                    {' '}
                    — AI calls will fail with no_key when AI_PROVIDER=anthropic.
                  </span>
                </>
              )}
            </dd>
            <dt>Workspace key</dt>
            <dd>{workspaceHasAnthropic ? <code>••• stored</code> : <code>not set</code>}</dd>
            <dt>Platform default</dt>
            <dd>
              {platformHasAnthropic ? (
                <code>configured (server env)</code>
              ) : (
                <code>not configured</code>
              )}
            </dd>
          </dl>

          {isAdmin ? (
            <>
              <form action={saveAnthropic} className="inline-form">
                <label>
                  <span>Set workspace Anthropic key</span>
                  <input
                    name="apiKey"
                    type="password"
                    autoComplete="new-password"
                    placeholder="sk-ant-..."
                    minLength={1}
                    maxLength={4096}
                    required
                  />
                </label>
                <button type="submit" className="primary-btn">
                  Save
                </button>
              </form>
              <div className="action-row" style={{ marginTop: '0.5rem' }}>
                {workspaceHasAnthropic ? (
                  <form action={clearAnthropic}>
                    <button type="submit" className="ghost-btn">
                      Clear workspace Anthropic key
                    </button>
                  </form>
                ) : null}
                <form action={testAIConnection}>
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
          <h2>Gemini (Research)</h2>
          <p className="muted">
            Powers grounded research when{' '}
            <code>RESEARCH_PROVIDER=gemini</code>. Gemini calls Google
            Search internally and returns an LLM-grounded answer with
            citations — used by the Research panel on{' '}
            <Link href="/pipeline">/pipeline/[id]</Link>. Per workspace
            you can either bring your own Gemini API key (charges go to
            your Google AI account) or use the platform default.
          </p>
          <p className="muted">
            <strong>Active research provider:</strong>{' '}
            <code>{researchActive.id}</code>{' '}
            <span className="muted small">(via {researchActive.source})</span>
            {researchActive.id === 'mock' ? (
              <>
                {' '}
                — mock returns deterministic stubs. Pick a real provider
                in <em>Active providers</em> at the top.
              </>
            ) : null}
          </p>

          <dl>
            <dt>Effective key source</dt>
            <dd>
              {geminiEffectiveSource === 'workspace' ? (
                <>
                  <span className="badge badge-good">Workspace key</span>
                  <span className="muted"> — your Google AI account is charged.</span>
                </>
              ) : geminiEffectiveSource === 'platform' ? (
                <>
                  <span className="badge">Platform default</span>
                  <span className="muted"> — platform-provided key in use.</span>
                </>
              ) : (
                <>
                  <span className="badge badge-bad">Not configured</span>
                  <span className="muted">
                    {' '}
                    — research calls will fail with no_key when
                    RESEARCH_PROVIDER=gemini.
                  </span>
                </>
              )}
            </dd>
            <dt>Workspace key</dt>
            <dd>{workspaceHasGemini ? <code>••• stored</code> : <code>not set</code>}</dd>
            <dt>Platform default</dt>
            <dd>
              {platformHasGemini ? (
                <code>configured (server env)</code>
              ) : (
                <code>not configured</code>
              )}
            </dd>
          </dl>

          {isAdmin ? (
            <>
              <form action={saveGemini} className="inline-form">
                <label>
                  <span>Set workspace Gemini key</span>
                  <input
                    name="apiKey"
                    type="password"
                    autoComplete="new-password"
                    placeholder="AIza..."
                    minLength={1}
                    maxLength={4096}
                    required
                  />
                </label>
                <button type="submit" className="primary-btn">
                  Save
                </button>
              </form>
              <div className="action-row" style={{ marginTop: '0.5rem' }}>
                {workspaceHasGemini ? (
                  <form action={clearGemini}>
                    <button type="submit" className="ghost-btn">
                      Clear workspace Gemini key
                    </button>
                  </form>
                ) : null}
                <form action={testResearchConnection}>
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
          <h2>Perplexity (Research)</h2>
          <p className="muted">
            Powers grounded research when{' '}
            <code>RESEARCH_PROVIDER=perplexity</code>. Perplexity Sonar
            returns a cited answer drawn from live web search; the Pro
            tier exposes richer citations (title + snippet). Per
            workspace you can either bring your own Perplexity API key
            or use the platform default.
          </p>

          <dl>
            <dt>Effective key source</dt>
            <dd>
              {perplexityEffectiveSource === 'workspace' ? (
                <>
                  <span className="badge badge-good">Workspace key</span>
                  <span className="muted"> — your Perplexity account is charged.</span>
                </>
              ) : perplexityEffectiveSource === 'platform' ? (
                <>
                  <span className="badge">Platform default</span>
                  <span className="muted"> — platform-provided key in use.</span>
                </>
              ) : (
                <>
                  <span className="badge badge-bad">Not configured</span>
                  <span className="muted">
                    {' '}
                    — research calls will fail with no_key when
                    RESEARCH_PROVIDER=perplexity.
                  </span>
                </>
              )}
            </dd>
            <dt>Workspace key</dt>
            <dd>{workspaceHasPerplexity ? <code>••• stored</code> : <code>not set</code>}</dd>
            <dt>Platform default</dt>
            <dd>
              {platformHasPerplexity ? (
                <code>configured (server env)</code>
              ) : (
                <code>not configured</code>
              )}
            </dd>
          </dl>

          {isAdmin ? (
            <>
              <form action={savePerplexity} className="inline-form">
                <label>
                  <span>Set workspace Perplexity key</span>
                  <input
                    name="apiKey"
                    type="password"
                    autoComplete="new-password"
                    placeholder="pplx-..."
                    minLength={1}
                    maxLength={4096}
                    required
                  />
                </label>
                <button type="submit" className="primary-btn">
                  Save
                </button>
              </form>
              <div className="action-row" style={{ marginTop: '0.5rem' }}>
                {workspaceHasPerplexity ? (
                  <form action={clearPerplexity}>
                    <button type="submit" className="ghost-btn">
                      Clear workspace Perplexity key
                    </button>
                  </form>
                ) : null}
                <form action={testResearchConnection}>
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
            Email (SMTP/IMAP), CRM (Pipedrive, Salesforce) and
            additional model providers will land here as their
            respective phases ship. The same BYOK-or-platform-default
            pattern applies.
          </p>
        </section>
      </AppShell>
  );
}

function ProviderSelect({
  label,
  name,
  workspaceValue,
  envFallback,
  resolved,
  options,
}: {
  label: string;
  name: string;
  workspaceValue: string | null;
  envFallback: string;
  resolved: { id: string; source: 'workspace' | 'env' | 'default' };
  options: ReadonlyArray<string>;
}) {
  const value = workspaceValue ?? '__env__';
  return (
    <label className="provider-select">
      <span>
        {label}{' '}
        <span className="muted small">
          (active: <code>{resolved.id}</code> via {resolved.source})
        </span>
      </span>
      <select name={name} defaultValue={value}>
        <option value="__env__">inherit env default ({envFallback})</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}
