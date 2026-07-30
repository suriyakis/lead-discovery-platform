// Per-workspace provider selection (Phase 45). Lets operators pick the
// active AI / embedding / research / search provider from the
// integrations page instead of needing an SSH-edit on .env.
//
// Resolution model: workspace setting (this table) wins; env var is the
// fallback; last comes the auto-detected system default (first vendor
// with a platform key — see systemDefaultProvider). NULL in the
// workspace row means "inherit the platform default".
//
// Pure read helpers are exported so the per-ctx factories in
// src/lib/{ai,embeddings,research,search} can consult the workspace
// row before reading process.env.

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  workspaceProviderSettings,
  type WorkspaceProviderSettings,
} from '@/lib/db/schema/workspaces';
import { recordAuditEvent } from './audit';
import { canAdminWorkspace, type WorkspaceContext } from './context';

export class ProviderSettingsError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ProviderSettingsError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new ProviderSettingsError(`Permission denied: ${op}`, 'permission_denied');
const invalid = (msg: string) =>
  new ProviderSettingsError(msg, 'invalid_input');

// ─── Allowed values per capability ────────────────────────────────────

export const ALLOWED_AI_PROVIDERS = [
  'mock',
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
] as const;
export type AiProviderId = (typeof ALLOWED_AI_PROVIDERS)[number];

export const ALLOWED_EMBEDDING_PROVIDERS = ['mock', 'openai'] as const;
export type EmbeddingProviderId = (typeof ALLOWED_EMBEDDING_PROVIDERS)[number];

export const ALLOWED_RESEARCH_PROVIDERS = [
  'mock',
  'gemini',
  'perplexity',
] as const;
export type ResearchProviderId = (typeof ALLOWED_RESEARCH_PROVIDERS)[number];

export const ALLOWED_SEARCH_PROVIDERS = ['mock', 'serpapi'] as const;
export type SearchProviderId = (typeof ALLOWED_SEARCH_PROVIDERS)[number];

export const ALLOWED_VECTOR_STORAGE_PROVIDERS = [
  'mock',
  'pgvector',
  'openai',
] as const;
export type VectorStorageProviderId =
  (typeof ALLOWED_VECTOR_STORAGE_PROVIDERS)[number];

// ─── Per-vendor model catalogs ─────────────────────────────────────────
//
// Drop-in additions to these arrays are safe — the validator just
// checks membership before writing. Keep the most capable model first
// so the UI dropdown shows it as a sensible default.

// Catalogs are suggestions — the Model dropdowns on /settings/integrations
// are now comboboxes (typeable input + datalist), so the operator can
// enter any model id the vendor ships without a code change. Keep these
// lists current with what's worth pre-suggesting.
// Catalogs refreshed 2026-07-30 against vendor docs. Note the traps:
// DeepSeek RETIRED deepseek-chat/-reasoner on 2026-07-24 (v4 lineup now);
// Gemini shut down the 2.0 models on 2026-06-01; Anthropic deprecated
// claude-opus-4 / claude-sonnet-4 (Claude 5 family is current).
export const AI_MODELS: Record<string, readonly string[]> = {
  openai: [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4-nano',
    'gpt-4o',
    'gpt-4o-mini',
  ],
  anthropic: [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
  ],
  gemini: [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.0-pro',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ],
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  mock: ['mock-1'],
};

export const RESEARCH_MODELS: Record<string, readonly string[]> = {
  gemini: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.0-pro', 'gemini-2.5-pro'],
  perplexity: ['sonar-pro', 'sonar', 'sonar-reasoning'],
  mock: ['mock-1'],
};

/** Loose model-id shape check. NULL always passes — null means "let
 *  the provider use its default". The catalogs are suggestions only;
 *  the combobox lets operators enter freshly-released models without
 *  a deploy. Real validation happens at the API call site (vendor
 *  rejects with a clear error if the id is wrong). */
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,118}$/i;
export function isValidAiModel(provider: string, model: string | null): boolean {
  if (model === null) return true;
  void provider;
  return MODEL_ID_RE.test(model);
}

export function isValidResearchModel(provider: string, model: string | null): boolean {
  if (model === null) return true;
  void provider;
  return MODEL_ID_RE.test(model);
}

// ─── Read ─────────────────────────────────────────────────────────────

/**
 * Lazy-loads the workspace's provider settings row, returning all-NULL
 * defaults if the row doesn't exist yet. Pure read — never inserts.
 */
export async function getProviderSettings(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<{
  workspaceId: bigint;
  aiProvider: string | null;
  aiModel: string | null;
  embeddingProvider: string | null;
  researchProvider: string | null;
  researchModel: string | null;
  searchProvider: string | null;
  vectorStorageProvider: string | null;
  qualificationProvider: string | null;
  qualificationModel: string | null;
}> {
  const [row] = await db
    .select()
    .from(workspaceProviderSettings)
    .where(eq(workspaceProviderSettings.workspaceId, ctx.workspaceId))
    .limit(1);
  if (row) {
    return {
      workspaceId: row.workspaceId,
      aiProvider: row.aiProvider,
      aiModel: row.aiModel,
      embeddingProvider: row.embeddingProvider,
      researchProvider: row.researchProvider,
      researchModel: row.researchModel,
      searchProvider: row.searchProvider,
      vectorStorageProvider: row.vectorStorageProvider,
      qualificationProvider: row.qualificationProvider,
      qualificationModel: row.qualificationModel,
    };
  }
  return {
    workspaceId: ctx.workspaceId,
    aiProvider: null,
    aiModel: null,
    embeddingProvider: null,
    researchProvider: null,
    researchModel: null,
    searchProvider: null,
    vectorStorageProvider: null,
    qualificationProvider: null,
    qualificationModel: null,
  };
}

/**
 * Cascade resolver: workspace setting (when set) → env var → system
 * default (see `systemDefaultProvider`). Used by every per-ctx provider
 * factory so the resolution logic lives in one place.
 */
export interface ResolvedProvider {
  id: string;
  source: 'workspace' | 'platform' | 'env' | 'default';
}

export type ProviderCapability =
  | 'ai'
  | 'embedding'
  | 'research'
  | 'search'
  | 'vector_storage'
  | 'qualification';

// Vendor preference per capability for the system default, in order.
// A vendor qualifies when its platform key env var is set (envKey null
// = keyless vendor, always qualifies). Gemini leads the AI/research
// lists because it's the vendor the platform itself runs on.
const SYSTEM_DEFAULT_CANDIDATES: Record<
  ProviderCapability,
  ReadonlyArray<{ id: string; envKey: string | null; secretKey: string | null }>
> = {
  ai: [
    { id: 'gemini', envKey: 'GEMINI_API_KEY', secretKey: 'gemini.apiKey' },
    { id: 'openai', envKey: 'OPENAI_API_KEY', secretKey: 'openai.apiKey' },
    { id: 'anthropic', envKey: 'ANTHROPIC_API_KEY', secretKey: 'anthropic.apiKey' },
    { id: 'deepseek', envKey: 'DEEPSEEK_API_KEY', secretKey: 'deepseek.apiKey' },
  ],
  // Qualification runs at much higher volume than drafting (every
  // sourced lead gets scored), so the auto-detect order is cheapest
  // vendor first instead of ai's quality-first order.
  qualification: [
    { id: 'deepseek', envKey: 'DEEPSEEK_API_KEY', secretKey: 'deepseek.apiKey' },
    { id: 'gemini', envKey: 'GEMINI_API_KEY', secretKey: 'gemini.apiKey' },
    { id: 'openai', envKey: 'OPENAI_API_KEY', secretKey: 'openai.apiKey' },
    { id: 'anthropic', envKey: 'ANTHROPIC_API_KEY', secretKey: 'anthropic.apiKey' },
  ],
  embedding: [{ id: 'openai', envKey: 'OPENAI_API_KEY', secretKey: 'openai.apiKey' }],
  research: [
    { id: 'gemini', envKey: 'GEMINI_API_KEY', secretKey: 'gemini.apiKey' },
    { id: 'perplexity', envKey: 'PERPLEXITY_API_KEY', secretKey: 'perplexity.apiKey' },
  ],
  search: [{ id: 'serpapi', envKey: 'SERPAPI_KEY', secretKey: 'serpapi.apiKey' }],
  vector_storage: [{ id: 'pgvector', envKey: null, secretKey: null }],
};

/**
 * System default for a capability when neither the workspace nor the
 * env selector picked a provider. Auto-detects the first vendor whose
 * platform key is configured, so a fresh workspace is live on real
 * providers the moment the server has keys — no per-workspace setup.
 *
 * When NO platform key exists for the capability:
 *   - production  → returns the preferred real vendor anyway, so calls
 *     fail loudly with "no key configured" instead of fabricating mock
 *     data. Exception: 'search' stays mock because grounded research is
 *     its real fallback (see getWebSearchProviderForCtx) and a loud
 *     serpapi failure would mask that path.
 *   - dev/test    → 'mock'.
 */
export function systemDefaultProvider(
  capability: ProviderCapability,
): ResolvedProvider {
  const candidates = SYSTEM_DEFAULT_CANDIDATES[capability];
  for (const c of candidates) {
    if (c.envKey === null || process.env[c.envKey]?.trim()) {
      return { id: c.id, source: 'default' };
    }
  }
  if (process.env.NODE_ENV === 'production' && capability !== 'search') {
    return { id: candidates[0]!.id, source: 'default' };
  }
  return { id: 'mock', source: 'default' };
}

/**
 * Async auto-detect that ALSO sees keys saved on /admin/providers
 * (platform_secrets), not just env vars. With env empty and only, say,
 * an Anthropic key in the console, the sync detector would blindly pick
 * gemini (preference order) and every call would fail "no key
 * configured" — this one picks the first vendor that actually HAS a key
 * anywhere. Falls back to the sync behavior when nothing is configured.
 */
export async function detectSystemDefaultProvider(
  capability: ProviderCapability,
): Promise<ResolvedProvider> {
  const candidates = SYSTEM_DEFAULT_CANDIDATES[capability];
  const { hasPlatformSecretKey } = await import('./secrets');
  for (const c of candidates) {
    if (c.envKey === null) return { id: c.id, source: 'default' };
    if (process.env[c.envKey]?.trim()) return { id: c.id, source: 'default' };
    if (c.secretKey && (await hasPlatformSecretKey(c.secretKey))) {
      return { id: c.id, source: 'default' };
    }
  }
  if (process.env.NODE_ENV === 'production' && capability !== 'search') {
    return { id: candidates[0]!.id, source: 'default' };
  }
  return { id: 'mock', source: 'default' };
}

export async function resolveActiveProvider(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  capability: ProviderCapability,
  envFallback: string | undefined,
): Promise<ResolvedProvider> {
  const settings = await getProviderSettings(ctx);
  const wsValue =
    capability === 'ai'
      ? settings.aiProvider
      : capability === 'embedding'
        ? settings.embeddingProvider
        : capability === 'research'
          ? settings.researchProvider
          : capability === 'search'
            ? settings.searchProvider
            : capability === 'qualification'
              ? settings.qualificationProvider
              : settings.vectorStorageProvider;
  if (wsValue && wsValue.trim()) {
    return { id: wsValue.trim(), source: 'workspace' };
  }
  // Platform default set from /admin/providers — beats the env var so the
  // console is the live source of truth without a redeploy.
  const { getPlatformSetting } = await import('./platform-settings');
  const platformValue = await getPlatformSetting(`${capability}.provider`);
  if (platformValue) return { id: platformValue, source: 'platform' };
  const envVal = envFallback?.trim();
  if (envVal) return { id: envVal, source: 'env' };
  return detectSystemDefaultProvider(capability);
}

/**
 * Platform-tier-only model lookup. Prefer `resolveTieredModel` at call
 * sites — this is exported for the admin console, which needs the raw
 * platform value regardless of what tier is currently active.
 */
export async function resolvePlatformModel(
  capability: 'ai' | 'research' | 'qualification',
  envVar: string | undefined,
): Promise<string | undefined> {
  const { getPlatformSetting } = await import('./platform-settings');
  const platformModel = await getPlatformSetting(`${capability}.model`);
  return platformModel ?? envVar?.trim() ?? undefined;
}

/**
 * Model resolution that stays IN THE SAME TIER as the resolved provider
 * id (see `ResolvedProvider.source`), instead of chaining independent
 * workspace/platform/env model lookups. That independent chaining was a
 * real bug: a super-admin clearing the platform provider back to
 * "Automatic" (e.g. ai.provider) does NOT also clear the paired
 * ai.model row, so a stale model string for one vendor (say
 * gemini-3.6-flash, left over from when the platform default was
 * Gemini) would get silently reattached to whatever DIFFERENT vendor
 * the cascade landed on next (e.g. Anthropic via the env fallback) —
 * producing `anthropic messages 404: model: gemini-3.6-flash`.
 *
 * Only trust a model value when it was set at the SAME tier that
 * produced the active provider id:
 *   - source 'workspace' → the workspace's own <capability>Model
 *   - source 'platform'  → the platform console's <capability>.model
 *   - source 'env'       → the paired env var (e.g. AI_MODEL)
 *   - source 'default' (auto-detected) → undefined, always — never
 *     guess a model for a vendor nobody explicitly chose; the
 *     provider's own built-in default applies instead.
 */
export async function resolveTieredModel(
  capability: 'ai' | 'research' | 'qualification',
  source: ResolvedProvider['source'],
  workspaceModel: string | null | undefined,
  envVar: string | undefined,
): Promise<string | undefined> {
  if (source === 'workspace') return workspaceModel?.trim() || undefined;
  if (source === 'platform') {
    const { getPlatformSetting } = await import('./platform-settings');
    const v = await getPlatformSetting(`${capability}.model`);
    return v ?? undefined;
  }
  if (source === 'env') return envVar?.trim() || undefined;
  return undefined;
}

// ─── Write ────────────────────────────────────────────────────────────

export interface UpdateProviderSettingsInput {
  aiProvider?: AiProviderId | null;
  aiModel?: string | null;
  embeddingProvider?: EmbeddingProviderId | null;
  researchProvider?: ResearchProviderId | null;
  researchModel?: string | null;
  searchProvider?: SearchProviderId | null;
  vectorStorageProvider?: VectorStorageProviderId | null;
  qualificationProvider?: AiProviderId | null;
  qualificationModel?: string | null;
}

/**
 * Admin-only. Pass `null` for a capability to clear the workspace
 * override (falls back to env). Omit a key to leave it unchanged.
 */
export async function updateProviderSettings(
  ctx: WorkspaceContext,
  input: UpdateProviderSettingsInput,
): Promise<WorkspaceProviderSettings> {
  if (!canAdminWorkspace(ctx)) throw denied('provider_settings.update');

  // Validate each provided value against the allowed set.
  if (input.aiProvider !== undefined && input.aiProvider !== null) {
    if (!(ALLOWED_AI_PROVIDERS as readonly string[]).includes(input.aiProvider)) {
      throw invalid(`unknown ai provider: ${input.aiProvider}`);
    }
  }
  if (input.embeddingProvider !== undefined && input.embeddingProvider !== null) {
    if (
      !(ALLOWED_EMBEDDING_PROVIDERS as readonly string[]).includes(
        input.embeddingProvider,
      )
    ) {
      throw invalid(`unknown embedding provider: ${input.embeddingProvider}`);
    }
  }
  if (input.researchProvider !== undefined && input.researchProvider !== null) {
    if (
      !(ALLOWED_RESEARCH_PROVIDERS as readonly string[]).includes(
        input.researchProvider,
      )
    ) {
      throw invalid(`unknown research provider: ${input.researchProvider}`);
    }
  }
  if (input.searchProvider !== undefined && input.searchProvider !== null) {
    if (
      !(ALLOWED_SEARCH_PROVIDERS as readonly string[]).includes(input.searchProvider)
    ) {
      throw invalid(`unknown search provider: ${input.searchProvider}`);
    }
  }
  if (
    input.vectorStorageProvider !== undefined &&
    input.vectorStorageProvider !== null
  ) {
    if (
      !(ALLOWED_VECTOR_STORAGE_PROVIDERS as readonly string[]).includes(
        input.vectorStorageProvider,
      )
    ) {
      throw invalid(
        `unknown vector storage provider: ${input.vectorStorageProvider}`,
      );
    }
  }

  // Validate model fields against the chosen vendor's catalog. When
  // the vendor isn't being updated in the same call, we resolve the
  // current effective vendor and validate against that.
  if (input.aiModel !== undefined && input.aiModel !== null) {
    const effectiveAi =
      input.aiProvider !== undefined && input.aiProvider !== null
        ? input.aiProvider
        : (await getProviderSettings(ctx)).aiProvider ?? 'openai';
    if (!isValidAiModel(effectiveAi, input.aiModel)) {
      throw invalid(`unknown ${effectiveAi} model: ${input.aiModel}`);
    }
  }
  if (input.researchModel !== undefined && input.researchModel !== null) {
    const effectiveResearch =
      input.researchProvider !== undefined && input.researchProvider !== null
        ? input.researchProvider
        : (await getProviderSettings(ctx)).researchProvider ?? 'gemini';
    if (!isValidResearchModel(effectiveResearch, input.researchModel)) {
      throw invalid(`unknown ${effectiveResearch} model: ${input.researchModel}`);
    }
  }
  // P62-11: qualification provider is its own AI vendor selection.
  if (
    input.qualificationProvider !== undefined &&
    input.qualificationProvider !== null
  ) {
    if (
      !(ALLOWED_AI_PROVIDERS as readonly string[]).includes(
        input.qualificationProvider,
      )
    ) {
      throw invalid(
        `unknown qualification provider: ${input.qualificationProvider}`,
      );
    }
  }
  if (
    input.qualificationModel !== undefined &&
    input.qualificationModel !== null
  ) {
    const effectiveQual =
      input.qualificationProvider !== undefined &&
      input.qualificationProvider !== null
        ? input.qualificationProvider
        : (await getProviderSettings(ctx)).qualificationProvider ??
          (await getProviderSettings(ctx)).aiProvider ??
          'openai';
    if (!isValidAiModel(effectiveQual, input.qualificationModel)) {
      throw invalid(
        `unknown ${effectiveQual} model: ${input.qualificationModel}`,
      );
    }
  }

  // Upsert. Build update set from the keys actually present.
  const set: Partial<WorkspaceProviderSettings> = { updatedAt: new Date(), updatedBy: ctx.userId };
  if (input.aiProvider !== undefined) set.aiProvider = input.aiProvider;
  if (input.aiModel !== undefined) set.aiModel = input.aiModel;
  if (input.embeddingProvider !== undefined) set.embeddingProvider = input.embeddingProvider;
  if (input.researchProvider !== undefined) set.researchProvider = input.researchProvider;
  if (input.researchModel !== undefined) set.researchModel = input.researchModel;
  if (input.searchProvider !== undefined) set.searchProvider = input.searchProvider;
  if (input.vectorStorageProvider !== undefined)
    set.vectorStorageProvider = input.vectorStorageProvider;
  if (input.qualificationProvider !== undefined)
    set.qualificationProvider = input.qualificationProvider;
  if (input.qualificationModel !== undefined)
    set.qualificationModel = input.qualificationModel;

  const [row] = await db
    .insert(workspaceProviderSettings)
    .values({
      workspaceId: ctx.workspaceId,
      aiProvider: input.aiProvider ?? null,
      aiModel: input.aiModel ?? null,
      embeddingProvider: input.embeddingProvider ?? null,
      researchProvider: input.researchProvider ?? null,
      researchModel: input.researchModel ?? null,
      searchProvider: input.searchProvider ?? null,
      vectorStorageProvider: input.vectorStorageProvider ?? null,
      qualificationProvider: input.qualificationProvider ?? null,
      qualificationModel: input.qualificationModel ?? null,
      updatedBy: ctx.userId,
    })
    .onConflictDoUpdate({
      target: workspaceProviderSettings.workspaceId,
      set,
    })
    .returning();
  if (!row) {
    throw new ProviderSettingsError(
      'provider_settings upsert returned no row',
      'invariant_violation',
    );
  }

  await recordAuditEvent(ctx, {
    kind: 'provider_settings.update',
    entityType: 'workspace_provider_settings',
    entityId: ctx.workspaceId,
    payload: {
      ai: row.aiProvider,
      aiModel: row.aiModel,
      embedding: row.embeddingProvider,
      research: row.researchProvider,
      researchModel: row.researchModel,
      search: row.searchProvider,
      vectorStorage: row.vectorStorageProvider,
    },
  });

  return row;
}
