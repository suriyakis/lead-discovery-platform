// Search provider abstraction.
//
// Discovery connectors of template `internet_search` use this to actually
// query something. Two implementations ship today:
//   - mock     deterministic, zero-cost, used in dev + tests
//   - serpapi  real SerpAPI integration, BYOK or platform-default key
//
// Selection happens at boot via the `SEARCH_PROVIDER` env var.

import { createHash } from 'node:crypto';
import type { WorkspaceContext } from '@/lib/services/context';
import { SerpAPIProvider } from './serpapi';

export interface SearchOptions {
  country?: string;
  language?: string;
  maxResults?: number;
  /** Force the provider to refuse cached results, when supported. */
  freshOnly?: boolean;
}

export interface SearchResult {
  rank: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  /** Provider-specific raw payload preserved for debugging and re-normalization. */
  raw?: unknown;
}

export interface SearchUsage {
  /** Number of underlying calls made (1 query may require >1 call when paginating). */
  units: number;
  /** Estimated cost in cents. 0 for mock; SerpAPI charges per query. */
  costEstimateCents: number;
  /** Whether the API key came from workspace_secrets or the platform env. */
  keySource: 'workspace' | 'platform' | 'mock';
}

export interface SearchOutcome {
  results: SearchResult[];
  usage: SearchUsage;
}

export interface ISearchProvider {
  readonly id: string;
  /**
   * Run a query. Returns results PLUS a usage record so the caller can
   * write `usage_log` entries with the right keySource and cost.
   */
  search(
    ctx: WorkspaceContext,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchOutcome>;
  /** Sanity-check a configured key. */
  testConnection(ctx: WorkspaceContext): Promise<{ ok: boolean; detail?: string }>;
  /** Best-effort upfront cost estimate, in cents, before a search runs. */
  estimateUsageCost(query: string, options?: SearchOptions): number;
}

// ---- mock implementation -----------------------------------------------

export class MockSearchProvider implements ISearchProvider {
  public readonly id = 'mock';

  async search(
    _ctx: WorkspaceContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchOutcome> {
    void _ctx;
    const max = Math.max(1, Math.min(options.maxResults ?? 5, 50));
    const seed = createHash('sha256').update(query).digest('hex');
    const results: SearchResult[] = [];
    for (let i = 0; i < max; i++) {
      const slug = `${seed.slice(i * 4, i * 4 + 8)}`;
      const domain = `example-${slug}.test`;
      results.push({
        rank: i + 1,
        title: `Mock result ${i + 1} for "${query}"`,
        url: `https://${domain}/page`,
        domain,
        snippet: `Mock snippet ${slug} for query: ${query}`,
        raw: { provider: this.id, slug, query, options },
      });
    }
    return {
      results,
      usage: { units: 1, costEstimateCents: 0, keySource: 'mock' },
    };
  }

  async testConnection() {
    return { ok: true, detail: 'mock provider is always reachable' };
  }

  estimateUsageCost(_query: string, _options: SearchOptions = {}): number {
    void _query;
    void _options;
    return 0;
  }
}

// ---- factory -----------------------------------------------------------

let cached: ISearchProvider | null = null;

export function getSearchProvider(): ISearchProvider {
  if (cached) return cached;
  const id = process.env.SEARCH_PROVIDER ?? 'mock';
  switch (id) {
    case 'mock':
      cached = new MockSearchProvider();
      return cached;
    case 'serpapi':
      cached = new SerpAPIProvider();
      return cached;
    default:
      throw new Error(
        `Unknown SEARCH_PROVIDER: ${id}. Supported: "mock", "serpapi".`,
      );
  }
}

export function _setSearchProviderForTests(provider: ISearchProvider | null): void {
  cached = provider;
}
