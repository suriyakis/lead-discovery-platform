// OCR provider abstraction — pulls text out of image-based (scanned)
// PDFs that pdf-parse cannot read because they have no text layer.
//
// The RAG indexing pipeline auto-routes here: extractPdfText tries the
// normal pdf-parse path first, and only when that yields no text does
// the document count as image-based and go through OCR. Mistral's
// dedicated OCR API (mistral-ocr-latest, ~$1 per 1000 pages) is the
// only real implementation; the factory resolves the API key through
// the platform-wide cascade (workspace BYOK `mistral.apiKey` →
// /admin/providers console key → MISTRAL_API_KEY env) and returns null
// when no key is configured anywhere — callers degrade to a clear
// "configure a Mistral key" error instead of a silent failure.

import type { WorkspaceContext } from '@/lib/services/context';

export interface OcrResult {
  /** Concatenated page text (Mistral returns per-page markdown). */
  text: string;
  /** Pages processed — the billing unit. */
  pages: number;
  model: string;
}

export interface IOcrProvider {
  readonly id: string;
  readonly model: string;
  extractPdfText(buffer: Buffer, filename: string): Promise<OcrResult>;
}

export class OcrError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OcrError';
    this.code = code;
  }
}

/** Mistral accepts up to ~50 MB; our upload cap is 32 MB — this guard
 *  exists so a future cap raise can't silently ship huge payloads. */
const MAX_OCR_BYTES = 40 * 1024 * 1024;

// ---- Mistral implementation ----------------------------------------

export interface MistralOcrConfig {
  apiKey: string;
  /** Default 'mistral-ocr-latest'. */
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface MistralOcrResponse {
  model?: string;
  pages?: Array<{ index?: number; markdown?: string }>;
  usage_info?: { pages_processed?: number };
}

export class MistralOcrProvider implements IOcrProvider {
  public readonly id = 'mistral';
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: MistralOcrConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'mistral-ocr-latest';
    this.baseUrl = config.baseUrl ?? 'https://api.mistral.ai';
    // OCR of a long scan is slow — allow well beyond the AI-call default.
    this.timeoutMs = config.timeoutMs ?? 180_000;
  }

  async extractPdfText(buffer: Buffer, filename: string): Promise<OcrResult> {
    if (buffer.length > MAX_OCR_BYTES) {
      throw new OcrError(
        `${filename} is too large for OCR (${Math.round(buffer.length / 1024 / 1024)} MB > ${MAX_OCR_BYTES / 1024 / 1024} MB)`,
        'too_large',
      );
    }
    const body = {
      model: this.model,
      document: {
        type: 'document_url',
        document_url: `data:application/pdf;base64,${buffer.toString('base64')}`,
      },
      include_image_base64: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/ocr`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new OcrError(
        `mistral ocr ${res.status}: ${detail.slice(0, 400)}`,
        'api_error',
      );
    }
    const json = (await res.json()) as MistralOcrResponse;
    const pageTexts = (json.pages ?? [])
      .map((p) => (p.markdown ?? '').trim())
      .filter(Boolean);
    return {
      text: pageTexts.join('\n\n').trim(),
      pages: json.usage_info?.pages_processed ?? json.pages?.length ?? 0,
      model: json.model ?? this.model,
    };
  }
}

// ---- factory --------------------------------------------------------

export interface ResolvedOcrProvider {
  provider: IOcrProvider;
  /** 'workspace' = BYOK (token-free), 'platform' = console key / env. */
  keySource: 'workspace' | 'platform';
}

let cached: ResolvedOcrProvider | null = null;

/** Test seam — inject a stub provider (keySource defaults to platform). */
export function _setOcrProviderForTests(
  provider: IOcrProvider | null,
  keySource: 'workspace' | 'platform' = 'platform',
): void {
  cached = provider ? { provider, keySource } : null;
}

/**
 * Workspace-aware factory. Returns null when no Mistral key is
 * configured anywhere — OCR is an optional capability and the caller
 * owns the messaging for its absence.
 */
export async function getOcrProviderForCtx(
  ctx: Pick<WorkspaceContext, 'workspaceId'>,
): Promise<ResolvedOcrProvider | null> {
  if (cached) return cached;
  const { resolveProviderKey } = await import('@/lib/services/secrets');
  const resolved = await resolveProviderKey(ctx, 'mistral.apiKey', 'MISTRAL_API_KEY');
  if (!resolved) return null;
  return {
    provider: new MistralOcrProvider({
      apiKey: resolved.key,
      model: process.env.MISTRAL_OCR_MODEL,
      baseUrl: process.env.MISTRAL_BASE_URL,
    }),
    keySource: resolved.source,
  };
}

/** Mistral OCR retail-ish pricing: $1 / 1000 pages → 0.1 cents per page. */
export function estimateOcrCostCents(pages: number): number {
  if (!Number.isFinite(pages) || pages <= 0) return 0;
  return Math.ceil(pages * 0.1);
}
