// Usage kinds: every usage_log.kind the metering layer writes (DS-09,
// ia:F-11), and the key sources a usage row's payload names.
//
// recordUsage() types `kind` to UsageKind, and the AI provider factories
// (getAIProviderForCtx / getAIProviderById) type their metering kind to
// AiUsageKind, so a new metered call cannot invent a kind without a
// typecheck failure. src/lib/ui/labels.ts gives each kind the label the
// Usage page shows (for example ai.assistant reads "Assistant questions");
// src/tests/signals.test.ts cross-checks the lists and the demo seed.
// Kinds are neutral. Append-only, like the audit kinds: a retired kind
// moves to LEGACY_USAGE_KINDS. Pure module (no imports).

/** Metering kinds of the AI provider wrapper (src/lib/ai/index.ts). */
export const AI_USAGE_KINDS = [
  /** The default: any AI call that names no purpose. */
  'ai.generate',
  'ai.qualification',
  'ai.outreach',
  'ai.suggestion',
  'ai.assistant',
  'ai.learning_extract',
  'ai.learning_synthesis',
  'ai.health_check',
  'ai.signature_redesign',
] as const;

export type AiUsageKind = (typeof AI_USAGE_KINDS)[number];

export const USAGE_KINDS = [
  ...AI_USAGE_KINDS,
  /** connectors/internet-search.ts: one search-provider query. */
  'search.query',
  /** lead-research.ts: one grounded research call. */
  'research.query',
  /** embeddings/index.ts: one embedding batch. */
  'embedding.embed',
  /** rag.ts: OCR of a scanned PDF. */
  'ocr.pdf',
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

/** Kinds rows may still carry but nothing writes any more (none yet). */
export const LEGACY_USAGE_KINDS = [] as const satisfies ReadonlyArray<string>;

export type LegacyUsageKind = (typeof LEGACY_USAGE_KINDS)[number];

export type LabelledUsageKind = UsageKind | LegacyUsageKind;

const KNOWN: ReadonlySet<string> = new Set<string>([...USAGE_KINDS, ...LEGACY_USAGE_KINDS]);

export function isLabelledUsageKind(kind: string): kind is LabelledUsageKind {
  return KNOWN.has(kind);
}

/**
 * Whose API key paid for a metered call (`payload.keySource`): the
 * workspace's own key (the vendor bills them; no tokens charged), the
 * platform's key (charged in tokens) or the mock provider (no cost).
 */
export const USAGE_KEY_SOURCES = ['workspace', 'platform', 'mock'] as const;

export type UsageKeySource = (typeof USAGE_KEY_SOURCES)[number];
