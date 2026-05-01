// Connector framework — interfaces, event types, registry contract.
//
// A connector is an implementation of a generic harvester template.
// New discovery sources are usually new *recipes* under existing templates,
// not new connectors. Building a new template (a new ISourceConnector) is
// justified only when an existing one cannot be configured to fit.

import type { ZodSchema } from 'zod';
import type { ConnectorTemplateType } from '@/lib/db/schema/connectors';
import type { WorkspaceContext } from '@/lib/services/context';

export interface NormalizedEvidenceRef {
  url: string;
  title?: string;
  snippet?: string;
}

/**
 * The shape a connector produces per harvested record. Free-form `raw`
 * preserves the provider response for debugging and re-normalization;
 * `normalized` is the canonical projection the rest of the pipeline reads.
 */
export interface NormalizedRecord {
  /** Provider-stable id: a SerpAPI result id, a directory entry id, etc. */
  sourceId: string;
  /** URL the record came from, when meaningful. */
  sourceUrl?: string;
  /** Type hint for downstream classification. */
  recordType: 'company' | 'contact' | 'opportunity' | 'project' | 'tender' | 'web_search_hit';
  raw: unknown;
  normalized: Record<string, unknown>;
  evidence?: NormalizedEvidenceRef[];
  /** 0..100 connector-side confidence. Default 50. */
  confidence?: number;
}

export type HarvesterEvent =
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string; payload?: unknown }
  | { kind: 'progress'; current: number; total?: number }
  | { kind: 'record'; record: NormalizedRecord }
  | { kind: 'error'; error: { message: string; payload?: unknown }; fatal: boolean };

/** Inputs the runner hands to a connector for one execution. */
export interface ConnectorRunRequest {
  runId: bigint;
  connectorId: bigint;
  recipeId: bigint | null;
  recipe: Record<string, unknown> | null;
  config: Record<string, unknown>;
  productProfileIds: bigint[];
  /** Lets the connector check between events. Implementations should poll
      this between expensive operations to support cooperative cancellation. */
  signal?: AbortSignal;
}

export interface ISourceConnector {
  readonly id: string;
  readonly name: string;
  readonly type: ConnectorTemplateType;
  /** Validates `connectors.config` for this template. */
  readonly configSchema: ZodSchema;
  /** Validates the secret value stored at `workspace_secrets[credentialsRef]`. */
  readonly credentialsSchema: ZodSchema;

  testConnection(ctx: WorkspaceContext): Promise<{ ok: boolean; detail?: string }>;
  run(ctx: WorkspaceContext, request: ConnectorRunRequest): AsyncIterable<HarvesterEvent>;
}
