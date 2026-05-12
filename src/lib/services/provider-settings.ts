// Per-workspace provider selection (Phase 45). Lets operators pick the
// active AI / embedding / research / search provider from the
// integrations page instead of needing an SSH-edit on .env.
//
// Resolution model: workspace setting (this table) wins; env var is the
// fallback. NULL in the workspace row means "inherit the env default",
// so existing setups without an opt-in stay on the env-driven behaviour.
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

export const ALLOWED_AI_PROVIDERS = ['mock', 'openai', 'anthropic'] as const;
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

// ─── Per-vendor model catalogs ─────────────────────────────────────────
//
// Drop-in additions to these arrays are safe — the validator just
// checks membership before writing. Keep the most capable model first
// so the UI dropdown shows it as a sensible default.

export const AI_MODELS: Record<string, readonly string[]> = {
  openai: [
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-4o',
    'gpt-4o-mini',
    'o3',
    'o3-mini',
  ],
  anthropic: [
    'claude-opus-4-7',
    'claude-opus-4',
    'claude-sonnet-4-6',
    'claude-sonnet-4',
    'claude-haiku-4-5',
  ],
  mock: ['mock-1'],
};

export const RESEARCH_MODELS: Record<string, readonly string[]> = {
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  perplexity: ['sonar-pro', 'sonar', 'sonar-reasoning'],
  mock: ['mock-1'],
};

/** True when `model` is in the catalog for the given provider. NULL
 *  always passes — null means "let the provider use its default". */
export function isValidAiModel(provider: string, model: string | null): boolean {
  if (model === null) return true;
  const catalog = AI_MODELS[provider];
  return catalog ? catalog.includes(model) : true;
}

export function isValidResearchModel(provider: string, model: string | null): boolean {
  if (model === null) return true;
  const catalog = RESEARCH_MODELS[provider];
  return catalog ? catalog.includes(model) : true;
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
  };
}

/**
 * Cascade resolver: workspace setting (when set) → env var → 'mock'.
 * Used by every per-ctx provider factory so the resolution logic lives
 * in one place.
 */
export interface ResolvedProvider {
  id: string;
  source: 'workspace' | 'env' | 'default';
}

export async function resolveActiveProvider(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  capability: 'ai' | 'embedding' | 'research' | 'search',
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
          : settings.searchProvider;
  if (wsValue && wsValue.trim()) {
    return { id: wsValue.trim(), source: 'workspace' };
  }
  const envVal = envFallback?.trim();
  if (envVal) return { id: envVal, source: 'env' };
  return { id: 'mock', source: 'default' };
}

// ─── Write ────────────────────────────────────────────────────────────

export interface UpdateProviderSettingsInput {
  aiProvider?: AiProviderId | null;
  aiModel?: string | null;
  embeddingProvider?: EmbeddingProviderId | null;
  researchProvider?: ResearchProviderId | null;
  researchModel?: string | null;
  searchProvider?: SearchProviderId | null;
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

  // Upsert. Build update set from the keys actually present.
  const set: Partial<WorkspaceProviderSettings> = { updatedAt: new Date(), updatedBy: ctx.userId };
  if (input.aiProvider !== undefined) set.aiProvider = input.aiProvider;
  if (input.aiModel !== undefined) set.aiModel = input.aiModel;
  if (input.embeddingProvider !== undefined) set.embeddingProvider = input.embeddingProvider;
  if (input.researchProvider !== undefined) set.researchProvider = input.researchProvider;
  if (input.researchModel !== undefined) set.researchModel = input.researchModel;
  if (input.searchProvider !== undefined) set.searchProvider = input.searchProvider;

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
    },
  });

  return row;
}
