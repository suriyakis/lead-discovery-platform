// The platform provider keys: which console secret and which env var hold
// each vendor's platform key. The single catalogue behind
//   - the /admin/providers key cards and their live checks
//     (src/lib/services/platform-provider-checks.ts),
//   - the platform-status table's "Key" column (/admin/providers),
//   - the platform AI default's key lookup (getPlatformAIProvider in
//     src/lib/ai/index.ts).
// Before PC-02's review these were three hand-kept copies that could
// drift. A leaf module on purpose (no app imports), so src/lib/ai can use
// it without an import cycle through the checks module.

import { z } from 'zod';

export const PlatformProviderKeySchema = z.enum([
  'anthropic.apiKey',
  'openai.apiKey',
  'gemini.apiKey',
  'deepseek.apiKey',
  'mistral.apiKey',
  'serpapi.apiKey',
  'perplexity.apiKey',
]);
export type PlatformProviderSecretKey = z.infer<typeof PlatformProviderKeySchema>;

export interface PlatformProviderKeySpec {
  /** Provider id as the provider cascade names the vendor ('anthropic'). */
  vendor: string;
  /** Console secret name. It doubles as the workspace BYOK key name, so
   *  the runtime resolver's workspace → console → env order applies. */
  secretKey: PlatformProviderSecretKey;
  /** Server env var used when no console key is saved. */
  envVar: string;
  name: string;
  /** One-line description of what the platform uses this vendor for. */
  role: string;
}

/** The platform provider keys the console manages, in display order. */
export const PLATFORM_PROVIDER_KEYS: ReadonlyArray<PlatformProviderKeySpec> = [
  {
    vendor: 'anthropic',
    secretKey: 'anthropic.apiKey',
    envVar: 'ANTHROPIC_API_KEY',
    name: 'Anthropic (Claude)',
    role: 'AI drafting, conversation review — the default AI provider.',
  },
  {
    vendor: 'openai',
    secretKey: 'openai.apiKey',
    envVar: 'OPENAI_API_KEY',
    name: 'OpenAI',
    role: 'Embeddings (semantic search over knowledge + lessons); optional AI provider.',
  },
  {
    vendor: 'gemini',
    secretKey: 'gemini.apiKey',
    envVar: 'GEMINI_API_KEY',
    name: 'Google Gemini',
    role: 'Grounded web search — the engine behind lead discovery — and research.',
  },
  {
    vendor: 'deepseek',
    secretKey: 'deepseek.apiKey',
    envVar: 'DEEPSEEK_API_KEY',
    name: 'DeepSeek',
    role: 'Cost-efficient AI — the default for high-volume qualification.',
  },
  {
    vendor: 'mistral',
    secretKey: 'mistral.apiKey',
    envVar: 'MISTRAL_API_KEY',
    name: 'Mistral (OCR)',
    role: 'OCR for scanned PDFs — auto-selected when a PDF has no text layer.',
  },
  {
    vendor: 'serpapi',
    secretKey: 'serpapi.apiKey',
    envVar: 'SERPAPI_KEY',
    name: 'SerpAPI',
    role: 'Alternative web-search backend (optional).',
  },
  {
    vendor: 'perplexity',
    secretKey: 'perplexity.apiKey',
    envVar: 'PERPLEXITY_API_KEY',
    name: 'Perplexity',
    role: 'Alternative research backend (optional).',
  },
];

/** Where a vendor's platform key lives. */
export interface PlatformKeyLocation {
  secretKey: PlatformProviderSecretKey;
  envVar: string;
}

const KEY_BY_VENDOR: ReadonlyMap<string, PlatformKeyLocation> = new Map(
  PLATFORM_PROVIDER_KEYS.map((p) => [p.vendor, { secretKey: p.secretKey, envVar: p.envVar }]),
);

/**
 * The console secret and env var holding `vendor`'s platform key, or
 * null for a vendor that needs none (mock, pgvector, ...) or is unknown.
 */
export function platformKeyForVendor(vendor: string): PlatformKeyLocation | null {
  return KEY_BY_VENDOR.get(vendor) ?? null;
}
