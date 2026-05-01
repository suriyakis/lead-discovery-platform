# Connector rules

How discovery sources are added, configured, and run.

## Core principle

**New sources are usually new recipes under existing templates, not new code.**

A *template* is a generic harvester (e.g., "directory harvester," "internet search"). A *recipe* is a workspace-specific configuration of that template — selectors, queries, mappings.

Building a new template is justified only when an existing one cannot be adapted with config alone. When that happens, document the new template in this file before merging.

## Template types (Phase 3 initial set)

### 1. `internet_search`
- Calls a configured `ISearchProvider` with a list of queries.
- Stores raw search results, then optionally enriches each result by fetching the URL and extracting structured data (per-recipe selectors).
- Recipes specify: `searchQueries[]`, `country`, `language`, `maxResults`, optional `enrichmentRules`, `normalizationMapping`.
- Producer of: `source_records` of type `web_search_hit`, optionally enriched into `companies` + `evidence`.

### 2. `directory_harvester`
- Crawls a known directory (association, exhibitor list, public registry) using configured selectors and pagination rules.
- Recipes specify: `seedUrls[]`, `selectors` (CSS or XPath), `paginationRules`, `normalizationMapping`, `evidenceRules`.
- Producer of: `source_records` of type `directory_entry`, normalized into `companies` and (when present) `contacts`.

### 3. `tender_api`
- Pulls from a structured API (national tender boards, EU TED, etc.).
- Recipes specify: API endpoint, auth (via secrets), filters, polling cadence, schema mapping.
- Producer of: `opportunities` and/or `tenders` plus the contracting authority `company`.

### 4. `csv_import`
- One-shot file upload. User maps columns to canonical fields.
- Producer of: `companies`, `contacts`, or `opportunities` depending on the mapping.

## Connector interfaces

```ts
interface ISourceConnector {
  id: string;
  name: string;
  type: ConnectorTemplateType;
  configSchema: ZodSchema;            // shape of `connectors.config`
  credentialsSchema: ZodSchema;       // shape of `workspace_secrets` value
  testConnection(ctx: WorkspaceContext): Promise<{ ok: boolean; detail?: string }>;
  run(ctx: WorkspaceContext, run: ConnectorRun): AsyncIterable<HarvesterEvent>;
}

interface IHarvesterRecipe {
  id: string;
  workspaceId: bigint;
  connectorId: bigint;
  name: string;
  templateType: ConnectorTemplateType;
  seedUrls?: string[];
  searchQueries?: string[];
  selectors?: SelectorMap;
  paginationRules?: PaginationRules;
  enrichmentRules?: EnrichmentRules;
  normalizationMapping?: NormalizationMap;
  evidenceRules?: EvidenceRules;
  active: boolean;
}

type HarvesterEvent =
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'progress'; current: number; total?: number }
  | { kind: 'record'; raw: unknown; normalized: NormalizedRecord; evidence: EvidenceRef[] }
  | { kind: 'error'; error: { message: string; payload?: unknown }; fatal: boolean };
```

The connector emits an async iterable of events. The runner consumes events to update the `connector_runs` row, write `source_records`, and stream logs into `connector_run_logs`.

## Run lifecycle

```
pending  -> running  -> succeeded | failed | cancelled
```

- A run is created with `productProfileIds[]`. Records are tagged with those IDs so qualification picks them up later.
- A run is **cancellable**. The runner checks a cancellation flag between events.
- A run is **resumable** when the connector supports it (cursor-based APIs, offset-based directories). Resumability is per template and documented in the recipe.

## Failure handling

- Transient errors (timeout, 5xx) — connector retries with backoff. Failures count is logged.
- Permanent errors (4xx with bad config, parse failures) — emitted as fatal events and end the run with `failed`.
- Per-record errors (one row in a directory fails to parse) — logged but do not fail the whole run unless above a threshold.

## Workspace isolation

- Connectors only see their own workspace's secrets. The connector framework loads credentials via the secrets module and never passes them across workspace boundaries.
- A connector run can never cross-write to another workspace, even by mistake. The runner asserts `record.workspaceId === run.workspaceId` on every emitted record.

## Adding a new template (the rare case)

When you really do need a new template:

1. Open a discussion in `TODO.md` with the use case and why an existing template won't do.
2. Define the `configSchema` and `credentialsSchema` Zod schemas first.
3. Implement `testConnection` and `run` against a single example.
4. Add it to the registry in `src/lib/connectors/registry.ts`.
5. Add it to this document.
6. Add tests with a recorded fixture.

## Adding a new recipe (the common case)

1. In the UI: pick a template, fill in the form generated from `configSchema`, save.
2. Programmatically (tests, seeds): call `createRecipe(ctx, recipe)`.
3. Recipes are tied to a connector instance and a template. They are versioned via `updatedAt`; older recipe runs keep a snapshot in the `connector_runs.recipeSnapshot` field.

## Things that are not connectors (clear naming)

- A **search provider** (`ISearchProvider`) is a low-level dependency of the `internet_search` template. SerpAPI is a search provider, not a connector.
- An **AI provider** (`IAIProvider`) is similarly a low-level dependency. It can be used inside connectors for enrichment, but it is not itself a connector.
- A **storage provider** (`IStorage`) holds files (CSV uploads, harvested documents). Not a connector.
- An **import** is a one-shot connector run, not a separate concept.
