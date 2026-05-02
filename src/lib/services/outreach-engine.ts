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
 * AI-mode generation. Builds a structured prompt, calls the provider, and
 * runs forbidden-phrase stripping on the output. Provider failures bubble
 * up — the service layer decides whether to fall back to rules.
 */
export async function composeAiDraft(
  record: DraftableRecord,
  product: ProductProfile,
  lessons: ReadonlyArray<LearningLesson>,
  ctx: DraftContext,
  ai: IAIProvider,
): Promise<DraftVerdict> {
  const prompt = buildAiPrompt(record, product, lessons, ctx);
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

  // Outreach instructions if provided — render as a follow-up sentence.
  if (product.outreachInstructions) {
    parts.push(product.outreachInstructions.trim());
    parts.push('');
  }

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
): AiPrompt {
  const lessonLines = lessons
    .map((l, i) => `${i + 1}. [${l.category}] ${l.rule}`)
    .join('\n');

  const forbiddenLines =
    product.forbiddenPhrases.length > 0
      ? `Forbidden phrases (NEVER include any of these, in any form):\n${product.forbiddenPhrases.map((p) => `- ${p}`).join('\n')}`
      : '';

  const system = [
    `You are an outreach assistant drafting a ${ctx.channel} in ${ctx.language || product.language || 'en'}.`,
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

  const user = [
    `Lead context:`,
    record.title ? `- Title: ${record.title}` : '',
    record.domain ? `- Domain: ${record.domain}` : '',
    record.url ? `- URL: ${record.url}` : '',
    record.snippet ? `- Snippet: ${record.snippet}` : '',
    '',
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

  // Stable mock seed: prompt-bound + product id so identical inputs yield
  // identical mock output across test runs.
  const mockSeed = `outreach:${product.id}:${record.url ?? record.domain ?? 'noref'}`;

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
