// Live checks behind the /admin/providers "Test key" buttons and "Test
// platform AI default" (PC-02, I124).
//
// Both check the PLATFORM tier only: the key saved in the console, else
// the server env var, and the platform default AI vendor and model. They
// take no workspace context on purpose. The old checks resolved through
// the admin's current workspace, so a tenant's own (BYOK) key or provider
// override could pass the test while the key every other tenant relies
// on was broken.
//
// Results say where the key came from, and `authRejected` marks a key
// the vendor refused (HTTP 401/403). PC-07 will raise a critical
// incident on that; until then the console shows it in the error banner.

import { getPlatformAIProvider } from '@/lib/ai';
import {
  PLATFORM_PROVIDER_KEYS,
  PlatformProviderKeySchema,
  type PlatformProviderKeySpec,
  type PlatformProviderSecretKey,
} from '@/lib/platform-provider-keys';
import { resolvePlatformProviderKey } from './secrets';

// The key catalogue is shared with the status table and the AI module;
// re-exported here so callers of the checks keep one import.
export {
  PLATFORM_PROVIDER_KEYS,
  PlatformProviderKeySchema,
  type PlatformProviderKeySpec,
  type PlatformProviderSecretKey,
};

export type PlatformKeySource = 'console' | 'env';

/** How a platform key source reads in console messages. */
export function platformKeySourceLabel(source: PlatformKeySource, envVar: string): string {
  return source === 'console' ? 'console key' : `server env var ${envVar}`;
}

export type PlatformCheckStatus = 'ok' | 'failed' | 'missing';

interface VendorAnswer {
  ok: boolean;
  /** HTTP status of the vendor's answer when known. */
  httpStatus: number | null;
  detail: string | null;
}

/** The AI adapters report failures as "<vendor call> <status>: <body>". */
function statusFromDetail(detail: string | null | undefined): number | null {
  const m = detail ? /\b([1-5]\d{2}):/.exec(detail) : null;
  return m ? Number(m[1]) : null;
}

/** Vendor wording for a bad key when the status alone does not say so
 *  (Gemini answers an invalid key with 400 API_KEY_INVALID). */
const BAD_KEY_TEXT = /api[_ ]key[_ ]invalid|api key not valid|invalid (x-)?api[- ]key|incorrect api key/i;

function isAuthRejection(httpStatus: number | null, detail: string | null): boolean {
  if (httpStatus === 401 || httpStatus === 403) return true;
  return httpStatus === 400 && BAD_KEY_TEXT.test(detail ?? '');
}

async function fetchAnswer(res: Response, withBody: boolean): Promise<VendorAnswer> {
  if (res.ok) return { ok: true, httpStatus: res.status, detail: null };
  const body = withBody ? (await res.text().catch(() => '')).slice(0, 200) : '';
  return {
    ok: false,
    httpStatus: res.status,
    detail: body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`,
  };
}

/** A cheap live call per vendor with the given key. AI vendors use the
 *  same adapters as the runtime (base-URL overrides included); the rest
 *  use a free or one-token endpoint. */
async function callVendor(
  secretKey: PlatformProviderSecretKey,
  apiKey: string,
): Promise<VendorAnswer> {
  const fromHealth = (h: { ok: boolean; detail?: string }): VendorAnswer => ({
    ok: h.ok,
    httpStatus: h.ok ? null : statusFromDetail(h.detail),
    detail: h.ok ? null : (h.detail ?? null),
  });
  switch (secretKey) {
    case 'anthropic.apiKey': {
      const { AnthropicAIProvider } = await import('@/lib/ai');
      return fromHealth(
        await new AnthropicAIProvider({
          apiKey,
          model: 'claude-haiku-4-5',
          baseUrl: process.env.ANTHROPIC_BASE_URL,
        }).healthCheck(),
      );
    }
    case 'openai.apiKey': {
      const { OpenAIAIProvider } = await import('@/lib/ai');
      return fromHealth(
        await new OpenAIAIProvider({
          apiKey,
          model: 'gpt-4o-mini',
          baseUrl: process.env.OPENAI_BASE_URL,
        }).healthCheck(),
      );
    }
    case 'deepseek.apiKey': {
      const { DeepSeekAIProvider } = await import('@/lib/ai');
      return fromHealth(
        await new DeepSeekAIProvider({
          apiKey,
          baseUrl: process.env.DEEPSEEK_BASE_URL,
        }).healthCheck(),
      );
    }
    case 'gemini.apiKey': {
      const { GeminiAIProvider } = await import('@/lib/ai/gemini');
      return fromHealth(
        await new GeminiAIProvider({
          apiKey,
          baseUrl: process.env.GEMINI_BASE_URL,
        }).healthCheck(),
      );
    }
    case 'mistral.apiKey':
      // Free key validation: the models listing needs auth but bills nothing.
      return fetchAnswer(
        await fetch('https://api.mistral.ai/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        }),
        true,
      );
    case 'serpapi.apiKey':
      // The account endpoint is free and does not use search credits.
      return fetchAnswer(
        await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(apiKey)}`),
        false,
      );
    case 'perplexity.apiKey':
      return fetchAnswer(
        await fetch('https://api.perplexity.ai/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'sonar',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
        }),
        true,
      );
  }
}

export interface PlatformKeyCheckResult {
  secretKey: PlatformProviderSecretKey;
  name: string;
  envVar: string;
  status: PlatformCheckStatus;
  /** Where the tested key came from; null when the platform has none. */
  source: PlatformKeySource | null;
  httpStatus: number | null;
  /** The vendor refused the key itself (401/403). */
  authRejected: boolean;
  detail: string | null;
}

/**
 * Live-check the PLATFORM key for one vendor: the console key, else the
 * server env var. A workspace's own key is never used, so a valid tenant
 * BYOK key cannot hide a broken platform key.
 */
export async function checkPlatformProviderKey(
  secretKey: PlatformProviderSecretKey,
): Promise<PlatformKeyCheckResult> {
  const parsedKey = PlatformProviderKeySchema.parse(secretKey);
  const spec = PLATFORM_PROVIDER_KEYS.find((p) => p.secretKey === parsedKey)!;
  const base = { secretKey: spec.secretKey, name: spec.name, envVar: spec.envVar };
  const resolved = await resolvePlatformProviderKey(spec.secretKey, spec.envVar);
  if (!resolved) {
    return {
      ...base,
      status: 'missing',
      source: null,
      httpStatus: null,
      authRejected: false,
      detail: null,
    };
  }
  let answer: VendorAnswer;
  try {
    answer = await callVendor(spec.secretKey, resolved.key);
  } catch (err) {
    // Network failure, DNS, timeout: the vendor never answered.
    answer = {
      ok: false,
      httpStatus: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    ...base,
    status: answer.ok ? 'ok' : 'failed',
    source: resolved.source,
    httpStatus: answer.httpStatus,
    authRejected: !answer.ok && isAuthRejection(answer.httpStatus, answer.detail),
    detail: answer.detail,
  };
}

export interface PlatformAICheckResult {
  status: PlatformCheckStatus;
  /** Platform default vendor; null only when it could not be resolved. */
  vendor: string | null;
  vendorSource: 'platform' | 'env' | 'default' | null;
  /** The model the call used (or would use). */
  model: string | null;
  keySource: PlatformKeySource | null;
  keyEnvVar: string | null;
  httpStatus: number | null;
  authRejected: boolean;
  detail: string | null;
}

/**
 * Live 1-token call to the platform default AI provider: the vendor and
 * model the console's status table shows, with the platform key. The
 * admin's current workspace plays no part (no provider override, no
 * BYOK key).
 */
export async function checkPlatformAIProvider(): Promise<PlatformAICheckResult> {
  let resolution: Awaited<ReturnType<typeof getPlatformAIProvider>>;
  try {
    resolution = await getPlatformAIProvider();
  } catch (err) {
    return {
      status: 'failed',
      vendor: null,
      vendorSource: null,
      model: null,
      keySource: null,
      keyEnvVar: null,
      httpStatus: null,
      authRejected: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const { vendor, vendorSource, configuredModel, keySource, keyEnvVar, provider } = resolution;
  if (!provider) {
    return {
      status: 'missing',
      vendor,
      vendorSource,
      model: configuredModel ?? null,
      keySource: null,
      keyEnvVar,
      httpStatus: null,
      authRejected: false,
      detail: null,
    };
  }
  const health = await provider.healthCheck();
  const httpStatus = health.ok ? null : statusFromDetail(health.detail);
  return {
    status: health.ok ? 'ok' : 'failed',
    vendor,
    vendorSource,
    model: provider.model,
    keySource,
    keyEnvVar,
    httpStatus,
    authRejected: !health.ok && isAuthRejection(httpStatus, health.detail ?? null),
    detail: health.ok ? null : (health.detail ?? null),
  };
}

const AUTH_REJECTED_NOTE =
  ' The vendor rejected the key itself: every workspace without its own key is affected.';

function clip(detail: string | null): string {
  return (detail || 'no detail').slice(0, 300);
}

/** Banner text for a key check. `ok` picks the info vs error banner. */
export function describePlatformKeyCheck(r: PlatformKeyCheckResult): {
  ok: boolean;
  message: string;
} {
  if (r.status === 'missing' || !r.source) {
    return {
      ok: false,
      message: `${r.name}: no platform key (console or server env var ${r.envVar}). Workspace keys (BYOK) are never tested here.`,
    };
  }
  const src = platformKeySourceLabel(r.source, r.envVar);
  if (r.status === 'ok') {
    return { ok: true, message: `${r.name} platform key OK (${src}).` };
  }
  return {
    ok: false,
    message: `${r.name} platform key FAILED (${src}): ${clip(r.detail)}${r.authRejected ? AUTH_REJECTED_NOTE : ''}`,
  };
}

const VENDOR_SOURCE_LABEL: Record<'platform' | 'env' | 'default', string> = {
  platform: 'set here in the console',
  env: 'server env var AI_PROVIDER',
  default: 'auto-detected',
};

/** Banner text for the platform AI default check. */
export function describePlatformAICheck(r: PlatformAICheckResult): {
  ok: boolean;
  message: string;
} {
  if (!r.vendor || !r.vendorSource) {
    return { ok: false, message: `Platform AI default could not be resolved: ${clip(r.detail)}` };
  }
  const chosen = `vendor ${VENDOR_SOURCE_LABEL[r.vendorSource]}`;
  if (r.status === 'missing' || (!r.keySource && r.vendor !== 'mock')) {
    return {
      ok: false,
      message: `Platform AI default ${r.vendor} (${chosen}) has no platform key (console or server env var ${r.keyEnvVar ?? '?'}).`,
    };
  }
  const key = r.keySource
    ? platformKeySourceLabel(r.keySource, r.keyEnvVar ?? '')
    : 'no key needed';
  const what = `${r.vendor} / ${r.model ?? 'built-in model'}`;
  if (r.status === 'ok') {
    return { ok: true, message: `Platform AI default OK: ${what} (${chosen}; ${key}).` };
  }
  return {
    ok: false,
    message: `Platform AI default FAILED: ${what} (${chosen}; ${key}): ${clip(r.detail)}${r.authRejected ? AUTH_REJECTED_NOTE : ''}`,
  };
}
