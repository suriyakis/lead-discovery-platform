// KL-06 — document text extraction with a per-SHA cache (I040).
//
// The indexer needs a document's text; getting it can be expensive (a
// scanned PDF goes to Mistral OCR, billed per page). Before KL-06 every
// run re-read the bytes and re-extracted — N+1 OCR runs for a source with
// N products. Now the first extraction is written to the document row
// (documents.extracted_text, extractor, extracted_at, extracted_sha256,
// detected_language, page_count) right away, before any embedding, and
// every later run reads it:
//
//   1. this row's cache, while extracted_sha256 = sha256;
//   2. else another document of the workspace with the same sha256 and a
//      cache (a re-upload of an archived file) — copied, not re-extracted;
//   3. else extract once and cache.
//
// forceOcr (the admin's "Re-extract with OCR") skips 1-2 and the PDF text
// layer and OCRs — unless an OCR extraction newer than the request is
// already cached, so a retry or the document's second source never pays
// twice. Extraction failures are never cached.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { documents, type Document } from '@/lib/db/schema/documents';
import { detectLanguageFromText } from '@/lib/i18n/language';
import { getStorage, type IStorage } from '@/lib/storage';
import type { WorkspaceContext } from './context';

export type ExtractionErrorCode =
  | 'unsupported_type'
  | 'parse_failed'
  | 'no_text'
  | 'ocr_unavailable'
  | 'not_pdf';

/** A deterministic extraction failure: retrying the same bytes cannot
 *  succeed, so the indexer fails the run at once instead of backing off. */
export class DocumentExtractionError extends Error {
  public readonly code: ExtractionErrorCode;
  constructor(message: string, code: ExtractionErrorCode) {
    super(message);
    this.name = 'DocumentExtractionError';
    this.code = code;
  }
}

/** Below this many extracted chars a "parsed" PDF counts as image-based
 *  (scanned pages parse fine — they just contain no text operators). */
const PDF_TEXT_MIN_CHARS = 20;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Whether auto-indexing should even be attempted for a document, judged
 * from metadata alone (no bytes needed). Mirrors the extractable branches
 * of extraction, minus the looks-like-UTF-8 byte heuristic — unknown
 * binary types are stored fine but not queued automatically; "Index now"
 * still runs the full byte-sniffing path.
 */
export function isIndexableDocument(input: {
  mimeType: string | null;
  filename: string;
}): boolean {
  const mime = (input.mimeType ?? '').toLowerCase();
  const filename = input.filename.toLowerCase();
  if (mime.startsWith('text/') || mime === 'application/json') return true;
  if (mime === 'application/xhtml+xml') return true;
  if (isPdfDocument(input)) return true;
  if (mime === DOCX_MIME || filename.endsWith('.docx')) return true;
  return /\.(md|txt|csv|json|html?|xml)$/.test(filename);
}

export function isPdfDocument(input: { mimeType: string | null; filename: string }): boolean {
  return (
    (input.mimeType ?? '').toLowerCase() === 'application/pdf' ||
    input.filename.toLowerCase().endsWith('.pdf')
  );
}

export interface ExtractionResult {
  text: string;
  /** 'text' | 'html' | 'pdf' | 'docx' | 'ocr:<provider>/<model>' */
  extractor: string;
  /** True when no parsing or OCR ran for this call. */
  fromCache: boolean;
  pages: number | null;
  language: string | null;
}

export interface ExtractOptions {
  storage?: IStorage;
  /** OCR even when cached text or a PDF text layer exists. */
  forceOcr?: boolean;
  /** forceOcr is satisfied by an OCR extraction cached at or after this. */
  forceOcrSince?: Date;
}

export function isOcrExtractor(extractor: string | null | undefined): boolean {
  return typeof extractor === 'string' && extractor.startsWith('ocr:');
}

function cacheUsable(doc: Document, options: ExtractOptions): boolean {
  if (doc.extractedText === null || doc.sha256 === '') return false;
  if (doc.extractedSha256 !== doc.sha256) return false;
  if (!options.forceOcr) return true;
  return (
    isOcrExtractor(doc.extractor) &&
    doc.extractedAt !== null &&
    options.forceOcrSince !== undefined &&
    doc.extractedAt.getTime() >= options.forceOcrSince.getTime()
  );
}

function fromRow(doc: Document): ExtractionResult {
  return {
    text: doc.extractedText ?? '',
    extractor: doc.extractor ?? 'text',
    fromCache: true,
    pages: doc.pageCount,
    language: doc.detectedLanguage,
  };
}

/**
 * The document's text: cached when possible (see the module header),
 * extracted and cached otherwise. Throws DocumentExtractionError for a
 * deterministic failure; anything else (storage, OCR API) is transient.
 */
export async function extractDocumentText(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  document: Document,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  if (cacheUsable(document, options)) return fromRow(document);

  if (!options.forceOcr && document.sha256 !== '') {
    const [sibling] = await db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.workspaceId, ctx.workspaceId),
          eq(documents.sha256, document.sha256),
          eq(documents.extractedSha256, document.sha256),
          isNotNull(documents.extractedText),
          ne(documents.id, document.id),
        ),
      )
      .limit(1);
    if (sibling) {
      const cached = fromRow(sibling);
      await writeCache(ctx, document, cached, sibling.extractedAt ?? new Date());
      return cached;
    }
  }

  const fresh = await extractFresh(ctx, document, options);
  await writeCache(ctx, document, fresh, new Date());
  return fresh;
}

async function writeCache(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  document: Document,
  result: ExtractionResult,
  extractedAt: Date,
): Promise<void> {
  // Guarded on the sha the text came from, so a cache can never describe
  // other bytes.
  await db
    .update(documents)
    .set({
      extractedText: result.text,
      extractor: result.extractor,
      extractedAt,
      extractedSha256: document.sha256,
      detectedLanguage: result.language,
      pageCount: result.pages,
    })
    .where(
      and(
        eq(documents.workspaceId, ctx.workspaceId),
        eq(documents.id, document.id),
        eq(documents.sha256, document.sha256),
      ),
    );
}

async function extractFresh(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  document: Document,
  options: ExtractOptions,
): Promise<ExtractionResult> {
  const storage = options.storage ?? getStorage();
  const buffer = await streamToBuffer(await storage.get(document.storageKey));
  const mime = document.mimeType.toLowerCase();
  const filename = document.filename.toLowerCase();

  const done = (text: string, extractor: string, pages: number | null): ExtractionResult => ({
    text,
    extractor,
    fromCache: false,
    pages,
    language: detectLanguageFromText(text),
  });

  if (options.forceOcr && !isPdfDocument(document)) {
    throw new DocumentExtractionError(`${document.filename} is not a PDF; only PDFs can be OCR'd.`, 'not_pdf');
  }
  if (mime.startsWith('text/') || mime === 'application/json') {
    return done(buffer.toString('utf8'), 'text', null);
  }
  if (mime === 'application/xhtml+xml') {
    return done(stripHtml(buffer.toString('utf8')), 'html', null);
  }
  // PDFs go through the same lazy-loaded pdf-parse pipeline that
  // product-autofill uses (inner module path, skipping the entry-point
  // self-test bug). Scanned PDFs fall through to OCR.
  if (isPdfDocument(document)) {
    const pdf = await extractPdfText(ctx, buffer, document, options.forceOcr === true);
    return done(pdf.text, pdf.extractor, pdf.pages);
  }
  // DOCX via mammoth (`.docx` only — old `.doc` binary format is rare).
  if (mime === DOCX_MIME || filename.endsWith('.docx')) {
    return done(await extractDocxText(buffer, document.filename), 'docx', null);
  }
  // Heuristic: if the buffer looks like UTF-8 text, treat it as such.
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('utf8');
  if (looksLikeText(sample)) return done(buffer.toString('utf8'), 'text', null);
  throw new DocumentExtractionError(
    `unsupported mime type for indexing: ${mime}`,
    'unsupported_type',
  );
}

function cleanWhitespace(raw: string): string {
  return raw
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdfText(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
  buffer: Buffer,
  document: Document,
  forceOcr: boolean,
): Promise<{ text: string; extractor: string; pages: number | null }> {
  const filename = document.filename;
  let pages: number | null = null;
  if (!forceOcr) {
    // @ts-expect-error pdf-parse v1 has no .d.ts for the inner path; we
    // hand-type the surface we use.
    const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
      default: (buffer: Buffer) => Promise<{ text?: string; numpages?: number }>;
    };
    let raw = '';
    try {
      const result = await mod.default(buffer);
      raw = result.text ?? '';
      pages = typeof result.numpages === 'number' && result.numpages > 0 ? result.numpages : null;
    } catch (err) {
      throw new DocumentExtractionError(
        `pdf parse failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        'parse_failed',
      );
    }
    const cleaned = cleanWhitespace(raw);
    if (cleaned.length >= PDF_TEXT_MIN_CHARS) return { text: cleaned, extractor: 'pdf', pages };
  }

  // Image-based (scanned) PDF — or an explicit re-extract. Route to the
  // OCR provider (Mistral) when a key is configured anywhere in the
  // cascade; otherwise fail with instructions instead of silently
  // producing an empty index.
  const { getOcrProviderForCtx, estimateOcrCostCents } = await import('@/lib/ocr');
  const ocr = await getOcrProviderForCtx(ctx);
  if (!ocr) {
    throw new DocumentExtractionError(
      `${filename} contains no extractable text (image-based / scanned PDF). Add a Mistral API key (Admin → Providers, or workspace BYOK 'mistral.apiKey') to enable automatic OCR, or re-save the PDF with a text layer.`,
      'ocr_unavailable',
    );
  }
  const result = await ocr.provider.extractPdfText(buffer, filename);
  // Meter the OCR pages — same choke point as every other billable call.
  // Best-effort: a usage-log failure never breaks the extraction (its
  // text is cached right after, so it is never paid for twice).
  try {
    const { recordUsage } = await import('./usage');
    await recordUsage(ctx, {
      kind: 'ocr.pdf',
      provider: ocr.provider.id,
      units: BigInt(Math.max(result.pages, 1)),
      costEstimateCents: estimateOcrCostCents(result.pages),
      payload: {
        model: result.model,
        filename,
        documentId: document.id.toString(),
        sha256: document.sha256,
        pages: result.pages,
        forced: forceOcr,
        keySource: ocr.keySource,
      },
    });
  } catch (err) {
    console.error(
      '[document-extraction] OCR usage record failed:',
      err instanceof Error ? err.message : err,
    );
  }
  const ocrCleaned = cleanWhitespace(result.text);
  if (ocrCleaned.length < PDF_TEXT_MIN_CHARS) {
    throw new DocumentExtractionError(
      `${filename}: OCR (${result.model}) found no readable text across ${result.pages} page${result.pages === 1 ? '' : 's'} — the scan may be blank or illegible.`,
      'no_text',
    );
  }
  return {
    text: ocrCleaned,
    extractor: `ocr:${ocr.provider.id}/${result.model}`,
    pages: result.pages > 0 ? result.pages : pages,
  };
}

async function extractDocxText(buffer: Buffer, filename: string): Promise<string> {
  const mod = (await import('mammoth')) as unknown as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  let raw = '';
  try {
    const result = await mod.extractRawText({ buffer });
    raw = result.value ?? '';
  } catch (err) {
    throw new DocumentExtractionError(
      `docx parse failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      'parse_failed',
    );
  }
  const cleaned = cleanWhitespace(raw);
  if (cleaned.length < 20) {
    throw new DocumentExtractionError(
      `${filename} contains no extractable text after docx parsing.`,
      'no_text',
    );
  }
  return cleaned;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeText(sample: string): boolean {
  let nonText = 0;
  for (const ch of sample) {
    const code = ch.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 65533) {
      nonText++;
    }
  }
  return nonText / Math.max(1, sample.length) < 0.05;
}

async function streamToBuffer(stream: Readable | NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/** sha256 hex of the exact text a source's chunks are embedded from. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
