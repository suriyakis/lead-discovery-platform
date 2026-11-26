import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isNextRedirectError } from '@/lib/server-redirect';
import { ProviderModelPair } from '@/components/ProviderModelPair';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { clearWorkspaceKeyConfirm, switchToSimpleSetupConfirm } from '@/lib/confirm-copy';
import { auth } from '@/lib/auth';
import {
  AccountInactiveError,
  AuthRequiredError,
  NoWorkspaceError,
  getWorkspaceContext,
} from '@/lib/services/auth-context';
import { canAdminWorkspace } from '@/lib/services/context';
import {
  SecretsServiceError,
  deleteSecret,
  setSecret,
} from '@/lib/services/secrets';
import {
  getProviderReadiness,
  vendorKeyGap,
  type ProviderReadiness,
  type VendorKeyStatus,
} from '@/lib/services/provider-readiness';
import {
  KeyChoiceIntro,
  KeySourceLine,
  ProviderReadinessPanel,
  vendorUseSentence,
} from '@/components/ProviderReadinessPanel';
import { Badge, StatusBadge } from '@/components/Badge';
import { PlanLimitError, getEffectivePlan } from '@/lib/services/plan-limits';
import { BRAND_NAME } from '@/lib/brand';
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
  resolvePlatformProvider,
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
import { NoWorkspaceState } from '@/components/NoWorkspaceState';

/** Mock is a dev/test tool — never offered to customers in the UI.
 *  (It stays in the ALLOWED_* lists so tests can select it via the
 *  service layer.) */
const nonMock = (arr: ReadonlyArray<string>): ReadonlyArray<string> =>
  arr.filter((p) => p !== 'mock');

const SERPAPI_SECRET_KEY = 'serpapi.apiKey';
const OPENAI_SECRET_KEY = 'openai.apiKey';
const ANTHROPIC_SECRET_KEY = 'anthropic.apiKey';
const GEMINI_SECRET_KEY = 'gemini.apiKey';
const PERPLEXITY_SECRET_KEY = 'perplexity.apiKey';

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
  let readiness: ProviderReadiness;
  try {
    ctx = await getWorkspaceContext();
    // The key picture comes from the runtime's own cascade (workspace
    // BYOK → the platform key saved in the admin console → the server env
    // var). Asking only the env here made every vendor read "not
    // configured" while the console keys were in use (26 Nov).
    readiness = await getProviderReadiness(ctx);
  } catch (err) {
    if (err instanceof AuthRequiredError) redirect('/');
    if (err instanceof AccountInactiveError) redirect('/pending');
    if (err instanceof NoWorkspaceError) return <NoWorkspaceState />;
    throw err;
  }

  const isAdmin = canAdminWorkspace(ctx);
  const vendorStatus = (vendor: string): VendorKeyStatus => {
    const found = readiness.vendors.find((v) => v.vendor === vendor);
    if (!found) throw new Error(`provider key catalogue has no ${vendor}`);
    return found;
  };
  const serpapi = vendorStatus('serpapi');
  const openai = vendorStatus('openai');
  const anthropic = vendorStatus('anthropic');
  const gemini = vendorStatus('gemini');
  const perplexity = vendorStatus('perplexity');
  const workspaceHasKey = serpapi.workspaceKey;
  const platformHasKey = serpapi.platformKey;
  const workspaceHasOpenai = openai.workspaceKey;
  const platformHasOpenai = openai.platformKey;
  const workspaceHasAnthropic = anthropic.workspaceKey;
  const platformHasAnthropic = anthropic.platformKey;
  const workspaceHasGemini = gemini.workspaceKey;
  const platformHasGemini = gemini.platformKey;
  const workspaceHasPerplexity = perplexity.workspaceKey;
  const platformHasPerplexity = perplexity.platformKey;
  /** Saved BYOK keys still win in Simple setup (setSetupMode keeps them). */
  const ownKeyVendors = readiness.vendors.filter((v) => v.workspaceKey);
  // BYOK is a plan feature (setSecret → assertByokAllowed): never send a
  // workspace whose plan forbids it to add its own key. The set-key forms,
  // the section intros and the setup-mode copy all follow this; the
  // PlanLimitError catches in the save actions stay as the backstop.
  const { limits: planLimits } = await getEffectivePlan(ctx);
  const byokAllowed = planLimits.byok;
  const keyLineProps = { readiness, isAdmin, byokAllowed };
  const introProps = { readiness, byokAllowed };

  // Phase 45: per-workspace provider selection. Read the row + resolve
  // each capability so the UI shows both "what you've configured" and
  // "what's actually active" (which may differ when workspace is null
  // and env is set, or vice versa). Each cascade gets the raw env var, as
  // its factory does, so auto-detect also sees the console's keys; the
  // "platform default" labels are the platform tier of the same cascade.
  const providerSettings = await getProviderSettings(ctx);
  const aiActive = await resolveActiveProvider(ctx, 'ai', process.env.AI_PROVIDER);
  const aiPlatform = await resolvePlatformProvider('ai', process.env.AI_PROVIDER);
  // P62-11: qualification is its own capability — the same cascade
  // getQualificationProviderForCtx runs (workspace → the console's
  // qualification default → auto-detect, cheapest first). It does NOT
  // inherit the AI provider; showing that it did hid the real vendor.
  const qualificationActive = await resolveActiveProvider(ctx, 'qualification', undefined);
  const qualificationPlatform = await resolvePlatformProvider('qualification', undefined);

  const embeddingActive = await resolveActiveProvider(
    ctx,
    'embedding',
    process.env.EMBEDDING_PROVIDER,
  );
  const embeddingPlatform = await resolvePlatformProvider(
    'embedding',
    process.env.EMBEDDING_PROVIDER,
  );
  const researchActive = await resolveActiveProvider(
    ctx,
    'research',
    process.env.RESEARCH_PROVIDER,
  );
  const vectorStorageActive = await resolveActiveProvider(
    ctx,
    'vector_storage',
    process.env.VECTOR_STORAGE_PROVIDER,
  );
  const vectorStoragePlatform = await resolvePlatformProvider(
    'vector_storage',
    process.env.VECTOR_STORAGE_PROVIDER,
  );

  // P62-25: unified Web Search choice — what discovery really runs on
  // (getWebSearchProviderForCtx, as the readiness panel reports it): the
  // workspace's grounding choice when its key exists, else its search
  // choice, else the platform tier with the Gemini safety net.
  const webSearchActive = readiness.discoveryChoice;
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
      // BYOK is a plan feature: say so instead of failing the action.
      if (err instanceof PlanLimitError) {
        redirect(`/settings/integrations?err=${encodeURIComponent(err.message)}`);
      }
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
      if (err instanceof PlanLimitError) {
        redirect(`/settings/integrations?err=${encodeURIComponent(err.message)}&provider=openai`);
      }
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
      if (err instanceof PlanLimitError) {
        redirect(`/settings/integrations?err=${encodeURIComponent(err.message)}&provider=anthropic`);
      }
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
      if (err instanceof PlanLimitError) {
        redirect(`/settings/integrations?err=${encodeURIComponent(err.message)}&provider=gemini`);
      }
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
      if (err instanceof PlanLimitError) {
        redirect(
          `/settings/integrations?err=${encodeURIComponent(err.message)}&provider=perplexity`,
        );
      }
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
    <>
        <p className="muted">
          <Link href="/today">Today</Link> / Settings
        </p>
        <h1>Settings</h1>

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
                      ? byokAllowed
                        ? 'Switched to Advanced setup — provider selection and workspace keys are now editable.'
                        : 'Switched to Advanced setup — provider selection is now editable. Your own keys need the Pro plan.'
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

        <ProviderReadinessPanel
          readiness={readiness}
          simple={isSimple}
          isAdmin={isAdmin}
          byokAllowed={byokAllowed}
        />

        <section>
          <h2>Setup mode</h2>
          <p className="muted">
            <Badge>{isSimple ? 'Simple' : 'Advanced'}</Badge>{' '}
            {isSimple
              ? ownKeyVendors.length > 0
                ? `— this workspace runs on the platform’s default providers and ${BRAND_NAME}’s keys, except where it saved its own key (${ownKeyVendors.map((v) => v.name).join(', ')}), which still takes precedence. The jobs above show whose key each one uses and how it is paid.`
                : `— this workspace runs on the platform’s default providers and ${BRAND_NAME}’s keys; there is nothing to configure. The jobs above show how each one is paid.`
              : byokAllowed
                ? '— system defaults apply until you override them; provider selection and workspace (BYOK) keys are editable below.'
                : '— system defaults apply until you override them; provider selection is editable below. Your own keys need the Pro plan.'}
          </p>
          {isAdmin ? (
            <form action={switchSetupMode}>
              <input
                type="hidden"
                name="mode"
                value={isSimple ? 'advanced' : 'simple'}
              />
              {/* Only Simple asks first: it wipes the provider choices below. */}
              <ConfirmFormButton
                className="ghost-btn"
                messageByValue={{
                  field: 'mode',
                  messages: { simple: switchToSimpleSetupConfirm(workspaceRow) },
                }}
              >
                {isSimple ? 'Switch to Advanced setup' : 'Switch to Simple setup'}
              </ConfirmFormButton>
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
            <h2>API keys by provider</h2>
            <p className="muted">
              {ownKeyVendors.length > 0 ? (
                <>
                  Simple setup uses {BRAND_NAME}&apos;s platform keys, except
                  where this workspace saved its own key (marked “Your key”
                  below): that key still takes precedence, and its provider
                  bills your account, not your tokens. Switch to Advanced
                  setup to remove it{byokAllowed ? ', choose providers or add keys' : ' or choose providers'}.
                </>
              ) : (
                <>
                  Simple setup runs on {BRAND_NAME}&apos;s platform keys — there
                  is nothing to configure. Switch to Advanced setup to choose
                  providers{byokAllowed ? ' or bring your own keys (calls on your own key are billed by that provider, not from your tokens)' : ''}.
                </>
              )}
            </p>
            {/* Each line comes from the job rows above (never the admin
                console's catalogue text): what the key is used for now,
                or what its absence stops or limits. */}
            <dl>
              {readiness.vendors.map((v) => {
                const gap = vendorKeyGap(readiness, v.vendor);
                const line = vendorUseSentence(readiness, v.vendor);
                return (
                  <div key={v.vendor} style={{ display: 'contents' }} data-vendor={v.vendor}>
                    <dt>{v.name}</dt>
                    <dd>
                      {gap ? (
                        <StatusBadge set="provider_key_gap" value={gap.gap} />
                      ) : (
                        <StatusBadge set="usage_key_source" value={v.effective} />
                      )}
                      {line ? <span className="muted small"> {line}</span> : null}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ) : (
          <>
        <section>
          <h2>Active providers</h2>
          <p className="muted">
            Pick which provider drives each capability for this workspace.
            Choose <em>platform default (…)</em> to fall back to the
            platform-level setting.{' '}
            {byokAllowed
              ? 'A workspace key for the chosen provider is set in its section below; without one it runs on the platform key.'
              : 'Each provider section below says whose key it runs on; adding your own keys needs the Pro plan.'}
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
                <span>AI provider (follow-ups, suggested replies, translation, learning, etc.)</span>
                <ProviderModelPair
                  providers={nonMock(ALLOWED_AI_PROVIDERS)}
                  catalog={AI_MODELS}
                  providerName="aiProvider"
                  modelName="aiModel"
                  initialProvider={providerSettings.aiProvider}
                  initialModel={providerSettings.aiModel}
                  envFallbackLabel={aiPlatform.id}
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
                  envFallbackLabel={qualificationPlatform.id}
                  resolved={qualificationActive}
                />
              </div>
              <ProviderSelect
                label="Embedding provider"
                name="embeddingProvider"
                workspaceValue={providerSettings.embeddingProvider}
                envFallback={embeddingPlatform.id}
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
                  envFallbackLabel={readiness.discoveryPlatformDefault}
                  resolved={webSearchActive}
                />
              </div>
              <ProviderSelect
                label="Vector storage provider"
                name="vectorStorageProvider"
                workspaceValue={providerSettings.vectorStorageProvider}
                envFallback={vectorStoragePlatform.id}
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
            HTML / MD / TXT natively — it runs on the OpenAI key; see the
            OpenAI section below). Both need an OpenAI key.
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
            Plain Google-style web search for discovery (the{' '}
            <code>internet_search</code> connector), when it is chosen under Web Search or is
            the platform default.{' '}
            <KeyChoiceIntro vendor="serpapi" noun="SerpAPI" biller="SerpAPI" {...introProps} />
          </p>

          <dl>
            <dt>Effective key source</dt>
            <dd>
              <KeySourceLine vendor="serpapi" {...keyLineProps} />
            </dd>
            <dt>Workspace key</dt>
            <dd>
              {workspaceHasKey ? <code>••• stored</code> : <code>not set</code>}
            </dd>
            <dt>Platform key</dt>
            <dd>
              {platformHasKey ? (
                <code>provided by {BRAND_NAME}</code>
              ) : (
                <code>none — the platform has no key for this provider</code>
              )}
            </dd>
          </dl>

          {isAdmin ? (
            <>
              {byokAllowed ? (
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
              ) : (
                <OwnKeysNeedPro />
              )}

              <div className="action-row">
                {workspaceHasKey ? (
                  <form action={clearKey}>
                    <ConfirmFormButton
                      className="ghost-btn"
                      message={clearWorkspaceKeyConfirm({
                        vendorName: 'SerpAPI',
                        workspaceName: workspaceRow.name,
                        workspaceSlug: workspaceRow.slug,
                      })}
                    >
                      Clear workspace key
                    </ConfirmFormButton>
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
            Writes first emails, closing notes and referral introductions
            (<code>gpt-5-nano</code>) whenever an OpenAI key is available, and
            powers the embeddings for knowledge retrieval. Suggest with AI on
            products uses it when GPT-5 is picked.{' '}
            <KeyChoiceIntro vendor="openai" noun="OpenAI" biller="OpenAI" {...introProps} />
          </p>

          <dl>
            <dt>Effective key source</dt>
            <dd>
              <KeySourceLine vendor="openai" {...keyLineProps} />
            </dd>
            <dt>Workspace key</dt>
            <dd>{workspaceHasOpenai ? <code>••• stored</code> : <code>not set</code>}</dd>
            <dt>Platform key</dt>
            <dd>
              {platformHasOpenai ? (
                <code>provided by {BRAND_NAME}</code>
              ) : (
                <code>none — the platform has no key for this provider</code>
              )}
            </dd>
          </dl>

          {isAdmin ? (
            <>
              {byokAllowed ? (
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
              ) : (
                <OwnKeysNeedPro />
              )}
              <div className="action-row" style={{ marginTop: '0.5rem' }}>
                {workspaceHasOpenai ? (
                  <form action={clearOpenai}>
                    <ConfirmFormButton
                      className="ghost-btn"
                      message={clearWorkspaceKeyConfirm({
                        vendorName: 'OpenAI',
                        workspaceName: workspaceRow.name,
                        workspaceSlug: workspaceRow.slug,
                      })}
                    >
                      Clear workspace OpenAI key
                    </ConfirmFormButton>
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
            Writes the pitch and the replies to leads{' '}
            (<code>claude-opus-4-7</code>) whenever an Anthropic key is
            available. It also does the other AI writing (follow-ups, the
            reply assistant) when it is the active AI provider, and scores
            companies when it is the qualification provider. Suggest with AI
            on products uses it when Opus 4.7 is picked.{' '}
            <KeyChoiceIntro vendor="anthropic" noun="Anthropic" biller="Anthropic" {...introProps} />
          </p>
          <p className="muted">
            <strong>Active AI provider:</strong>{' '}
            <code>{aiActive.id}</code>{' '}
            <span className="muted small">(via {aiActive.source})</span>
            {aiActive.id === 'mock' ? (
              <>
                {' '}
                — mock returns deterministic placeholder text. Pick a
                real provider in <em>Active providers</em> at the top.
              </>
            ) : null}
          </p>

          <dl>
            <dt>Effective key source</dt>
            <dd>
              <KeySourceLine vendor="anthropic" {...keyLineProps} />
            </dd>
            <dt>Workspace key</dt>
            <dd>{workspaceHasAnthropic ? <code>••• stored</code> : <code>not set</code>}</dd>
            <dt>Platform key</dt>
            <dd>
              {platformHasAnthropic ? (
                <code>provided by {BRAND_NAME}</code>
              ) : (
                <code>none — the platform has no key for this provider</code>
              )}
            </dd>
          </dl>

          {isAdmin ? (
            <>
              {byokAllowed ? (
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
              ) : (
                <OwnKeysNeedPro />
              )}
              <div className="action-row" style={{ marginTop: '0.5rem' }}>
                {workspaceHasAnthropic ? (
                  <form action={clearAnthropic}>
                    <ConfirmFormButton
                      className="ghost-btn"
                      message={clearWorkspaceKeyConfirm({
                        vendorName: 'Anthropic',
                        workspaceName: workspaceRow.name,
                        workspaceSlug: workspaceRow.slug,
                      })}
                    >
                      Clear workspace Anthropic key
                    </ConfirmFormButton>
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
          <h2>Google Gemini</h2>
          <p className="muted">
            Runs discovery as grounded web search — Gemini searches Google
            and answers with citations — and lead research (the Research
            panel on a lead in the <Link href="/pipeline">pipeline</Link>),
            when it is chosen under Web Search in Active providers or is the
            platform default.{' '}
            <KeyChoiceIntro vendor="gemini" noun="Gemini" biller="Google" {...introProps} />
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
              <KeySourceLine vendor="gemini" {...keyLineProps} />
            </dd>
            <dt>Workspace key</dt>
            <dd>{workspaceHasGemini ? <code>••• stored</code> : <code>not set</code>}</dd>
            <dt>Platform key</dt>
            <dd>
              {platformHasGemini ? (
                <code>provided by {BRAND_NAME}</code>
              ) : (
                <code>none — the platform has no key for this provider</code>
              )}
            </dd>
          </dl>

          {isAdmin ? (
            <>
              {byokAllowed ? (
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
              ) : (
                <OwnKeysNeedPro />
              )}
              <div className="action-row" style={{ marginTop: '0.5rem' }}>
                {workspaceHasGemini ? (
                  <form action={clearGemini}>
                    <ConfirmFormButton
                      className="ghost-btn"
                      message={clearWorkspaceKeyConfirm({
                        vendorName: 'Gemini',
                        workspaceName: workspaceRow.name,
                        workspaceSlug: workspaceRow.slug,
                      })}
                    >
                      Clear workspace Gemini key
                    </ConfirmFormButton>
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
          <h2>Perplexity</h2>
          <p className="muted">
            Runs discovery as grounded web search — Perplexity Sonar answers
            from live web search with citations (the <code>sonar-pro</code>{' '}
            model gives richer ones) — when it is chosen under Web Search in
            Active providers, and lead research when it is chosen there or is
            the platform&apos;s research default.{' '}
            <KeyChoiceIntro vendor="perplexity" noun="Perplexity" biller="Perplexity" {...introProps} />
          </p>

          <dl>
            <dt>Effective key source</dt>
            <dd>
              <KeySourceLine vendor="perplexity" {...keyLineProps} />
            </dd>
            <dt>Workspace key</dt>
            <dd>{workspaceHasPerplexity ? <code>••• stored</code> : <code>not set</code>}</dd>
            <dt>Platform key</dt>
            <dd>
              {platformHasPerplexity ? (
                <code>provided by {BRAND_NAME}</code>
              ) : (
                <code>none — the platform has no key for this provider</code>
              )}
            </dd>
          </dl>

          {isAdmin ? (
            <>
              {byokAllowed ? (
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
              ) : (
                <OwnKeysNeedPro />
              )}
              <div className="action-row" style={{ marginTop: '0.5rem' }}>
                {workspaceHasPerplexity ? (
                  <form action={clearPerplexity}>
                    <ConfirmFormButton
                      className="ghost-btn"
                      message={clearWorkspaceKeyConfirm({
                        vendorName: 'Perplexity',
                        workspaceName: workspaceRow.name,
                        workspaceSlug: workspaceRow.slug,
                      })}
                    >
                      Clear workspace Perplexity key
                    </ConfirmFormButton>
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
      </>
  );
}

/** In place of a provider section's "Set workspace … key" form when the
 *  plan has no BYOK (setSecret would refuse the save). */
function OwnKeysNeedPro() {
  return (
    <p className="muted small" data-testid="own-keys-need-pro">
      Your own keys need the Pro plan — <Link href="/settings/billing">see plans in Billing</Link>.
    </p>
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
