// Internet Search connector — uses ISearchProvider to harvest web results
// for a recipe's `searchQueries`. Each result becomes a NormalizedRecord
// of recordType='web_search_hit'. Each query call emits a usage_log entry
// so the per-workspace cost view can attribute spend to the right
// connector + key source.

import { z } from 'zod';
import { recordUsage } from '@/lib/services/usage';
import { getSearchProvider } from '@/lib/search';
import type { WorkspaceContext } from '@/lib/services/context';
import type {
  ConnectorRunRequest,
  HarvesterEvent,
  ISourceConnector,
} from './types';

const ConfigSchema = z
  .object({
    /** Default options applied to every query unless the recipe overrides. */
    defaultMaxResults: z.number().int().min(1).max(100).optional(),
    defaultCountry: z.string().min(2).max(8).optional(),
    defaultLanguage: z.string().min(2).max(8).optional(),
  })
  .strict();

const RecipeShape = z
  .object({
    searchQueries: z.array(z.string().min(1).max(500)).min(1).max(50),
    country: z.string().min(2).max(8).optional(),
    language: z.string().min(2).max(8).optional(),
    maxResults: z.number().int().min(1).max(100).optional(),
    freshOnly: z.boolean().optional(),
  })
  .passthrough();

const CredentialsSchema = z.object({}).strict();

export class InternetSearchConnector implements ISourceConnector {
  readonly id = 'internet_search';
  readonly name = 'Internet Search';
  readonly type = 'internet_search' as const;
  readonly configSchema = ConfigSchema;
  readonly credentialsSchema = CredentialsSchema;

  async testConnection(ctx: WorkspaceContext) {
    return getSearchProvider().testConnection(ctx);
  }

  async *run(
    ctx: WorkspaceContext,
    request: ConnectorRunRequest,
  ): AsyncIterable<HarvesterEvent> {
    const config = ConfigSchema.parse(request.config ?? {});
    const recipeRaw = request.recipe ?? null;
    const parsedRecipe = RecipeShape.safeParse(recipeRaw);
    if (!parsedRecipe.success) {
      yield {
        kind: 'error',
        error: {
          message:
            'recipe is missing or malformed: ' +
            parsedRecipe.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
        fatal: true,
      };
      return;
    }
    const recipe = parsedRecipe.data;

    const provider = getSearchProvider();
    yield {
      kind: 'log',
      level: 'info',
      message: `internet_search: starting with provider=${provider.id}, ${recipe.searchQueries.length} query(s)`,
    };

    const totalQueries = recipe.searchQueries.length;
    let totalRecords = 0;

    for (let qIdx = 0; qIdx < recipe.searchQueries.length; qIdx++) {
      const query = recipe.searchQueries[qIdx]!;
      if (request.signal?.aborted) {
        yield { kind: 'log', level: 'warn', message: 'aborted by caller' };
        return;
      }

      yield {
        kind: 'log',
        level: 'info',
        message: `internet_search: q${qIdx + 1}/${totalQueries}: ${query}`,
      };

      const options = {
        country: recipe.country ?? config.defaultCountry,
        language: recipe.language ?? config.defaultLanguage,
        maxResults: recipe.maxResults ?? config.defaultMaxResults ?? 10,
        freshOnly: recipe.freshOnly ?? false,
      } as const;

      let outcome;
      try {
        outcome = await provider.search(ctx, query, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorCode =
          err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'search_error';
        yield {
          kind: 'error',
          error: { message: `query "${query}" failed: ${message}`, payload: { code: errorCode } },
          fatal: errorCode === 'no_key' || errorCode === 'unauthorized',
        };
        if (errorCode === 'no_key' || errorCode === 'unauthorized') return;
        // Non-fatal: continue to the next query.
        continue;
      }

      // Usage tracking — one record per query call, regardless of result count.
      try {
        await recordUsage(ctx, {
          kind: 'search.query',
          provider: provider.id,
          units: outcome.usage.units,
          costEstimateCents: outcome.usage.costEstimateCents,
          payload: {
            query,
            keySource: outcome.usage.keySource,
            connectorId: request.connectorId.toString(),
            recipeId: request.recipeId?.toString() ?? null,
            runId: request.runId.toString(),
          },
        });
      } catch (err) {
        // Usage logging failure shouldn't kill the run.
        yield {
          kind: 'log',
          level: 'warn',
          message: `usage logging failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      for (const result of outcome.results) {
        yield {
          kind: 'record',
          record: {
            sourceId: stableSourceId(query, result),
            sourceUrl: result.url,
            recordType: 'web_search_hit',
            raw: result.raw ?? result,
            normalized: {
              title: result.title,
              url: result.url,
              domain: result.domain,
              snippet: result.snippet,
              query,
              rank: result.rank,
            },
            evidence: [
              {
                url: result.url,
                title: result.title,
                snippet: result.snippet,
              },
            ],
            confidence: 60,
          },
        };
        totalRecords += 1;
      }

      yield { kind: 'progress', current: qIdx + 1, total: totalQueries };
    }

    yield {
      kind: 'log',
      level: 'info',
      message: `internet_search: complete (${totalRecords} record(s) across ${totalQueries} query(s))`,
    };
  }
}

/**
 * Stable per-record id so re-running a query produces the same dedupe key.
 * Combines query + url so the same URL surfacing for two different queries
 * still becomes two source_records (different lead context).
 */
function stableSourceId(query: string, result: { url: string; rank: number }): string {
  // Keep it short but readable. Hash collisions across queries+urls are
  // astronomically unlikely; we still tolerate them via dedupe.
  const safeQuery = query.replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
  const safeUrl = result.url.replace(/[^a-z0-9]+/gi, '-').slice(-80);
  return `${safeQuery}::${safeUrl}::${result.rank}`;
}

import { registerConnector } from './registry';
registerConnector(new InternetSearchConnector());
