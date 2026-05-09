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
 * cheerio-based readable-text extractor. Strips script / style /
 * navigation / footer / header chrome, joins remaining content with
 * newlines, collapses whitespace.
 */
function extractReadableText(html: string): string {
  const $: CheerioAPI = loadHtml(html);
  $('script, style, noscript, svg, iframe, header, footer, nav, form').remove();
  // Prefer <main> or [role=main] when available — far less noise.
  let scope = $('main').first();
  if (scope.length === 0) scope = $('[role="main"]').first();
  if (scope.length === 0) scope = $('article').first();
  if (scope.length === 0) scope = $('body');
  const text = scope
    .text()
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return text;
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

// Every field is tolerant — the AI is allowed to omit anything it
// can't extract honestly. The orchestrator derives sensible fallbacks
// (especially `name`, which never can be blank in the DB) so a sparse
// AI response still produces a useful draft.
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
  outreachInstructions: z.string().max(2000).nullable().optional(),
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
  outreachInstructions: string | null;
  language: string;
  confidence: 'high' | 'medium' | 'low';
  notes?: string;
}

const SYSTEM_PROMPT = `
You are a B2B product analyst. Given source material about a product
(typically a marketing webpage and/or technical datasheet PDFs),
extract a structured product profile that a sales operator will use
to drive lead discovery + qualification + outreach.

Rules:
- The "name" should be the canonical product name as branded — not the
  company name unless the product IS the company's headline offering.
- shortDescription: one sentence, ≤30 words, plain language.
- fullDescription: 2–5 sentences. What it is, who it's for, what
  problem it solves.
- targetCustomerTypes: who buys it (e.g. ["construction GCs",
  "MEP contractors", "real estate developers"]).
- targetSectors: industry sectors (e.g. ["commercial construction",
  "residential", "infrastructure"]).
- targetProjectTypes: kinds of projects (e.g. ["foundation slabs",
  "underground parking", "civil tunnels"]).
- includeKeywords: words/phrases that should appear in a relevant lead
  description. Lowercase, no duplicates.
- excludeKeywords: words/phrases that signal a NOT-fit (often industry
  adjacent but wrong). Empty array if none clear.
- qualificationCriteria: bullet-style list of criteria a human would
  use to decide "is this a real prospect?". May be left null.
- outreachInstructions: tone + angle suggestions for first-touch
  outreach. May be left null.
- language: ISO 639-1 of the SOURCE material — "en" / "pl" / "de" /
  etc. If the page is bilingual, pick the dominant language of the
  product description.
- confidence: "high" if the source is clear and rich; "medium" if you
  inferred some fields; "low" if the source was mostly empty (e.g.
  client-rendered SPA, paywall, broken link).
- notes: anything the operator should know — e.g. "page appears to be
  client-rendered; ran on minimal text" or "source is a competitor
  comparison page, not the product page itself".

Respond as a JSON object only. No prose, no code fence.
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
    // Autofill JSON can run 1.5–2k output tokens with rich source
    // material. Anthropic's default max_tokens is 1024 which truncates
    // mid-string and yields a JSON-parse error; bump to 4096 so the
    // model has room. OpenAI ignores the option when not capped.
    { maxTokens: 4096 },
  );

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
    outreachInstructions: parsed.outreachInstructions ?? null,
    language: langGuess,
    confidence: parsed.confidence ?? 'medium',
    notes: parsed.notes,
  };
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
    outreachInstructions: synth.outreachInstructions ?? null,
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
