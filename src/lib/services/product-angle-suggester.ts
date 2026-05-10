// Suggest a per-stage outreach angle for a product profile via AI.
// Given the product's name + description + sector context, the model
// produces a short instruction string the operator can paste straight
// into the corresponding angle field (or edit before saving).
//
// Three stage roles, each with its own prompt focus:
//   discovery  → how to ask "who handles X?" tone-wise. Never pitch.
//   engagement → in-thread tone for replies; what to lead with.
//   pitch      → angle for the actual product detail email.
//
// Caller picks the AI vendor (openai/anthropic) — UI exposes both as
// a dropdown so operators can compare suggestions across models.

import { getAIProviderById } from '@/lib/ai';
import type { WorkspaceContext } from './context';
import { getProductProfile } from './product-profile';
import { canWrite } from './context';

export class ProductAngleSuggesterError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ProductAngleSuggesterError';
    this.code = code;
  }
}

export type AngleStage = 'discovery' | 'engagement' | 'pitch';
export type SuggesterVendor = 'openai' | 'anthropic';

const VENDOR_MODELS: Record<SuggesterVendor, string> = {
  openai: 'gpt-5',
  anthropic: 'claude-opus-4-7',
};

const STAGE_BRIEFS: Record<AngleStage, string> = {
  discovery: [
    'You are writing GUIDANCE (not the email itself) for the AI that drafts a FIRST cold-email asking who handles a product category at a recipient organization.',
    'Output: 2-4 short directive sentences. No fluff. The drafter will read this verbatim as style guidance.',
    'The discovery email is ≤60 words and never pitches the product, so your guidance must focus on TONE and HOOK only:',
    '- what concrete signal to open with (a project type, a sector pattern, a public reference)',
    '- formality register (casual / professional / formal)',
    '- what NOT to mention (no features, no benefits, no pricing).',
    'Do not include the email itself. Do not include greetings or sign-offs. Just guidance.',
  ].join('\n'),
  engagement: [
    'You are writing GUIDANCE (not the email itself) for the AI that drafts an IN-THREAD REPLY to an inbound message during a sales conversation.',
    'Output: 3-5 short directive sentences. The drafter will read this verbatim as style guidance.',
    'Engagement replies are ≤80 words and avoid full pitches. Your guidance covers:',
    '- how to acknowledge what the recipient said (mirror their language, not yours)',
    '- which qualifying questions are most useful for THIS product (project size, timeline, current vendor, technical constraint)',
    '- what tone matches the recipient (match formality from their message)',
    '- what to defer to a later pitch stage (technical depth, pricing).',
    'No email body. No greetings. Just guidance.',
  ].join('\n'),
  pitch: [
    'You are writing GUIDANCE (not the email itself) for the AI that drafts a PITCH email when the recipient explicitly asks for product detail.',
    'Output: 4-6 short directive sentences. The drafter will read this verbatim as style guidance.',
    'Pitch emails are ≤180 words and DO mention the product. Your guidance covers:',
    '- which differentiator to lead with (the strongest, most context-relevant)',
    '- what evidence to include (one project reference, one technical spec, one commercial fact)',
    '- the structure (problem → product → next step)',
    '- the concrete next step (call, datasheet attached, sample shipped)',
    '- what to avoid (superlatives, marketing fluff, more than one CTA).',
    'No email body. No greetings. Just guidance.',
  ].join('\n'),
};

export interface SuggestStageAngleResult {
  /** The suggested angle text. Operator pastes / edits before saving. */
  text: string;
  /** Vendor used. */
  vendor: SuggesterVendor;
  /** Exact model id the provider returned. Useful for the audit trail. */
  model: string;
}

export async function suggestStageAngle(
  ctx: WorkspaceContext,
  productProfileId: bigint,
  stage: AngleStage,
  vendor: SuggesterVendor,
): Promise<SuggestStageAngleResult> {
  if (!canWrite(ctx)) {
    throw new ProductAngleSuggesterError(
      'Permission denied: product_angle.suggest',
      'permission_denied',
    );
  }
  const product = await getProductProfile(ctx, productProfileId);
  const provider = await getAIProviderById(ctx, vendor);
  if (!provider) {
    throw new ProductAngleSuggesterError(
      `No ${vendor} key configured for this workspace — set one in /settings/integrations.`,
      'no_key',
    );
  }
  const model = VENDOR_MODELS[vendor];

  const userPrompt = [
    `Product profile context (for guidance, NOT to be repeated verbatim):`,
    `- Name: ${product.name}`,
    product.shortDescription ? `- Short description: ${product.shortDescription}` : '',
    product.fullDescription ? `- Full description: ${product.fullDescription.slice(0, 1500)}` : '',
    product.targetSectors.length > 0
      ? `- Target sectors: ${product.targetSectors.join(', ')}`
      : '',
    product.targetProjectTypes.length > 0
      ? `- Project types: ${product.targetProjectTypes.join(', ')}`
      : '',
    product.targetCustomerTypes.length > 0
      ? `- Buyer roles: ${product.targetCustomerTypes.join(', ')}`
      : '',
    product.outreachInstructions
      ? `- Operator's existing outreach style note: ${product.outreachInstructions}`
      : '',
    '',
    `Write the ${stage}-stage angle guidance now.`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await provider.generateText(
    { system: STAGE_BRIEFS[stage], prompt: userPrompt },
    {
      temperature: vendor === 'openai' ? undefined : 0.4,
      maxTokens: 800,
      model,
    },
  );

  return {
    text: result.text.trim(),
    vendor,
    model: result.model,
  };
}
