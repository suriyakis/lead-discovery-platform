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
    // Forward the recipe's geo + language to the grounding provider. These
    // were previously dropped here, so `options.country` never reached
    // Gemini/Perplexity and grounded discovery skewed to US/English results
    // regardless of the recipe's country setting.
    const outcome = await this.research.research(ctx, query, {
      maxCitations,
      ...(options.country ? { country: options.country } : {}),
      ...(options.language ? { language: options.language } : {}),
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

  // Production safety net: a workspace that never chose a Web Search
  // provider must NOT silently harvest mock data while a real grounding
  // key exists at the platform level. New workspaces have no
  // researchProvider setting, and env SEARCH_PROVIDER stays 'mock'
  // unless SerpAPI is paid for — without this, every fresh tenant's
  // first discovery run would return fake results with no indication.
  // Explicit choices are respected: a workspace that deliberately set
  // its Web Search to mock/serpapi in Settings → Integrations (any
  // non-empty researchProvider or searchProvider value) skips this.
  const explicitSearch = settings.searchProvider?.trim();
  if (
    !research &&
    !explicitSearch &&
    (process.env.SEARCH_PROVIDER ?? 'mock') === 'mock'
  ) {
    const { resolveProviderKey } = await import('@/lib/services/secrets');
    const geminiKey = await resolveProviderKey(ctx, 'gemini.apiKey', 'GEMINI_API_KEY');
    if (geminiKey) {
      const { GeminiResearchProvider } = await import('@/lib/research/gemini');
      return new ResearchAsSearchAdapter(
        new GeminiResearchProvider({ apiKey: geminiKey.key }),
      );
    }
  }
  return getSearchProviderForCtx(ctx);
}
