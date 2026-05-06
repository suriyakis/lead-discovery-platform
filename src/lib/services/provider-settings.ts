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
  embeddingProvider: string | null;
  researchProvider: string | null;
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
      embeddingProvider: row.embeddingProvider,
      researchProvider: row.researchProvider,
      searchProvider: row.searchProvider,
    };
  }
  return {
    workspaceId: ctx.workspaceId,
    aiProvider: null,
    embeddingProvider: null,
    researchProvider: null,
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
  embeddingProvider?: EmbeddingProviderId | null;
  researchProvider?: ResearchProviderId | null;
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

  // Upsert. Build update set from the keys actually present.
  const set: Partial<WorkspaceProviderSettings> = { updatedAt: new Date(), updatedBy: ctx.userId };
  if (input.aiProvider !== undefined) set.aiProvider = input.aiProvider;
  if (input.embeddingProvider !== undefined) set.embeddingProvider = input.embeddingProvider;
  if (input.researchProvider !== undefined) set.researchProvider = input.researchProvider;
  if (input.searchProvider !== undefined) set.searchProvider = input.searchProvider;

  const [row] = await db
    .insert(workspaceProviderSettings)
    .values({
      workspaceId: ctx.workspaceId,
      aiProvider: input.aiProvider ?? null,
      embeddingProvider: input.embeddingProvider ?? null,
      researchProvider: input.researchProvider ?? null,
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
      embedding: row.embeddingProvider,
      research: row.researchProvider,
      search: row.searchProvider,
    },
  });

  return row;
}
