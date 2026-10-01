import { redirect } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';
import {
  getWorkspaceContext,
  requirePlatformAdmin,
} from '@/lib/services/auth-context';
import { isSuperAdmin } from '@/lib/services/context';
import { isNextRedirectError } from '@/lib/server-redirect';
import {
  SecretsServiceError,
  deletePlatformSecret,
  listPlatformSecretKeys,
  setPlatformSecret,
} from '@/lib/services/secrets';
import {
  AI_MODELS,
  ALLOWED_AI_PROVIDERS,
  ALLOWED_EMBEDDING_PROVIDERS,
  ALLOWED_RESEARCH_PROVIDERS,
  ALLOWED_SEARCH_PROVIDERS,
  ALLOWED_VECTOR_STORAGE_PROVIDERS,
  RESEARCH_MODELS,
  resolvePlatformProvider,
  type ProviderCapability,
  type ResolvedProvider,
} from '@/lib/services/provider-settings';
import { ProviderModelPair } from '@/components/ProviderModelPair';
import { ConfirmFormButton } from '@/components/ConfirmFormButton';
import { removeConsoleKeyConfirm, savePlatformDefaultsConfirm } from '@/lib/confirm-copy';
import {
  PlatformSettingsError,
  getPlatformSettings,
  setPlatformSettings,
} from '@/lib/services/platform-settings';
// The catalogue of platform keys the console manages
// (src/lib/platform-provider-keys.ts, re-exported by the live checks of
// PC-02). Each secretKey doubles as the workspace BYOK key name, so the
// runtime's workspace → console → env order applies to it. The status
// table reads each vendor's key location from the same catalogue.
import { platformKeyForVendor } from '@/lib/platform-provider-keys';
import {
  PLATFORM_PROVIDER_KEYS as PROVIDERS,
  PlatformProviderKeySchema,
  checkPlatformAIProvider,
  checkPlatformProviderKey,
  describePlatformAICheck,
  describePlatformKeyCheck,
} from '@/lib/services/platform-provider-checks';

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
  { cap: 'embedding', label: 'Embeddings — semantic retrieval', hasModel: true },
  { cap: 'vector_storage', label: 'Vector storage', hasModel: false },
];

/** What each vendor adapter actually runs when no model is configured
 *  anywhere — shown concretely instead of a vague "provider default".
 *  Keep in sync with the adapters' built-in defaults. */
const VENDOR_BUILTIN_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  deepseek: 'deepseek-v4-flash',
  perplexity: 'sonar-pro',
};

/** Built-in default for the embeddings capability (OpenAI adapter). */
const EMBEDDING_BUILTIN_MODEL = 'text-embedding-3-small';

export default async function AdminProvidersPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const pctx = await requirePlatformAdmin();
  const sp = await searchParams;

  const stored = await listPlatformSecretKeys(pctx);
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
  // Same resolver the runtime uses below the workspace tier, and the one
  // "Test platform AI default" uses, so the table and the test agree.
  const effective = {} as Record<ProviderCapability, ResolvedProvider>;
  for (const cap of Object.keys(ENV_SELECTORS) as ProviderCapability[]) {
    effective[cap] = await resolvePlatformProvider(cap, ENV_SELECTORS[cap]);
  }
  const sourceLabel = (r: ResolvedProvider) =>
    r.source === 'platform'
      ? 'set here in the console'
      : r.source === 'env'
        ? 'server env var'
        : 'auto-detected (first vendor with a key)';

  // Effective models via the SAME resolver the runtime uses (console →
  // env, vendor-compatibility enforced; no workspace tier at platform
  // level). Whatever this shows is what a fresh workspace actually gets.
  const { resolveTieredModel } = await import('@/lib/services/provider-settings');
  const effectiveModels: Partial<Record<ProviderCapability, string | undefined>> = {
    ai: await resolveTieredModel('ai', effective.ai.id, null, process.env.AI_MODEL),
    qualification: await resolveTieredModel(
      'qualification',
      effective.qualification.id,
      null,
      undefined,
    ),
    research: await resolveTieredModel(
      'research',
      effective.research.id,
      null,
      process.env.RESEARCH_MODEL,
    ),
  };


  async function saveKey(formData: FormData) {
    'use server';
    const c = await requirePlatformAdmin();
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
    const c = await requirePlatformAdmin();
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
    const c = await requirePlatformAdmin();
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

  // Both live checks below test the PLATFORM tier only (I124): the key
  // saved here, else the server env var, and the platform default
  // vendor/model shown in the status table. They never resolve the
  // admin's current workspace, so a tenant's own key or provider override
  // cannot make a broken platform key look healthy.
  async function testAI() {
    'use server';
    await requirePlatformAdmin();
    let target: string;
    try {
      const r = describePlatformAICheck(await checkPlatformAIProvider());
      target = `/admin/providers?${r.ok ? 'msg' : 'err'}=${encodeURIComponent(r.message)}`;
    } catch (err) {
      const m = err instanceof Error ? err.message : 'test failed';
      target = `/admin/providers?err=${encodeURIComponent(`Platform AI default: ${m.slice(0, 300)}`)}`;
    }
    redirect(target);
  }

  // Per-vendor key check: a cheap live call with this vendor's platform
  // key, independent of which capability currently points at it. Testing
  // only the active AI provider left the other vendors (DeepSeek on
  // qualification, Mistral on OCR, search backends) undetectable until a
  // production call failed.
  async function testVendorKey(formData: FormData) {
    'use server';
    await requirePlatformAdmin();
    const parsed = PlatformProviderKeySchema.safeParse(formData.get('secretKey'));
    if (!parsed.success) redirect('/admin/providers?err=Unknown+provider');
    let target: string;
    try {
      const r = describePlatformKeyCheck(await checkPlatformProviderKey(parsed.data));
      target = `/admin/providers?${r.ok ? 'msg' : 'err'}=${encodeURIComponent(r.message)}`;
    } catch (err) {
      const m = err instanceof Error ? err.message : 'test failed';
      target = `/admin/providers?err=${encodeURIComponent(`${parsed.data}: ${m.slice(0, 300)}`)}`;
    }
    redirect(target);
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
              {/* nowrap header + shrink-guarded badge column: long role
                  text (DeepSeek, Mistral) must truncate/wrap INSIDE the
                  left column, never push the badge onto its own line —
                  that made those two cards look misaligned vs the rest. */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'nowrap' }}>
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <strong>{p.name}</strong>{' '}
                  <code className="muted small">{p.secretKey}</code>
                  <p className="muted small" style={{ margin: '0.2rem 0 0', maxWidth: '42rem' }}>{p.role}</p>
                </div>
                <div className="meta" style={{ flex: '0 0 auto', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <span
                    className={
                      active === 'none' ? 'badge badge-bad' : 'badge badge-good'
                    }
                    title={`Env var ${p.envVar}: ${envSet ? 'set' : 'not set'}`}
                  >
                    active: {active}
                  </span>
                  {row ? (
                    <span className="muted small" style={{ display: 'block', marginTop: '0.2rem' }}>
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
                    <ConfirmFormButton
                      className="ghost-btn"
                      message={removeConsoleKeyConfirm({
                        vendorName: p.name,
                        envVar: p.envVar,
                        envSet,
                      })}
                    >
                      Remove console key
                    </ConfirmFormButton>
                  </form>
                ) : null}
                {active !== 'none' ? (
                  <form action={testVendorKey}>
                    <input type="hidden" name="secretKey" value={p.secretKey} />
                    <button
                      type="submit"
                      className="ghost-btn"
                      title="Runs a minimal live call against this vendor with the platform key (console key, else server env var). Workspace keys (BYOK) are never used here."
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
            <ConfirmFormButton className="primary-btn" message={savePlatformDefaultsConfirm()}>
              Save platform defaults
            </ConfirmFormButton>
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
              // EFFECTIVE model, exactly as the runtime resolves it:
              // configured value (console/env, vendor-compatible) or the
              // vendor adapter's concrete built-in — never a vague
              // "provider default".
              let model: { id: string; builtin: boolean } | null = null;
              if (hasModel) {
                if (cap === 'embedding') {
                  model = { id: EMBEDDING_BUILTIN_MODEL, builtin: true };
                } else {
                  const configured = effectiveModels[cap];
                  model = configured
                    ? { id: configured, builtin: false }
                    : {
                        id: VENDOR_BUILTIN_MODELS[resolved.id] ?? 'vendor default',
                        builtin: true,
                      };
                }
              }
              const keyMeta = platformKeyForVendor(resolved.id);
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
                    {model ? (
                      <>
                        <code>{model.id}</code>
                        {model.builtin ? (
                          <span className="muted small"> (built-in)</span>
                        ) : null}
                      </>
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
            Test platform AI default
          </button>
          <span className="muted small" style={{ alignSelf: 'center' }}>
            Live 1-token call to the AI provider and model in the table above,
            with the platform key. Your current workspace&apos;s own
            selection and keys are not used.
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
