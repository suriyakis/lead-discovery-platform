// SerpAPI search provider.
//
// API: https://serpapi.com/search.json?q=<query>&api_key=<key>&num=<n>
// Auth: per-workspace key (workspace_secrets at `serpapi.apiKey`),
//       falling back to platform default at SERPAPI_KEY env var.
//
// Cost model: SerpAPI prices per search. We charge a fixed 1c-per-query
// estimate to usage_log; operators can refine this with a per-workspace
// rate setting later if needed.

import type { WorkspaceContext } from '@/lib/services/context';
import { resolveProviderKey } from '@/lib/services/secrets';
import type {
  ISearchProvider,
  SearchOptions,
  SearchOutcome,
  SearchResult,
} from './index';

export class SerpAPIError extends Error {
  public readonly code: string;
  public readonly status?: number;
  constructor(
    message: string,
    code: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'SerpAPIError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

interface SerpAPIOrganic {
  position?: number;
  title?: string;
  link?: string;
  displayed_link?: string;
  snippet?: string;
}

interface SerpAPIResponse {
  organic_results?: SerpAPIOrganic[];
  error?: string;
  search_metadata?: { status?: string; id?: string };
}

const DEFAULT_ENDPOINT = 'https://serpapi.com/search.json';
const DEFAULT_TIMEOUT_MS = 15_000;

export class SerpAPIProvider implements ISearchProvider {
  public readonly id = 'serpapi';

  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { endpoint?: string; fetchImpl?: typeof fetch } = {}) {
    this.endpoint = opts.endpoint ?? process.env.SERPAPI_ENDPOINT ?? DEFAULT_ENDPOINT;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(
    ctx: WorkspaceContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchOutcome> {
    const trimmed = query.trim();
    if (!trimmed) throw new SerpAPIError('query is empty', 'invalid_input');

    const resolved = await resolveProviderKey(ctx, 'serpapi.apiKey', 'SERPAPI_KEY');
    if (!resolved) {
      throw new SerpAPIError(
        'no SerpAPI key configured (set workspace secret serpapi.apiKey or SERPAPI_KEY env)',
        'no_key',
      );
    }

    const max = clamp(options.maxResults ?? 10, 1, 100);
    const url = new URL(this.endpoint);
    url.searchParams.set('q', trimmed);
    url.searchParams.set('api_key', resolved.key);
    url.searchParams.set('num', String(max));
    url.searchParams.set('engine', 'google');
    url.searchParams.set('no_cache', options.freshOnly ? 'true' : 'false');
    if (options.country) url.searchParams.set('gl', options.country);
    if (options.language) url.searchParams.set('hl', options.language);

    const response = await this.fetchWithTimeout(url.toString());
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const code = mapHttpToCode(response.status);
      throw new SerpAPIError(
        `serpapi returned ${response.status}: ${text.slice(0, 200)}`,
        code,
        { status: response.status },
      );
    }

    const body = (await response.json()) as SerpAPIResponse;
    if (body.error) {
      throw new SerpAPIError(`serpapi error: ${body.error}`, 'provider_error');
    }

    const organic = body.organic_results ?? [];
    const results: SearchResult[] = organic.slice(0, max).map((row, i) => {
      const link = row.link ?? '';
      const domain = safeDomain(link);
      return {
        rank: row.position ?? i + 1,
        title: row.title ?? '(no title)',
        url: link,
        domain,
        snippet: row.snippet ?? '',
        raw: row,
      };
    });

    return {
      results,
      usage: {
        units: 1,
        costEstimateCents: this.estimateUsageCost(trimmed, options),
        keySource: resolved.source,
      },
    };
  }

  async testConnection(ctx: WorkspaceContext): Promise<{ ok: boolean; detail?: string }> {
    try {
      const outcome = await this.search(ctx, 'serpapi connection test', { maxResults: 1 });
      return {
        ok: true,
        detail: `serpapi reachable, key from ${outcome.usage.keySource}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: message };
    }
  }

  estimateUsageCost(query: string, options: SearchOptions = {}): number {
    void query;
    void options;
    // Conservative flat rate: 1 cent per query. SerpAPI pricing varies by
    // plan ($75 / 5k = 1.5c, $150 / 15k = 1c, etc.). We err low so cost
    // dashboards don't over-report. Operators can override later.
    return 1;
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SerpAPIError('serpapi request timed out', 'timeout');
      }
      throw new SerpAPIError(
        `serpapi network error: ${err instanceof Error ? err.message : String(err)}`,
        'network_error',
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function clamp(input: number, min: number, max: number): number {
  if (!Number.isFinite(input)) return min;
  return Math.min(max, Math.max(min, Math.floor(input)));
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function mapHttpToCode(status: number): string {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'http_error';
}
