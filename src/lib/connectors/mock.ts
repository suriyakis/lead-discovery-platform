// Mock connector — produces deterministic synthetic records.
//
// Used by tests and as a placeholder for development. The recipe controls
// how many records to emit and a seed string so two runs with the same
// recipe produce the same output.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConnectorRunRequest, HarvesterEvent, ISourceConnector } from './types';
import type { WorkspaceContext } from '@/lib/services/context';

const ConfigSchema = z
  .object({
    /** Shown in the UI, doesn't affect output. */
    label: z.string().max(60).optional(),
  })
  .strict();

const RecipeSchema = z
  .object({
    seed: z.string().min(1).max(60).default('mock'),
    count: z.number().int().min(0).max(500).default(5),
    /** Synthetic latency between events, in ms. */
    delayMs: z.number().int().min(0).max(2000).default(0),
    /** If set to a positive integer, emit a fatal error after N records. */
    failAfter: z.number().int().min(1).max(500).optional(),
  })
  // Recipe rows include standard fields like seedUrls, searchQueries,
  // selectors, paginationRules — pass-through so the mock tolerates them.
  .passthrough();

const CredentialsSchema = z.object({}).strict();

export class MockConnector implements ISourceConnector {
  readonly id = 'mock';
  readonly name = 'Mock';
  readonly type = 'mock' as const;
  readonly configSchema = ConfigSchema;
  readonly credentialsSchema = CredentialsSchema;

  async testConnection(_ctx: WorkspaceContext) {
    void _ctx;
    return { ok: true, detail: 'mock connector is always ready' };
  }

  async *run(
    _ctx: WorkspaceContext,
    request: ConnectorRunRequest,
  ): AsyncIterable<HarvesterEvent> {
    void _ctx;
    const recipe = RecipeSchema.parse(request.recipe ?? {});
    const { seed, count, delayMs, failAfter } = recipe;

    yield { kind: 'log', level: 'info', message: `mock: starting (count=${count}, seed=${seed})` };

    for (let i = 0; i < count; i++) {
      if (request.signal?.aborted) {
        yield { kind: 'log', level: 'warn', message: 'mock: aborted by caller' };
        return;
      }
      if (delayMs > 0) await sleep(delayMs);

      if (failAfter !== undefined && i >= failAfter) {
        yield {
          kind: 'error',
          error: { message: `mock: synthetic failure at record ${i}` },
          fatal: true,
        };
        return;
      }

      const slug = createHash('sha256').update(`${seed}:${i}`).digest('hex').slice(0, 12);
      const domain = `example-${slug}.test`;
      yield {
        kind: 'record',
        record: {
          sourceId: `mock-${seed}-${i}`,
          sourceUrl: `https://${domain}/page-${i}`,
          recordType: 'web_search_hit',
          raw: { provider: 'mock', seed, index: i, slug },
          normalized: {
            title: `Mock result ${i + 1} for "${seed}"`,
            domain,
            url: `https://${domain}/page-${i}`,
            snippet: `Synthetic snippet ${slug} produced deterministically from the mock seed.`,
          },
          evidence: [
            {
              url: `https://${domain}/page-${i}`,
              title: `Mock result ${i + 1}`,
              snippet: `Snippet for ${slug}.`,
            },
          ],
          confidence: 50,
        },
      };

      if (count > 0) {
        yield { kind: 'progress', current: i + 1, total: count };
      }
    }

    yield { kind: 'log', level: 'info', message: 'mock: complete' };
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Register at module-load. Importing this file from anywhere registers the
// mock connector exactly once (Map.set is idempotent on the same key).
import { registerConnector } from './registry';
registerConnector(new MockConnector());

// Side-effect: importing the mock also imports the internet_search
// connector so both are present in the registry.
import './internet-search';
