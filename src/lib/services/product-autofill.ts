// Phase 49: product profile autofill from website + PDFs.
//
// The operator pastes a product / company URL and optionally uploads
// TDS or spec PDFs. We fetch the URL via a plain HTTP GET, extract
// readable text from the HTML using cheerio, parse text out of every
// PDF, then ask the workspace's active AI provider to synthesize a
// structured ProductProfile draft (active=false) for human review.
//
// Limits intentionally kept generous so a long product page or a
// 30-page datasheet aren't truncated to junk; the AI call is bounded
// by total input size (~64 KB).

import { load as loadHtml, type CheerioAPI } from 'cheerio';
import { z } from 'zod';
import { getAIProviderForCtx } from '@/lib/ai';
import {
  detectLanguageFromText,
  isKnownLanguage,
} from '@/lib/i18n/language';
import { recordAuditEvent } from './audit';
import { canWrite, type WorkspaceContext } from './context';
import {
  createProductProfile,
  type CreateProductProfileInput,
} from './product-profile';
import type { ProductProfile } from '@/lib/db/schema/products';

export class ProductAutofillError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ProductAutofillError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new ProductAutofillError(`Permission denied: ${op}`, 'permission_denied');
const invalid = (msg: string) => new ProductAutofillError(msg, 'invalid_input');

const MAX_HTML_BYTES = 1_500_000; // ~1.5 MB raw HTML — generous for marketing sites
const MAX_TEXT_PER_SOURCE = 24_000;
const MAX_TOTAL_TEXT = 64_000;
const FETCH_TIMEOUT_MS = 30_000;

// ─── Source extraction ──────────────────────────────────────────────

export interface ExtractedSource {
  kind: 'website' | 'pdf';
  label: string;
  /** Cleaned plain text. Truncated to MAX_TEXT_PER_SOURCE. */
  text: string;
  /** Original byte size before extraction (for debug / cost estimation). */
  originalBytes: number;
}

/**
 * Fetch a URL and pull out readable text. Static fetch only — SPAs
 * that render client-side will return mostly-empty text and the AI
 * call will degrade gracefully. We ask the AI to flag this so the
 * operator knows to fill the form by hand.
 */
export async function fetchAndExtractWebsite(
  rawUrl: string,
): Promise<ExtractedSource> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw invalid('not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalid('only http(s) URLs are supported');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  let originalBytes = 0;
  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      headers: {
        // Identify ourselves so the operator can spot us in their
        // server logs if something blocks us.
        'user-agent':
          'lead-discovery-platform/autofill (+https://discover.nulife.pl)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new ProductAutofillError(
        `fetch failed: ${res.status} ${res.statusText}`,
        'fetch_failed',
      );
    }
    const buf = await res.arrayBuffer();
    originalBytes = buf.byteLength;
    if (originalBytes > MAX_HTML_BYTES) {
      throw new ProductAutofillError(
        `page exceeds ${MAX_HTML_BYTES} bytes (got ${originalBytes})`,
        'too_large',
      );
    }
    html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } finally {
    clearTimeout(timer);
  }

  const text = extractReadableText(html);
  return {
    kind: 'website',
    label: parsed.toString(),
    text: clipText(text, MAX_TEXT_PER_SOURCE),
    originalBytes,
  };
}

/**
 * cheerio-based readable-text extractor. Strips chrome (script, style,
 * navigation, header, footer, aside, forms), then tries every plausible
 * content scope (`<main>`, `[role=main]`, `<article>`, `<body>`) and
 * returns the LONGEST cleaned result.
 *
 * Why longest-wins: many templated sites ship an empty `<main>` and
 * render the product detail client-side, while the actual content
 * lives elsewhere (e.g. inside `<article>` blocks or directly under
 * `<body>` when the template is server-rendered). The previous "first
 * match wins" logic locked onto an empty `<main>` and returned ~0
 * useful characters even when the page had several KB of extractable
 * text further down the tree.
 */
function extractReadableText(html: string): string {
  const $: CheerioAPI = loadHtml(html);
  $(
    'script, style, noscript, svg, iframe, header, footer, nav, aside, form, [role="navigation"]',
  ).remove();
  const candidates: string[] = [];
  const collect = (sel: string) => {
    const matches = $(sel);
    if (matches.length === 0) return;
    // Concatenate every match, not just .first(), so multi-section
    // product pages aren't truncated to the first card.
    const joined = matches
      .map((_, el) => $(el).text())
      .get()
      .join('\n');
    candidates.push(cleanText(joined));
  };
  collect('main');
  collect('[role="main"]');
  collect('article');
  collect('body');
  candidates.push(cleanText($.root().text()));
  return candidates.reduce(
    (best, t) => (t.length > best.length ? t : best),
    '',
  );
}

function cleanText(t: string): string {
  return t
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Extract text out of a PDF buffer. Throws on encrypted PDFs.
 *  Imported lazily so the page route doesn't pay the pdf-parse +
 *  pdfjs-dist init cost on URL-only autofill calls. */
export async function extractFromPdf(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedSource> {
  // pdf-parse v1 has a long-standing bug where its `index.js` runs a
  // debug self-test that tries to open ./test/data/05-versions-space.pdf
  // when the module is loaded outside a parent module. Importing the
  // inner library file directly skips that entry point. Dynamic import
  // also keeps pdf-parse out of the page module load chain so URL-only
  // autofill never touches it.
  // @ts-expect-error pdf-parse v1 has no .d.ts for the inner path; we
  // hand-type the surface we use.
  const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
    default: (buffer: Buffer) => Promise<{ text: string }>;
  };
  let raw = '';
  try {
    const result = await mod.default(buffer);
    raw = result.text ?? '';
  } catch (err) {
    throw new ProductAutofillError(
      `pdf parse failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      'pdf_parse_failed',
    );
  }
  const text = raw
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    kind: 'pdf',
    label: filename,
    text: clipText(text, MAX_TEXT_PER_SOURCE),
    originalBytes: buffer.byteLength,
  };
}

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... truncated ${text.length - max} chars ...]`;
}

// ─── AI synthesis ───────────────────────────────────────────────────

// Schema covers EVERY field that exists on a product profile in the
// DB. Optional/nullable for resilience against sparse sources, but the
// SYSTEM_PROMPT below pushes the model to populate everything it has
// any reasonable signal for. A null is reserved for fields where the
// source genuinely contains zero signal — not as a default escape.
const SynthesizedProfileSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  shortDescription: z.string().max(500).nullable().optional(),
  fullDescription: z.string().max(5000).nullable().optional(),
  targetCustomerTypes: z.array(z.string()).max(20).optional(),
  targetSectors: z.array(z.string()).max(20).optional(),
  targetProjectTypes: z.array(z.string()).max(20).optional(),
  includeKeywords: z.array(z.string()).max(40).optional(),
  excludeKeywords: z.array(z.string()).max(40).optional(),
  qualificationCriteria: z.string().max(2000).nullable().optional(),
  disqualificationCriteria: z.string().max(2000).nullable().optional(),
  relevanceThreshold: z.number().int().min(0).max(100).optional(),
  outreachInstructions: z.string().max(2000).nullable().optional(),
  negativeOutreachInstructions: z.string().max(2000).nullable().optional(),
  forbiddenPhrases: z.array(z.string()).max(20).optional(),
  language: z.string().min(2).max(10).optional(),
  /** Honest signal about how confident the model is in the output. */
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  /** Free-form note for the operator — flag SPA / paywall / weird sources. */
  notes: z.string().max(1000).optional(),
});

/** Output of `synthesizeProfile`. Stricter than the AI's raw response —
 *  the orchestrator fills in defaults so callers don't have to handle
 *  `undefined` everywhere. */
export interface SynthesizedProfile {
  name: string;
  shortDescription: string | null;
  fullDescription: string | null;
  targetCustomerTypes: string[];
  targetSectors: string[];
  targetProjectTypes: string[];
  includeKeywords: string[];
  excludeKeywords: string[];
  qualificationCriteria: string | null;
  disqualificationCriteria: string | null;
  relevanceThreshold: number;
  outreachInstructions: string | null;
  negativeOutreachInstructions: string | null;
  forbiddenPhrases: string[];
  language: string;
  confidence: 'high' | 'medium' | 'low';
  notes?: string;
}

const SYSTEM_PROMPT = `
You are a senior B2B product analyst. The operator has handed you raw
source material about a product (a marketing webpage and/or technical
datasheets / brochures as PDFs). Your output drives a downstream lead
discovery pipeline:

  1. discovery — includeKeywords/excludeKeywords feed Google search
     queries that find candidate companies.
  2. qualification — qualificationCriteria + disqualificationCriteria +
     relevanceThreshold feed an AI scorer that decides whether each
     candidate company is worth pursuing (0-100).
  3. outreach — fullDescription + outreachInstructions +
     negativeOutreachInstructions + forbiddenPhrases feed a draft-
     writer that produces the first cold email.

So every field downstream is consumed by code; sparse output produces
bad search queries, bad qualification, and bad emails. Your job is to
populate EVERY field for which the source contains ANY signal. A field
should be null/empty ONLY when the source has zero relevant content
for it — not as a default. When in doubt, infer from context.

Field-by-field guidance:

- name (string): canonical product name as branded. NOT the company
  name unless the product is the company's headline offering. If a
  PDF datasheet titles the product clearly, prefer that. Required.
- shortDescription (string): one sentence, ≤30 words, plain language,
  in the source's language.
- fullDescription (string): 2–5 sentences. What it is, who it's for,
  what problem it solves, key technical or commercial differentiators.
- targetCustomerTypes (string[]): who buys it. Roles or company
  archetypes. Examples: ["construction GCs", "MEP contractors",
  "real estate developers", "facility managers"].
- targetSectors (string[]): industry sectors. Examples: ["commercial
  construction", "residential", "infrastructure", "industrial real
  estate"].
- targetProjectTypes (string[]): kinds of projects where the product
  is used. Examples: ["foundation slabs", "underground parking",
  "civil tunnels", "high-rise cores"].
- includeKeywords (string[]): 8-20 lowercase phrases (1-3 words each)
  that should appear in a relevant lead's site/description. Mix of
  product names, project terms, sector terms. No duplicates.
- excludeKeywords (string[]): 3-15 lowercase phrases that signal a
  WRONG fit (industry-adjacent but the wrong buyer). Examples for a
  concrete-additive: ["dry-mix mortar", "DIY", "consumer", "homeowner"].
  Empty array only if you genuinely cannot think of any.
- qualificationCriteria (string): bullet-style list of yes/no
  questions a human would ask: "Is the company's project pipeline
  ≥X size?", "Do they self-perform structural concrete?", etc. Aim
  for 4-8 bullets.
- disqualificationCriteria (string): bullet-style list of red flags
  that should drop a lead even if other criteria look good. Examples:
  "company sells the same product (competitor)", "company is a
  consumer / DIY brand", "company has no public construction
  project pipeline". Aim for 3-6 bullets.
- relevanceThreshold (integer 0-100, default 50): the cutoff for an
  AI relevance score below which leads should NOT be drafted. 50 is
  a sane default; raise to 65-70 for niche products with a clear
  ICP, lower to 35-40 for broad horizontal products.
- outreachInstructions (string): tone + angle for first-touch email.
  E.g. "Open with a project-specific hook based on a recent permit
  or news mention. Lead with the technical differentiator, not the
  brand. Avoid superlatives. Polish, max 120 words."
- negativeOutreachInstructions (string): explicit DON'Ts for the
  draft-writer. E.g. "Don't claim partnerships we don't have. Don't
  use 'revolutionary' / 'game-changing'. Don't pitch features the
  buyer can't measure."
- forbiddenPhrases (string[]): 3-10 exact phrases that must never
  appear in a draft. Examples: ["best-in-class", "synergies",
  "cutting-edge"]. Includes any over-claims specific to this product.
- language (ISO 639-1, default "en"): the SOURCE material's dominant
  language. "en" / "pl" / "de" / "fr" / "es" / etc. If bilingual,
  pick the language of the product description, not the chrome.
- confidence: "high" when the source was rich (full marketing page +
  datasheet, several KB of clear text); "medium" when you inferred
  some fields; "low" when the source was mostly empty (SPA shell,
  paywall, scanned-image PDF that yielded no text).
- notes: short message for the operator. Flag specific gaps —
  "no datasheet provided, technical fields are inferred from the
  marketing page only", or "page appears client-rendered; only
  the homepage hero was extractable".

Output format: a single JSON object. No prose, no code fence, no
preamble.
`.trim();

export interface SynthesizeProfileInput {
  sources: ReadonlyArray<ExtractedSource>;
}

/**
 * One AI call → structured profile. Caller decides whether to persist.
 */
export async function synthesizeProfile(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  input: SynthesizeProfileInput,
): Promise<SynthesizedProfile> {
  const filtered = input.sources.filter((s) => s.text.trim().length > 0);
  if (filtered.length === 0) throw invalid('no usable text in any source');

  // Apply a global budget by trimming each source proportionally when
  // their combined length blows past MAX_TOTAL_TEXT.
  const totalLen = filtered.reduce((a, s) => a + s.text.length, 0);
  const sources: ExtractedSource[] =
    totalLen > MAX_TOTAL_TEXT
      ? filtered.map((s) => ({
          ...s,
          text: clipText(
            s.text,
            Math.max(2_000, Math.floor((s.text.length / totalLen) * MAX_TOTAL_TEXT)),
          ),
        }))
      : filtered;

  const userPrompt = sources
    .map(
      (s, i) =>
        `Source ${i + 1} — ${s.kind} (${s.label}):\n${clipText(s.text, MAX_TEXT_PER_SOURCE)}`,
    )
    .join('\n\n---\n\n');

  const provider = await getAIProviderForCtx(ctx);
  const parsed = await provider.generateJson(
    { system: SYSTEM_PROMPT, prompt: userPrompt },
    SynthesizedProfileSchema,
    // 8192 tokens leaves headroom for ~14 populated fields with rich
    // text. Override the model: small/cheap models (Haiku, gpt-4o-mini)
    // treat all-optional schemas as "you may skip everything" and
    // routinely return 1-2 fields out of 14 even with strong prompting.
    // Sonnet / gpt-4o respect the populate-everything instruction.
    // Lower temperature for determinism — autofill is a structured
    // extraction task, not creative writing.
    {
      maxTokens: 8192,
      temperature: 0.2,
      model: pickAutofillModel(provider.id, provider.model),
    },
  );

  // Post-parse sparseness check. Even with the strong prompt + Sonnet,
  // the model can occasionally return a thin response. Count the
  // populated fields and bail with a clear retry hint when too few
  // came back, so the operator sees a real error instead of a
  // mostly-empty draft they'll then have to delete.
  const populated = countPopulated(parsed);
  if (populated < 6) {
    throw new ProductAutofillError(
      `AI returned only ${populated}/14 fields populated. Retry the autofill — the model was unusually sparse on this run. If it persists, check the source has enough product detail (extracted ${
        sources.reduce((a, s) => a + s.text.length, 0)
      } chars total).`,
      'sparse_response',
    );
  }

  // Belt-and-braces language sanity check.
  const langGuess =
    parsed.language && isKnownLanguage(parsed.language)
      ? parsed.language
      : detectLanguageFromText(sources[0]?.text ?? '') ?? 'en';

  // Name fallback: AI may omit `name` when the source is sparse (SPA
  // shell, paywall, image-only PDF). Derive something usable from the
  // source labels so the operator gets a draft they can rename rather
  // than a hard error after paying for the AI call.
  const name = (parsed.name ?? '').trim() || deriveNameFromSources(sources);

  // Zod's optional fields infer as `T | undefined`; flatten to the
  // SynthesizedProfile shape with concrete defaults.
  return {
    name,
    shortDescription: parsed.shortDescription ?? null,
    fullDescription: parsed.fullDescription ?? null,
    targetCustomerTypes: parsed.targetCustomerTypes ?? [],
    targetSectors: parsed.targetSectors ?? [],
    targetProjectTypes: parsed.targetProjectTypes ?? [],
    includeKeywords: parsed.includeKeywords ?? [],
    excludeKeywords: parsed.excludeKeywords ?? [],
    qualificationCriteria: parsed.qualificationCriteria ?? null,
    disqualificationCriteria: parsed.disqualificationCriteria ?? null,
    relevanceThreshold: parsed.relevanceThreshold ?? 50,
    outreachInstructions: parsed.outreachInstructions ?? null,
    negativeOutreachInstructions: parsed.negativeOutreachInstructions ?? null,
    forbiddenPhrases: parsed.forbiddenPhrases ?? [],
    language: langGuess,
    confidence: parsed.confidence ?? 'medium',
    notes: parsed.notes,
  };
}

/** Pick the right model for autofill based on the active provider.
 *  Workspace defaults are tuned for cost (Haiku, gpt-4o-mini) and
 *  produce sparse autofill output. Bump to the dense-output tier just
 *  for this call. Other features (qualification, drafts, translation)
 *  keep the workspace default. */
function pickAutofillModel(
  providerId: string,
  workspaceDefault: string,
): string | undefined {
  if (providerId === 'anthropic') {
    // Already on a strong model? Keep it.
    if (workspaceDefault.toLowerCase().includes('opus')) return undefined;
    if (workspaceDefault.toLowerCase().includes('sonnet')) return undefined;
    return 'claude-sonnet-4-6';
  }
  if (providerId === 'openai') {
    if (workspaceDefault === 'gpt-4o' || workspaceDefault.startsWith('gpt-5')) {
      return undefined;
    }
    return 'gpt-4o';
  }
  // Unknown provider — let the workspace default ride.
  return undefined;
}

/** Count the fields the AI actually populated. Strings: non-null and
 *  non-empty after trim. Arrays: at least one entry. Used to detect
 *  Haiku-style "skip everything" responses. */
function countPopulated(p: z.infer<typeof SynthesizedProfileSchema>): number {
  let n = 0;
  if (p.name && p.name.trim()) n++;
  if (p.shortDescription && p.shortDescription.trim()) n++;
  if (p.fullDescription && p.fullDescription.trim()) n++;
  if (p.targetCustomerTypes && p.targetCustomerTypes.length > 0) n++;
  if (p.targetSectors && p.targetSectors.length > 0) n++;
  if (p.targetProjectTypes && p.targetProjectTypes.length > 0) n++;
  if (p.includeKeywords && p.includeKeywords.length > 0) n++;
  if (p.excludeKeywords && p.excludeKeywords.length > 0) n++;
  if (p.qualificationCriteria && p.qualificationCriteria.trim()) n++;
  if (p.disqualificationCriteria && p.disqualificationCriteria.trim()) n++;
  if (typeof p.relevanceThreshold === 'number') n++;
  if (p.outreachInstructions && p.outreachInstructions.trim()) n++;
  if (p.negativeOutreachInstructions && p.negativeOutreachInstructions.trim()) n++;
  if (p.forbiddenPhrases && p.forbiddenPhrases.length > 0) n++;
  return n;
}

/** Best-effort fallback when the AI omits `name`. Tries (1) the
 *  hostname of the website source's URL, (2) the first PDF filename
 *  with the .pdf extension stripped, (3) a generic "Imported product"
 *  marker. The operator is expected to rename on review. */
function deriveNameFromSources(
  sources: ReadonlyArray<ExtractedSource>,
): string {
  const website = sources.find((s) => s.kind === 'website');
  if (website) {
    try {
      const host = new URL(website.label).hostname.replace(/^www\./, '');
      if (host) return host;
    } catch {
      // ignore — fall through to PDF
    }
  }
  const pdf = sources.find((s) => s.kind === 'pdf');
  if (pdf) {
    return pdf.label.replace(/\.pdf$/i, '').replace(/[._-]+/g, ' ').trim() ||
      'Imported product';
  }
  return 'Imported product';
}

// ─── End-to-end orchestrator ─────────────────────────────────────────

export interface AutofillFromSourcesInput {
  url?: string | null;
  pdfs?: Array<{ filename: string; buffer: Buffer }>;
}

export interface AutofillFromSourcesResult {
  profile: ProductProfile;
  synthesized: SynthesizedProfile;
  sources: ExtractedSource[];
}

/**
 * High-level: given a URL and/or PDFs, extract → synthesize → persist
 * an inactive draft product profile + audit-log the run.
 */
export async function autofillProductProfileFromSources(
  ctx: WorkspaceContext,
  input: AutofillFromSourcesInput,
): Promise<AutofillFromSourcesResult> {
  if (!canWrite(ctx)) throw denied('product_autofill.run');
  const url = input.url?.trim();
  const pdfs = input.pdfs ?? [];
  if (!url && pdfs.length === 0) {
    throw invalid('provide at least one URL or one PDF');
  }

  const sources: ExtractedSource[] = [];
  if (url) sources.push(await fetchAndExtractWebsite(url));
  for (const pdf of pdfs) {
    sources.push(await extractFromPdf(pdf.buffer, pdf.filename));
  }

  const synth = await synthesizeProfile(ctx, { sources });

  // Persist as inactive — operator reviews + activates after sanity
  // check on /products/[id].
  const createInput: CreateProductProfileInput = {
    name: synth.name,
    shortDescription: synth.shortDescription ?? null,
    fullDescription: synth.fullDescription ?? null,
    targetCustomerTypes: synth.targetCustomerTypes,
    targetSectors: synth.targetSectors,
    targetProjectTypes: synth.targetProjectTypes,
    includeKeywords: synth.includeKeywords,
    excludeKeywords: synth.excludeKeywords,
    qualificationCriteria: synth.qualificationCriteria ?? null,
    disqualificationCriteria: synth.disqualificationCriteria ?? null,
    relevanceThreshold: synth.relevanceThreshold,
    outreachInstructions: synth.outreachInstructions ?? null,
    negativeOutreachInstructions: synth.negativeOutreachInstructions ?? null,
    forbiddenPhrases: synth.forbiddenPhrases,
    language: synth.language ?? 'en',
  };
  const profile = await createProductProfile(ctx, createInput);

  await recordAuditEvent(ctx, {
    kind: 'product_profile.autofill',
    entityType: 'product_profile',
    entityId: profile.id,
    payload: {
      sourceCount: sources.length,
      url: url ?? null,
      pdfFilenames: pdfs.map((p) => p.filename),
      confidence: synth.confidence,
      notes: synth.notes ?? null,
    },
  });

  return { profile, synthesized: synth, sources };
}
