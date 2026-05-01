// Search provider abstraction.
//
// Discovery connectors of template `internet_search` use this to actually
// query something. Phase 1 ships only `mock`. Real providers (SerpAPI,
// Gemini Search Grounding, ...) arrive in Phase 6+.

import { createHash } from 'node:crypto';

export interface SearchOptions {
  country?: string;
  language?: string;
  maxResults?: number;
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

export interface ISearchProvider {
  readonly id: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  testConnection(): Promise<{ ok: boolean; detail?: string }>;
  estimateUsageCost(query: string, options?: SearchOptions): number;
}

// ---- mock implementation -----------------------------------------------

export class MockSearchProvider implements ISearchProvider {
  public readonly id = 'mock';

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
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
    return results;
  }

  async testConnection() {
    return { ok: true, detail: 'mock provider is always reachable' };
  }

  estimateUsageCost(query: string, options: SearchOptions = {}): number {
    void query;
    void options;
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
    default:
      throw new Error(`Unknown SEARCH_PROVIDER: ${id}. Phase 1 supports only "mock".`);
  }
}

export function _setSearchProviderForTests(provider: ISearchProvider | null): void {
  cached = provider;
}
