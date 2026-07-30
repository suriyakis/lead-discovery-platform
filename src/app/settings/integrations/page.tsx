import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isNextRedirectError } from '@/lib/server-redirect';
import { AppShell } from '@/components/AppShell';
import { SettingsNav } from '@/components/SettingsNav';
import { ProviderModelPair } from '@/components/ProviderModelPair';
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
import { getVectorStorageProviderForCtx } from '@/lib/vector-storage';
import { updateWorkspaceVectorStorageQuota } from '@/lib/services/workspace';
import {
  AI_MODELS,
  ALLOWED_AI_PROVIDERS,
  ALLOWED_EMBEDDING_PROVIDERS,
  ALLOWED_VECTOR_STORAGE_PROVIDERS,
  ProviderSettingsError,
  getProviderSettings,
  resolveActiveProvider,
  systemDefaultProvider,
  updateProviderSettings,
  type AiProviderId,
  type EmbeddingProviderId,
  type ResearchProviderId,
  type SearchProviderId,
  type VectorStorageProviderId,
} from '@/lib/services/provider-settings';
import {
  OnboardingError,
  setSetupMode,
  type SetupMode,
} from '@/lib/services/onboarding';

/** Mock is a dev/test tool — never offered to customers in the UI.
 *  (It stays in the ALLOWED_* lists so tests can select it via the
 *  service layer.) */
const nonMock = (arr: ReadonlyArray<string>): ReadonlyArray<string> =>
  arr.filter((p) => p !== 'mock');

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

// P62-25: unified Web Search options + per-vendor models. SerpAPI has
// no model dropdown (the only knob is the engine, which we don't
// expose). Gemini + Perplexity use their research-model catalog.
const WEB_SEARCH_PROVIDERS = ['serpapi', 'gemini', 'perplexity'] as const;
const WEB_SEARCH_MODELS: Record<string, readonly string[]> = {
  serpapi: [],
  mock: [],
  gemini: ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  perplexity: ['sonar-pro', 'sonar', 'sonar-reasoning'],
};

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
  const aiProviderEnv =
    process.env.AI_PROVIDER ?? systemDefaultProvider('ai').id;
  const researchProviderEnv =
    process.env.RESEARCH_PROVIDER ?? systemDefaultProvider('research').id;
  const searchProviderEnvLabel =
    process.env.SEARCH_PROVIDER ?? systemDefaultProvider('search').id;

  // Phase 45: per-workspace provider selection. Read the row + resolve
  // each capability so the UI shows both "what you've configured" and
  // "what's actually active" (which may differ when workspace is null
  // and env is set, or vice versa).
  const providerSettings = await getProviderSettings(ctx);
  const aiActive = await resolveActiveProvider(ctx, 'ai', aiProviderEnv);
  // P62-11: qualification provider — falls back to the workspace's AI
  // provider when not explicitly set. The pseudo-capability isn't in
  // resolveActiveProvider's union, so compute it directly.
  const qualificationActive = providerSettings.qualificationProvider?.trim()
    ? { id: providerSettings.qualificationProvider.trim(), source: 'workspace' as const }
    : { id: aiActive.id, source: aiActive.source };

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
  const vectorStorageActive = await resolveActiveProvider(
    ctx,
    'vector_storage',
    process.env.VECTOR_STORAGE_PROVIDER,
  );

  // P62-25: unified Web Search choice. researchProvider wins (the
  // grounded-search adapter overrides the plain SERP provider when
  // both are set), else the search provider is the active backend.
  const webSearchActive: {
    id: string;
    source: 'workspace' | 'platform' | 'env' | 'default';
  } = providerSettings.researchProvider?.trim() &&
  providerSettings.researchProvider !== 'mock'
    ? { id: providerSettings.researchProvider.trim(), source: 'workspace' }
    : providerSettings.searchProvider?.trim()
      ? { id: providerSettings.searchProvider.trim(), source: 'workspace' }
      : researchActive.id !== 'mock'
        ? { id: researchActive.id, source: researchActive.source }
        : { id: searchActive.id, source: searchActive.source };
  const webSearchInitialProvider =
    (providerSettings.researchProvider?.trim() &&
      providerSettings.researchProvider !== 'mock' &&
      providerSettings.researchProvider) ||
    (providerSettings.searchProvider?.trim() && providerSettings.searchProvider) ||
    null;
  // Use research model when we're in research mode, else null.
  const webSearchInitialModel =
    providerSettings.researchProvider?.trim() &&
    providerSettings.researchProvider !== 'mock'
      ? providerSettings.researchModel
      : null;

  // Phase 50: workspace-level per-product byte cap for vector storage.
  const { getWorkspace } = await import('@/lib/services/workspace');
  const workspaceRow = await getWorkspace(ctx);
  const vectorQuotaMb = workspaceRow.vectorStorageQuotaMbPerProduct ?? 20;

  // Setup mode: 'simple' locks this page to a read-only summary of the
  // system defaults. NULL (pre-setup-mode workspaces) behaves as
  // 'advanced' so nothing legacy tenants configured gets locked away.
  const setupMode: SetupMode =
    workspaceRow.setupMode === 'simple' ? 'simple' : 'advanced';
  const isSimple = setupMode === 'simple';

  // ---- server actions ----
  async function switchSetupMode(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const mode = String(formData.get('mode') ?? '') as SetupMode;
    try {
      await setSetupMode(c, mode);
      redirect(`/settings/integrations?ok=mode-${mode}`);
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const code = err instanceof OnboardingError ? err.code : 'setup_mode_failed';
      redirect(`/settings/integrations?err=${encodeURIComponent(code)}`);
    }
  }

  async function saveKey(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const value = String(formData.get('apiKey') ?? '').trim();
    try {
      await setSecret(c, SERPAPI_SECRET_KEY, value);
      redirect('/settings/integrations?ok=saved');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
    const aiModelRaw = String(formData.get('aiModel') ?? '').trim();
    const embedding = String(formData.get('embeddingProvider') ?? '');
    // P62-25: unified Web Search card. The dropdown writes its choice
    // to webSearchProvider; we dispatch to searchProvider (serpapi /
    // mock) or researchProvider (gemini / perplexity).
    const webSearch = String(formData.get('webSearchProvider') ?? '');
    const webSearchModelRaw = String(formData.get('webSearchModel') ?? '').trim();
    const vectorStorage = String(formData.get('vectorStorageProvider') ?? '');
    const qual = String(formData.get('qualificationProvider') ?? '');
    const qualModelRaw = String(formData.get('qualificationModel') ?? '').trim();
    const aiPick = ai === '__env__' ? null : (ai as AiProviderId);
    const aiModelPick = aiModelRaw === '' || aiModelRaw === '__default__' ? null : aiModelRaw;
    const embeddingPick = embedding === '__env__' ? null : (embedding as EmbeddingProviderId);

    // Dispatch the single webSearch choice into the right column.
    let researchPick: ResearchProviderId | null = null;
    let researchModelPick: string | null = null;
    let searchPick: SearchProviderId | null = null;
    const webSearchModelClean =
      webSearchModelRaw === '' || webSearchModelRaw === '__default__'
        ? null
        : webSearchModelRaw;
    if (webSearch === '__env__') {
      // Clear both — inherit env.
    } else if (webSearch === 'serpapi' || webSearch === 'mock') {
      searchPick = webSearch as SearchProviderId;
    } else if (webSearch === 'gemini' || webSearch === 'perplexity') {
      researchPick = webSearch as ResearchProviderId;
      researchModelPick = webSearchModelClean;
    }

    const vectorStoragePick =
      vectorStorage === '__env__'
        ? null
        : (vectorStorage as VectorStorageProviderId);
    // P62-11: __env__ means "inherit the workspace's AI provider", same
    // empty-string semantic as the other dropdowns. Stored as null.
    const qualPick = qual === '__env__' ? null : (qual as AiProviderId);
    const qualModelPick =
      qualModelRaw === '' || qualModelRaw === '__default__' ? null : qualModelRaw;
    try {
      await updateProviderSettings(c, {
        aiProvider: aiPick,
        aiModel: aiModelPick,
        embeddingProvider: embeddingPick,
        researchProvider: researchPick,
        researchModel: researchModelPick,
        searchProvider: searchPick,
        vectorStorageProvider: vectorStoragePick,
        qualificationProvider: qualPick,
        qualificationModel: qualModelPick,
      });
      redirect('/settings/integrations?ok=providers-saved');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      if (err instanceof ProviderSettingsError) {
        redirect(`/settings/integrations?err=${encodeURIComponent(err.code)}&provider=active`);
      }
      throw err;
    }
  }

  async function saveVectorStorageQuota(formData: FormData) {
    'use server';
    const c = await getWorkspaceContext();
    const raw = String(formData.get('quotaMb') ?? '').trim();
    const quotaMb = Number(raw);
    try {
      await updateWorkspaceVectorStorageQuota(c, quotaMb);
      redirect('/settings/integrations?ok=quota-saved&provider=vector_storage');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      const detail = err instanceof Error ? err.message : 'invalid quota';
      redirect(
        `/settings/integrations?err=${encodeURIComponent(detail)}&provider=vector_storage`,
      );
    }
  }

  async function testVectorStorageConnection() {
    'use server';
    const c = await getWorkspaceContext();
    let result: { ok: boolean; detail?: string };
    try {
      const provider = await getVectorStorageProviderForCtx(c);
      if (provider.id === 'mock') {
        redirect('/settings/integrations?tested=mock&provider=vector_storage');
      }
      if (typeof provider.testConnection !== 'function') {
        result = { ok: true, detail: `${provider.id} has no connection check` };
      } else {
        const probe = await provider.testConnection(c);
        result = probe.ok
          ? { ok: true }
          : { ok: false, detail: probe.reason };
      }
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
      result = {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    const param = result.ok ? 'ok' : 'fail';
    redirect(
      `/settings/integrations?tested=${param}&provider=vector_storage&detail=${encodeURIComponent(result.detail ?? '')}`,
    );
  }

  async function clearPerplexity() {
    'use server';
    const c = await getWorkspaceContext();
    try {
      await deleteSecret(c, PERPLEXITY_SECRET_KEY);
      redirect('/settings/integrations?ok=cleared&provider=perplexity');
    } catch (err) {
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
      if (isNextRedirectError(err)) throw err;
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
                  : sp.ok === 'mode-simple'
                    ? 'Switched to Simple setup — the workspace now runs on the platform system defaults.'
                    : sp.ok === 'mode-advanced'
                      ? 'Switched to Advanced setup — provider selection and workspace keys are now editable.'
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
          <h2>Setup mode</h2>
          <p className="muted">
            <span className="badge">{isSimple ? 'Simple' : 'Advanced'}</span>{' '}
            {isSimple
              ? '— this workspace runs on the platform’s system API keys and default providers. Everything below is preconfigured; usage is billed from your token balance.'
              : '— system defaults apply until you override them; provider selection and workspace (BYOK) keys are editable below.'}
          </p>
          {isAdmin ? (
            <form action={switchSetupMode}>
              <input
                type="hidden"
                name="mode"
                value={isSimple ? 'advanced' : 'simple'}
              />
              <button type="submit" className="ghost-btn">
                {isSimple ? 'Switch to Advanced setup' : 'Switch to Simple setup'}
              </button>
              {!isSimple ? (
                <p className="muted small" style={{ marginTop: '0.5rem' }}>
                  Switching to Simple resets any provider overrides back to
                  the system defaults. Stored workspace API keys are kept.
                </p>
              ) : null}
            </form>
          ) : (
            <p className="muted small">
              Only workspace admins and owners can change the setup mode.
            </p>
          )}
        </section>

        {isSimple ? (
          <section>
            <h2>Active providers (system defaults)</h2>
            <p className="muted">
              What actually drives each capability right now. Nothing to
              configure — switch to Advanced setup to change providers or
              bring your own API keys (BYOK usage is token-free).
            </p>
            <dl>
              <dt>AI provider (drafts, learning, research, etc.)</dt>
              <dd>
                <code>{aiActive.id}</code>
                <span className="muted small"> — via {aiActive.source}</span>
              </dd>
              <dt>Internet Data Extraction</dt>
              <dd>
                <code>{qualificationActive.id}</code>
                <span className="muted small">
                  {' '}
                  — via {qualificationActive.source}
                </span>
              </dd>
              <dt>Web Search</dt>
              <dd>
                <code>{webSearchActive.id}</code>
                <span className="muted small"> — via {webSearchActive.source}</span>
              </dd>
              <dt>Embedding provider</dt>
              <dd>
                <code>{embeddingActive.id}</code>
                <span className="muted small"> — via {embeddingActive.source}</span>
              </dd>
              <dt>Vector storage</dt>
              <dd>
                <code>{vectorStorageActive.id}</code>
                <span className="muted small">
                  {' '}
                  — via {vectorStorageActive.source}
                </span>
              </dd>
            </dl>
            <h3>API keys in use</h3>
            <dl>
              {(
                [
                  ['OpenAI', openaiEffectiveSource],
                  ['Anthropic', anthropicEffectiveSource],
                  ['Gemini', geminiEffectiveSource],
                  ['Perplexity', perplexityEffectiveSource],
                  ['SerpAPI', effectiveSource],
                ] as const
              ).map(([vendor, source]) => (
                <div key={vendor} style={{ display: 'contents' }}>
                  <dt>{vendor}</dt>
                  <dd>
                    {source === 'workspace' ? (
                      <span className="badge badge-good">Workspace key</span>
                    ) : source === 'platform' ? (
                      <span className="badge">System key</span>
                    ) : (
                      <span className="muted small">not configured</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : (
          <>
        <section>
          <h2>Active providers</h2>
          <p className="muted">
            Pick which provider drives each capability for this workspace.
            Choose <em>inherit env default</em> to fall back to the
            platform-level setting. The actual API key for the chosen
            provider is set in the per-provider sections below.
          </p>
          <p className="muted">
            <strong>Web Search</strong> = how the Internet Search
            connector finds candidate companies. Three backends to
            choose from: SerpAPI (plain Google-style SERP), Gemini
            grounded search (LLM-with-citations), or Perplexity Sonar.
            Picking Gemini or Perplexity also enables LLM grounding for
            the per-lead research pre-pass.
          </p>
          {isAdmin ? (
            <form action={saveActiveProviders} className="active-providers-grid">
              <div className="provider-select provider-select-group">
                <span>AI provider (drafts, learning, research, etc.)</span>
                <ProviderModelPair
                  providers={nonMock(ALLOWED_AI_PROVIDERS)}
                  catalog={AI_MODELS}
                  providerName="aiProvider"
                  modelName="aiModel"
                  initialProvider={providerSettings.aiProvider}
                  initialModel={providerSettings.aiModel}
                  envFallbackLabel={aiProviderEnv}
                  resolved={aiActive}
                />
              </div>
              <div className="provider-select provider-select-group">
                <span>Internet Data Extraction</span>
                <ProviderModelPair
                  providers={nonMock(ALLOWED_AI_PROVIDERS)}
                  catalog={AI_MODELS}
                  providerName="qualificationProvider"
                  modelName="qualificationModel"
                  initialProvider={providerSettings.qualificationProvider}
                  initialModel={providerSettings.qualificationModel}
                  envFallbackLabel={`inherits AI: ${aiActive.id}`}
                  resolved={qualificationActive}
                />
              </div>
              <ProviderSelect
                label="Embedding provider"
                name="embeddingProvider"
                workspaceValue={providerSettings.embeddingProvider}
                envFallback={process.env.EMBEDDING_PROVIDER ?? 'mock'}
                resolved={embeddingActive}
                options={nonMock(ALLOWED_EMBEDDING_PROVIDERS)}
              />
              <div className="provider-select provider-select-group">
                <span>Web Search</span>
                <ProviderModelPair
                  providers={WEB_SEARCH_PROVIDERS}
                  catalog={WEB_SEARCH_MODELS}
                  providerName="webSearchProvider"
                  modelName="webSearchModel"
                  initialProvider={webSearchInitialProvider}
                  initialModel={webSearchInitialModel}
                  envFallbackLabel={`${searchProviderEnvLabel} / ${researchProviderEnv}`}
                  resolved={webSearchActive}
                />
              </div>
              <ProviderSelect
                label="Vector storage provider"
                name="vectorStorageProvider"
                workspaceValue={providerSettings.vectorStorageProvider}
                envFallback={process.env.VECTOR_STORAGE_PROVIDER ?? 'mock'}
                resolved={vectorStorageActive}
                options={nonMock(ALLOWED_VECTOR_STORAGE_PROVIDERS)}
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
          <h2>Vector Storage</h2>
          <p className="muted">
            Where product knowledge sources (PDFs, URLs, text excerpts) are
            chunked, embedded, and retrieved from for RAG-grounded outreach
            drafts. <strong>pgvector</strong> = self-hosted chunks in this
            workspace&apos;s Postgres + the Embedding provider above (cheaper,
            limited to PDF / HTML / JSON / plain text).
            <strong> openai</strong> = per-product OpenAI Vector Store via
            the Files API + <code>file_search</code> tool (OpenAI does the
            chunking, embeds, and parses PDF / DOCX / PPTX / XLSX / CSV /
            HTML / MD / TXT natively — uses your OpenAI key configured
            below).
          </p>
          <dl>
            <dt>Active vector storage</dt>
            <dd>
              <span className="badge">{vectorStorageActive.id}</span>
              <span className="muted">
                {' '}
                — via {vectorStorageActive.source === 'workspace'
                  ? 'workspace setting'
                  : vectorStorageActive.source === 'env'
                    ? 'env default'
                    : 'platform default'}
              </span>
            </dd>
            <dt>Per-product upload cap</dt>
            <dd>
              <code>{vectorQuotaMb} MB</code>
              <span className="muted">
                {' '}
                — total bytes the active provider may hold per product
                before new attaches are rejected. Default is 20 MB.
              </span>
            </dd>
          </dl>
          {isAdmin ? (
            <>
              <form action={saveVectorStorageQuota} className="inline-form">
                <label>
                  <span>Per-product cap (MB)</span>
                  <input
                    name="quotaMb"
                    type="number"
                    min={1}
                    max={4096}
                    step={1}
                    defaultValue={vectorQuotaMb}
                    required
                  />
                </label>
                <button type="submit" className="primary-btn">
                  Save cap
                </button>
              </form>
              <div className="action-row">
                <form action={testVectorStorageConnection}>
                  <button type="submit">Test connection</button>
                </form>
              </div>
            </>
          ) : (
            <p className="muted">
              Only workspace admins and owners can change the upload cap.
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
          </>
        )}
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
  nested,
}: {
  label: string;
  name: string;
  workspaceValue: string | null;
  envFallback: string;
  resolved: { id: string; source: 'workspace' | 'platform' | 'env' | 'default' };
  options: ReadonlyArray<string>;
  /** When true, render without the outer card chrome — used when this
   *  select lives inside another grouping card. */
  nested?: boolean;
}) {
  const value = workspaceValue ?? '__env__';
  return (
    <label className={nested ? 'provider-select-nested' : 'provider-select'}>
      <span>
        {label}{' '}
        <span className="muted small">
          (active: <code>{resolved.id}</code> via {resolved.source})
        </span>
      </span>
      <select name={name} defaultValue={value}>
        <option value="__env__">platform default ({envFallback})</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function ModelSelect({
  label,
  name,
  workspaceValue,
  activeProviderId,
  catalog,
  nested,
}: {
  label: string;
  name: string;
  workspaceValue: string | null;
  activeProviderId: string;
  catalog: Record<string, readonly string[]>;
  /** When true, render without the outer card chrome — used when this
   *  select lives inside another grouping card. */
  nested?: boolean;
}) {
  const models = catalog[activeProviderId] ?? [];
  const value = workspaceValue ?? '__default__';
  const wrapClass = nested ? 'provider-select-nested' : 'provider-select';
  if (models.length === 0) {
    return (
      <label className={wrapClass}>
        <span>
          {label}{' '}
          <span className="muted small">
            (provider <code>{activeProviderId}</code> has no model picker)
          </span>
        </span>
        <select name={name} disabled defaultValue="__default__">
          <option value="__default__">— not applicable —</option>
        </select>
      </label>
    );
  }
  return (
    <label className={wrapClass}>
      <span>
        {label}{' '}
        <span className="muted small">
          (for <code>{activeProviderId}</code>)
        </span>
      </span>
      <select name={name} defaultValue={value}>
        <option value="__default__">— provider default —</option>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </label>
  );
}
