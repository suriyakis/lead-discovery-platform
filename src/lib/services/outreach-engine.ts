// Pure outreach draft engine.
//
// Two modes:
//   rules:  deterministic template assembled from product fields + record
//           + learning lesson reminders. No I/O, fully testable.
//   ai:     calls IAIProvider with a structured prompt; the engine still
//           runs forbidden-phrase stripping on the output so a misbehaving
//           provider can't smuggle banned phrases past us.
//
// The DB-backed service wraps both with persistence + audit.

import type { ProductProfile } from '@/lib/db/schema/products';
import type { LearningLesson } from '@/lib/db/schema/learning';
import type { OutreachDraftMethod } from '@/lib/db/schema/outreach';
import type { IAIProvider } from '@/lib/ai';
import { getLanguageName, resolveProfileLanguage } from '@/lib/i18n/language';

export interface DraftableRecord {
  title?: string | null;
  snippet?: string | null;
  url?: string | null;
  domain?: string | null;
  body?: string | null;
}

export interface DraftContext {
  channel: string;
  language: string;
}

export interface DraftEvidence {
  promptSystem?: string;
  promptUser?: string;
  matchedLessonIds: bigint[];
  fields: {
    productName: string;
    productLanguage: string;
    recordDomain: string | null;
    recordUrl: string | null;
  };
}

export interface DraftVerdict {
  subject: string | null;
  body: string;
  /** 0..100. Engine self-confidence. */
  confidence: number;
  method: OutreachDraftMethod;
  model: string | null;
  evidence: DraftEvidence;
  /** Forbidden phrases stripped from the output. Empty when clean. */
  forbiddenStripped: string[];
  matchedLessonIds: bigint[];
}

const DEFAULT_GREETING = 'Hello,';
const DEFAULT_SIGNOFF = 'Best regards,';

/**
 * Rules-mode generation. Composes a deterministic template from the
 * product fields + record + lesson hints. Always succeeds; never calls
 * external services. Phase 8's default path.
 */
export function composeRulesDraft(
  record: DraftableRecord,
  product: ProductProfile,
  lessons: ReadonlyArray<LearningLesson>,
  ctx: DraftContext,
): DraftVerdict {
  const recordTitle = (record.title ?? '').trim();
  const recordDomain = (record.domain ?? null);
  const recordUrl = (record.url ?? null);

  const subject = buildSubject(product, recordTitle);
  const matchedLessonIds = lessons.map((l) => l.id);

  const body = buildRulesBody(product, recordTitle, recordDomain, lessons, ctx);
  const stripped = stripForbidden(body, product.forbiddenPhrases);

  // Confidence rises with evidence (non-empty record context, lesson hits).
  const signals =
    (recordTitle ? 1 : 0) +
    (recordDomain ? 1 : 0) +
    (product.outreachInstructions ? 1 : 0) +
    Math.min(lessons.length, 3);
  const confidence = clamp(40 + signals * 8, 30, 90);

  return {
    subject,
    body: stripped.text,
    confidence,
    method: 'rules',
    model: null,
    evidence: {
      promptSystem: undefined,
      promptUser: undefined,
      matchedLessonIds,
      fields: {
        productName: product.name,
        productLanguage: product.language,
        recordDomain,
        recordUrl,
      },
    },
    forbiddenStripped: stripped.removed,
    matchedLessonIds,
  };
}

/**
 * Phase A — discovery-stage email. The first cold message in a new
 * outreach thread. Goal: identify the right contact, NOT pitch the
 * product. The body is short (~60 words), framed as a polite ask
 * ("who handles X for your team?") and references something concrete
 * about the lead (their domain or project title) so it doesn't read
 * as scraped spam.
 *
 * Crucially the AI receives only the product CATEGORY signals
 * (sectors, project types, customer types) — NOT the full product
 * description — so it cannot lapse into pitching. Pitch is a separate
 * stage that runs later, only when the recipient asks for detail.
 */
export async function composeDiscoveryDraft(
  record: DraftableRecord,
  product: ProductProfile,
  ctx: DraftContext,
  ai: IAIProvider,
): Promise<DraftVerdict> {
  const prompt = buildDiscoveryPrompt(record, product, ctx);
  const result = await ai.generateText(
    { system: prompt.system, prompt: prompt.user },
    { mockSeed: prompt.mockSeed, temperature: 0.6 },
  );

  const subject = buildDiscoverySubject(product, (record.title ?? '').trim());
  const body = result.text.trim();
  const stripped = stripForbidden(body, product.forbiddenPhrases);

  return {
    subject,
    body: stripped.text,
    confidence: clamp(70 - stripped.removed.length * 10, 30, 95),
    method: 'ai',
    model: result.model,
    evidence: {
      promptSystem: prompt.system,
      promptUser: prompt.user,
      matchedLessonIds: [],
      fields: {
        productName: product.name,
        productLanguage: product.language,
        recordDomain: record.domain ?? null,
        recordUrl: record.url ?? null,
      },
    },
    forbiddenStripped: stripped.removed,
    matchedLessonIds: [],
  };
}

function buildDiscoverySubject(product: ProductProfile, recordTitle: string): string {
  // Discovery subjects ask for routing, not engagement with the product.
  // Pivot on what the lead does (recordTitle) rather than the product name.
  if (recordTitle) {
    const trimmed = recordTitle.length > 50 ? `${recordTitle.slice(0, 49)}…` : recordTitle;
    return `Who handles ${productCategoryLabel(product)} re: ${trimmed}?`;
  }
  return `Who handles ${productCategoryLabel(product)} on your team?`;
}

function productCategoryLabel(product: ProductProfile): string {
  // A short label the model can route on. Sectors/project types are
  // generally more recognizable to the recipient than the product name.
  const sectors = product.targetSectors[0];
  if (sectors) return sectors;
  const projects = product.targetProjectTypes[0];
  if (projects) return projects;
  return product.name;
}

interface DiscoveryPrompt {
  system: string;
  user: string;
  mockSeed: string;
}

function buildDiscoveryPrompt(
  record: DraftableRecord,
  product: ProductProfile,
  ctx: DraftContext,
): DiscoveryPrompt {
  const effectiveLang =
    (ctx.language && ctx.language.trim()) || resolveProfileLanguage(product);
  const langName = getLanguageName(effectiveLang);

  const forbiddenLines =
    product.forbiddenPhrases.length > 0
      ? `Forbidden phrases (NEVER include any of these): ${product.forbiddenPhrases.join(', ')}`
      : '';

  // Short, contained system prompt. The discovery email is intentionally
  // narrow — the model gets product CATEGORY signals only (sectors /
  // project types / customer types) so it cannot accidentally pitch.
  const system = [
    `You are an outreach assistant writing a SHORT FIRST email in ${langName} (${effectiveLang}).`,
    `Goal: identify the right person at the recipient's organization to talk to about a category of products. NOT to sell.`,
    `Hard rules:`,
    `- Maximum 60 words in the body. Concise wins.`,
    `- Do NOT describe the product. Do NOT name technical features. Do NOT claim benefits.`,
    `- Open with one sentence referencing what the recipient does (use the lead context).`,
    `- The single ask: "could you point me to the right person who handles X?".`,
    `- Polite, direct, no superlatives, no marketing language.`,
    `- Sign off with "Best regards," (no name — the sender layer fills it).`,
    forbiddenLines,
    `Output only the message body. No subject line.`,
  ]
    .filter(Boolean)
    .join('\n');

  const user = [
    `Lead context:`,
    record.title ? `- What they do / project title: ${record.title}` : '',
    record.domain ? `- Domain: ${record.domain}` : '',
    record.snippet ? `- Snippet: ${record.snippet}` : '',
    '',
    `Product category (USE for routing only — do NOT pitch any of this):`,
    product.targetSectors.length > 0
      ? `- Sectors: ${product.targetSectors.join(', ')}`
      : '',
    product.targetProjectTypes.length > 0
      ? `- Project types: ${product.targetProjectTypes.join(', ')}`
      : '',
    product.targetCustomerTypes.length > 0
      ? `- Buyer roles: ${product.targetCustomerTypes.join(', ')}`
      : '',
    '',
    `Write the discovery email body now.`,
  ]
    .filter(Boolean)
    .join('\n');

  const mockSeed = `discovery:${product.id}:${record.url ?? record.domain ?? 'noref'}`;
  return { system, user, mockSeed };
}

/**
 * AI-mode generation. Builds a structured prompt, calls the provider, and
 * runs forbidden-phrase stripping on the output. Provider failures bubble
 * up — the service layer decides whether to fall back to rules.
 *
 * Phase 46: optional `researchContext` is injected into the prompt as a
 * "Research context" block above the lead/product context, so the model
 * can reference grounded facts about the recipient (recent news,
 * positioning, decision makers) instead of generic openings.
 */
export async function composeAiDraft(
  record: DraftableRecord,
  product: ProductProfile,
  lessons: ReadonlyArray<LearningLesson>,
  ctx: DraftContext,
  ai: IAIProvider,
  researchContext?: string | null,
): Promise<DraftVerdict> {
  const prompt = buildAiPrompt(record, product, lessons, ctx, researchContext ?? null);
  const result = await ai.generateText(
    { system: prompt.system, prompt: prompt.user },
    { mockSeed: prompt.mockSeed, temperature: 0.7 },
  );

  const subject = buildSubject(product, (record.title ?? '').trim());
  const body = result.text.trim();
  const stripped = stripForbidden(body, product.forbiddenPhrases);

  const matchedLessonIds = lessons.map((l) => l.id);
  // AI confidence baseline higher than rules; nudged down per stripped phrase.
  const confidence = clamp(60 - stripped.removed.length * 10, 30, 95);

  return {
    subject,
    body: stripped.text,
    confidence,
    method: 'ai',
    model: result.model,
    evidence: {
      promptSystem: prompt.system,
      promptUser: prompt.user,
      matchedLessonIds,
      fields: {
        productName: product.name,
        productLanguage: product.language,
        recordDomain: record.domain ?? null,
        recordUrl: record.url ?? null,
      },
    },
    forbiddenStripped: stripped.removed,
    matchedLessonIds,
  };
}

// ---- helpers --------------------------------------------------------

function buildSubject(product: ProductProfile, recordTitle: string): string {
  if (recordTitle) {
    const trimmed = recordTitle.length > 60 ? `${recordTitle.slice(0, 59)}…` : recordTitle;
    return `${product.name}: re ${trimmed}`;
  }
  return `${product.name}: introduction`;
}

function buildRulesBody(
  product: ProductProfile,
  recordTitle: string,
  recordDomain: string | null,
  lessons: ReadonlyArray<LearningLesson>,
  ctx: DraftContext,
): string {
  void ctx; // language/channel honored by caller's downstream rendering
  const parts: string[] = [];
  parts.push(DEFAULT_GREETING);
  parts.push('');

  // Lead context — referencing what was found.
  if (recordTitle) {
    const ref = recordDomain ? ` on ${recordDomain}` : '';
    parts.push(`I came across "${recordTitle}"${ref} and thought it might be worth a short conversation.`);
  } else if (recordDomain) {
    parts.push(`I came across ${recordDomain} and thought it might be worth a short conversation.`);
  } else {
    parts.push('I came across your work and thought it might be worth a short conversation.');
  }
  parts.push('');

  // Product positioning.
  if (product.shortDescription) {
    parts.push(product.shortDescription.trim());
    parts.push('');
  } else if (product.fullDescription) {
    const trimmed = product.fullDescription.trim();
    parts.push(trimmed.length > 400 ? `${trimmed.slice(0, 397)}…` : trimmed);
    parts.push('');
  }

  // Don't interpolate product.outreachInstructions here — that field is
  // meta-guidance addressed to an AI ("Open with a project-specific
  // hook…", "Lead with the technical differentiator…"), NOT email body
  // text. Pasting it verbatim made the operator's first cold email
  // read like a brief to a copywriter. The AI mode (composeAiDraft)
  // uses these instructions correctly via the system prompt; the rules
  // mode simply has no way to follow them.

  // Lesson-derived nudges (outreach_style + product_positioning).
  const nudges = lessons
    .filter((l) =>
      l.category === 'outreach_style' ||
      l.category === 'product_positioning' ||
      l.category === 'contact_role',
    )
    .slice(0, 2)
    .map((l) => l.rule.trim())
    .filter(Boolean);
  if (nudges.length > 0) {
    parts.push(nudges.join(' '));
    parts.push('');
  }

  // Soft CTA. The Sending phase will personalize further.
  parts.push('Would a brief call next week make sense, or is there a better way to get in touch?');
  parts.push('');
  parts.push(DEFAULT_SIGNOFF);

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

interface AiPrompt {
  system: string;
  user: string;
  mockSeed: string;
}

function buildAiPrompt(
  record: DraftableRecord,
  product: ProductProfile,
  lessons: ReadonlyArray<LearningLesson>,
  ctx: DraftContext,
  researchContext: string | null,
): AiPrompt {
  const lessonLines = lessons
    .map((l, i) => `${i + 1}. [${l.category}] ${l.rule}`)
    .join('\n');

  const forbiddenLines =
    product.forbiddenPhrases.length > 0
      ? `Forbidden phrases (NEVER include any of these, in any form):\n${product.forbiddenPhrases.map((p) => `- ${p}`).join('\n')}`
      : '';

  // Prefer the caller's language when set, otherwise resolve via the
  // detector cascade (profile description text often beats the explicit
  // `language` field — see resolveProfileLanguage).
  const effectiveLang =
    (ctx.language && ctx.language.trim()) || resolveProfileLanguage(product);
  const langName = getLanguageName(effectiveLang);

  const system = [
    `You are an outreach assistant drafting a ${ctx.channel} in ${langName} (${effectiveLang}). Produce fluent, natural ${langName} that reads as if originally written in ${langName} — preserve any proper nouns and brand names verbatim.`,
    `You write for the product "${product.name}".`,
    product.outreachInstructions ? `Style guidance: ${product.outreachInstructions.trim()}` : '',
    product.negativeOutreachInstructions
      ? `Avoid: ${product.negativeOutreachInstructions.trim()}`
      : '',
    forbiddenLines,
    'Output only the message body. No subject, no greeting metadata.',
  ]
    .filter(Boolean)
    .join('\n');

  const researchBlock = researchContext
    ? `Research context (live web research about the recipient — use these facts to personalize the opener; cite at most one if natural, never as a footnote):\n${researchContext.trim()}\n`
    : '';

  const user = [
    `Lead context:`,
    record.title ? `- Title: ${record.title}` : '',
    record.domain ? `- Domain: ${record.domain}` : '',
    record.url ? `- URL: ${record.url}` : '',
    record.snippet ? `- Snippet: ${record.snippet}` : '',
    '',
    researchBlock,
    `Product:`,
    `- Name: ${product.name}`,
    product.shortDescription ? `- Short: ${product.shortDescription.trim()}` : '',
    product.fullDescription ? `- Full: ${product.fullDescription.trim()}` : '',
    product.targetSectors.length > 0
      ? `- Target sectors: ${product.targetSectors.join(', ')}`
      : '',
    '',
    lessonLines ? `Workspace guidelines (priority order):\n${lessonLines}` : '',
    '',
    'Compose a concise, professional outreach message.',
  ]
    .filter(Boolean)
    .join('\n');

  // Stable mock seed: prompt-bound + product id + research-context hash
  // so an enriched draft is deterministic per (product, record, research)
  // tuple in tests.
  const researchTag = researchContext ? `:r${researchContext.length}` : '';
  const mockSeed = `outreach:${product.id}:${record.url ?? record.domain ?? 'noref'}${researchTag}`;

  return { system, user, mockSeed };
}

interface StripResult {
  text: string;
  removed: string[];
}

function stripForbidden(text: string, phrases: ReadonlyArray<string>): StripResult {
  if (phrases.length === 0 || !text) return { text, removed: [] };
  let out = text;
  const removed: string[] = [];
  for (const raw of phrases) {
    const phrase = raw.trim();
    if (!phrase) continue;
    const re = new RegExp(escapeRegex(phrase), 'gi');
    if (re.test(out)) {
      removed.push(phrase);
      out = out.replace(re, '[redacted]');
    }
  }
  // Clean up double spaces / orphaned punctuation from substitutions.
  out = out.replace(/\s+\[redacted\]/g, ' [redacted]').replace(/[ \t]{2,}/g, ' ');
  return { text: out, removed };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
