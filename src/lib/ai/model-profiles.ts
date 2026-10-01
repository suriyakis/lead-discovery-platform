// Per-model parameter profiles (AP-02).
//
// One table for the vendor quirks that decide how a "visible answer with
// bounded reasoning" call has to be shaped: which effort knob the model
// takes (if any), and how much output budget its hidden reasoning needs
// so it can't eat the whole answer. Reasoning models bill their thinking
// against the same output cap as the answer — a 900-token budget on
// gpt-5.x or deepseek-v4-pro can come back as a 200 with EMPTY content
// (I135).
//
// Applied ONLY when a caller passes `AIGenOptions.reasoning`. With it
// absent, every adapter builds exactly the request body it always did
// (pinned by src/tests/ai-model-profiles.test.ts), so no existing caller
// changes behaviour.
//
// | model family                      | effort knob               | output floor |
// |-----------------------------------|---------------------------|--------------|
// | gpt-5.x, o1/o3 (OpenAI)           | reasoning_effort          | 2,500        |
// | o1-mini, o1-preview               | none (predates the knob)  | 2,500        |
// | gpt-5 chat variants               | none (no reasoning)       | none         |
// | claude 4.6+ / 5.x / fable         | output_config.effort      | 4,000        |
// | claude-haiku-4-5, pre-4.6 claude  | none (400 if sent)        | 1,500        |
// | deepseek-v4-pro                   | none (content only)       | 3,000        |
// | deepseek-v4-flash, gemini, other  | none                      | none         |
//
// Gemini needs nothing here: its adapter already adds 2,048 tokens of
// thinking headroom on 2.5+/3.x models, with or without `reasoning`.
// Thinking is never configured explicitly for Anthropic: Sonnet 5.5 and
// Opus 5.5 reject `thinking: {type: 'disabled'}` (400) and run adaptive
// thinking when it is omitted, which the 4,000 floor leaves room for.

/** How hard a reasoning model should think before answering. */
export type AIReasoningEffort = 'low' | 'medium' | 'high';

export type ReasoningVendor = 'openai' | 'anthropic' | 'deepseek' | 'gemini';

export interface ReasoningProfile {
  /** Where the adapter puts `reasoning`, or null when the model rejects
   *  (or has no) effort setting. */
  effort: 'reasoning_effort' | 'output_config' | null;
  /** Minimum output budget (max_tokens / max_completion_tokens). The
   *  caller's maxTokens is raised to it, never lowered. 0 = no floor. */
  minOutputTokens: number;
}

export const OPENAI_REASONING_MIN_OUTPUT_TOKENS = 2_500;
export const ANTHROPIC_THINKING_MIN_OUTPUT_TOKENS = 4_000;
export const ANTHROPIC_PLAIN_MIN_OUTPUT_TOKENS = 1_500;
export const DEEPSEEK_THINKING_MIN_OUTPUT_TOKENS = 3_000;

const NO_PROFILE: ReasoningProfile = { effort: null, minOutputTokens: 0 };

export function reasoningProfile(vendor: ReasoningVendor, model: string): ReasoningProfile {
  const m = model.toLowerCase();
  switch (vendor) {
    case 'openai':
      return openAIProfile(m);
    case 'anthropic':
      return anthropicProfile(m);
    case 'deepseek':
      return /v4-pro|reasoner/.test(m)
        ? { effort: null, minOutputTokens: DEEPSEEK_THINKING_MIN_OUTPUT_TOKENS }
        : NO_PROFILE;
    default:
      return NO_PROFILE;
  }
}

/** Raise `maxTokens` to the profile's floor (an unset budget becomes the
 *  floor; no floor leaves it untouched). */
export function withOutputFloor(
  maxTokens: number | undefined,
  profile: ReasoningProfile,
): number | undefined {
  if (profile.minOutputTokens <= 0) return maxTokens;
  return Math.max(maxTokens ?? 0, profile.minOutputTokens);
}

function openAIProfile(m: string): ReasoningProfile {
  const isGpt5 = m.startsWith('gpt-5');
  const isOSeries = /^o[13]/.test(m);
  if (!isGpt5 && !isOSeries) return NO_PROFILE; // gpt-4o family: no hidden reasoning
  // The chat-tuned gpt-5 variants don't reason and reject reasoning_effort.
  if (isGpt5 && m.includes('chat')) return NO_PROFILE;
  // o1-mini / o1-preview reason but predate the reasoning_effort parameter.
  if (/^o1-(mini|preview)/.test(m)) {
    return { effort: null, minOutputTokens: OPENAI_REASONING_MIN_OUTPUT_TOKENS };
  }
  return { effort: 'reasoning_effort', minOutputTokens: OPENAI_REASONING_MIN_OUTPUT_TOKENS };
}

function anthropicProfile(m: string): ReasoningProfile {
  if (/fable|mythos/.test(m)) {
    return { effort: 'output_config', minOutputTokens: ANTHROPIC_THINKING_MIN_OUTPUT_TOKENS };
  }
  // claude-<family>-<major>[-<minor>], ignoring a trailing date snapshot
  // (claude-sonnet-4-20250514 is 4.0, not 4.20250514).
  const v = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(m);
  if (v && v[1] !== 'haiku') {
    const major = Number(v[2]);
    const minor = Number(v[3] ?? 0);
    if (major > 4 || (major === 4 && minor >= 6)) {
      return { effort: 'output_config', minOutputTokens: ANTHROPIC_THINKING_MIN_OUTPUT_TOKENS };
    }
  }
  // Haiku 4.5 and the pre-4.6 models return a 400 for output_config.effort;
  // without `thinking` they don't think, so they only need answer room.
  return { effort: null, minOutputTokens: ANTHROPIC_PLAIN_MIN_OUTPUT_TOKENS };
}
