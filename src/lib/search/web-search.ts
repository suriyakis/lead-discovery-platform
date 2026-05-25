// P62-25: unified Web Search resolver.
//
// /settings/integrations now exposes a single "Web Search" card with
// options: serpapi / gemini / perplexity / mock. The internet_search
// connector calls getWebSearchProviderForCtx() which picks the right
// backend:
//   - workspace.researchProvider = gemini/perplexity  → grounded-search
//     adapter (this file) wrapping IResearchProvider
//   - else                                            → ISearchProvider
//     resolved by SEARCH_PROVIDER (serpapi, mock)
//
// The research → search mapping turns each grounding citation into a
// SearchResult and reports usage costs in the same SearchUsage shape
// so the usage_log + cost view downstream don't have to branch.

import type { WorkspaceContext } from '@/lib/services/context';
import {
  getSearchProviderForCtx,
  type ISearchProvider,
  type SearchOptions,
  type SearchOutcome,
  type SearchResult,
} from './index';
import {
  getResearchProviderForCtx,
  type IResearchProvider,
} from '@/lib/research';

class ResearchAsSearchAdapter implements ISearchProvider {
  public readonly id: string;
  constructor(private readonly research: IResearchProvider) {
    this.id = `research:${research.id}`;
  }

  async search(
    ctx: WorkspaceContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchOutcome> {
    const maxCitations = Math.max(1, Math.min(options.maxResults ?? 10, 25));
    const outcome = await this.research.research(ctx, query, {
      maxCitations,
    });
    const results: SearchResult[] = outcome.citations.map((c) => ({
      rank: c.rank,
      title: c.title,
      url: c.url,
      domain: c.domain,
      snippet: c.title, // research providers don't expose snippets
      raw: { groundedAnswer: outcome.answer, citation: c },
    }));
    return {
      results,
      usage: {
        units: outcome.usage.searchQueries,
        costEstimateCents: Math.round(outcome.usage.costEstimateCents ?? 0),
        keySource:
          outcome.usage.keySource === 'workspace' ? 'workspace' : 'platform',
      },
    };
  }

  async testConnection(ctx: WorkspaceContext) {
    if (typeof this.research.testConnection === 'function') {
      return this.research.testConnection();
    }
    // Best-effort: a tiny research call.
    try {
      await this.research.research(ctx, 'ping', { maxCitations: 1 });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  estimateUsageCost(query: string): number {
    return this.research.estimateUsageCost(query);
  }
}

/** Workspace-aware Web Search resolver. When the workspace picked a
 *  research grounding provider (Gemini / Perplexity), that wins over
 *  the search provider — grounding is the more powerful backend and
 *  if the operator turned it on they explicitly want it driving
 *  discovery. Falls back to SerpAPI / mock otherwise. */
export async function getWebSearchProviderForCtx(
  ctx: { workspaceId: bigint },
): Promise<ISearchProvider> {
  const { getProviderSettings } = await import(
    '@/lib/services/provider-settings'
  );
  const settings = await getProviderSettings(ctx);
  const research = settings.researchProvider?.trim();
  if (research === 'gemini' || research === 'perplexity') {
    try {
      const provider = await getResearchProviderForCtx(ctx);
      return new ResearchAsSearchAdapter(provider);
    } catch {
      // No research key → fall through to the plain search provider so
      // the connector at least limps with mock instead of crashing.
    }
  }
  return getSearchProviderForCtx(ctx);
}
