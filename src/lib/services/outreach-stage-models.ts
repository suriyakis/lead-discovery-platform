// Per-stage AI selection. Each outreach stage maps to a (vendor, model)
// pair so the operator's "more important email = better model" intent
// is honored consistently across the pipeline.
//
// Tiering:
//   discovery       → OpenAI gpt-5-nano   (cheap, just asks for a contact)
//   referral_intro  → OpenAI gpt-5-nano   (same purpose, new contact)
//   engagement      → Anthropic Opus 4.7  (in-thread, where conversations win/die)
//   pitch           → Anthropic Opus 4.7  (the actual sales moment)
//   closing         → OpenAI gpt-5-nano   (terminal ack, doesn't need brilliance)
//
// Falls back to the workspace's default AI provider when the required
// vendor is not configured (e.g. workspace only has OpenAI keys, an
// Opus-tier stage runs through whatever the OpenAI default is).

import { getAIProviderById, getAIProviderForCtx, type IAIProvider } from '@/lib/ai';
import type { OutreachStage } from '@/lib/db/schema/outreach';
import type { WorkspaceContext } from './context';

export type StageRole =
  | 'discovery'
  | 'engagement'
  | 'pitch'
  | 'closing'
  | 'referral_intro';

export interface StageProvider {
  provider: IAIProvider;
  /** Pass to AIGenOptions.model so this stage uses the tier we picked,
   *  not the provider's workspace-default model. Empty string means
   *  "let the provider use its default" (used on fallback). */
  model: string;
}

const TIERS: Record<StageRole, { vendor: 'openai' | 'anthropic'; model: string }> = {
  discovery:      { vendor: 'openai',    model: 'gpt-5-nano' },
  referral_intro: { vendor: 'openai',    model: 'gpt-5-nano' },
  closing:        { vendor: 'openai',    model: 'gpt-5-nano' },
  engagement:     { vendor: 'anthropic', model: 'claude-opus-4-7' },
  pitch:          { vendor: 'anthropic', model: 'claude-opus-4-7' },
};

/** Map an OutreachStage from the DB to a StageRole. The DB enum lacks
 *  a `referral_intro` entry — referrals reuse `discovery` rows in the
 *  outreach_drafts table, but the caller knows when it's actually a
 *  referral and passes the role explicitly. */
export function roleForStage(stage: OutreachStage): StageRole {
  if (stage === 'discovery') return 'discovery';
  if (stage === 'engagement') return 'engagement';
  if (stage === 'pitch') return 'pitch';
  if (stage === 'closing') return 'closing';
  return 'engagement';
}

/**
 * Resolve the AI provider + model for a stage. Returns the workspace
 * default with `model: ''` when the requested vendor isn't configured
 * — caller's existing call sites already accept `model?: string` so
 * an empty string just leaves the provider on its built-in default.
 */
export async function getStageProvider(
  ctx: WorkspaceContext,
  role: StageRole,
): Promise<StageProvider> {
  const tier = TIERS[role];
  const specific = await getAIProviderById(ctx, tier.vendor);
  if (specific) {
    return { provider: specific, model: tier.model };
  }
  // Vendor not configured for this workspace — fall back to whatever
  // they DO have. Log so the operator can see they're missing the
  // intended tier.
  console.warn(
    `[outreach-stage-models] role=${role} wanted ${tier.vendor}/${tier.model} ` +
      `but the workspace has no ${tier.vendor} key — falling back to the ` +
      `workspace-default AI provider.`,
  );
  const fallback = await getAIProviderForCtx(ctx);
  return { provider: fallback, model: '' };
}
