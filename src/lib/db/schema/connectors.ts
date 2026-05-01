import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';

export const connectorTemplateType = pgEnum('connector_template_type', [
  'internet_search',
  'directory_harvester',
  'tender_api',
  'csv_import',
  'mock',
]);

export const connectorRunStatus = pgEnum('connector_run_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

/**
 * A configured instance of a connector template, scoped to a workspace.
 * Settings (URL bases, rate limits, …) live in `config`. Secrets live
 * separately in `workspace_secrets` (Phase 6+) and are referenced by name
 * via `credentialsRef`.
 */
export const connectors = pgTable('connectors', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  workspaceId: bigint('workspace_id', { mode: 'bigint' })
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  templateType: connectorTemplateType('template_type').notNull(),
  name: text('name').notNull(),
  config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
  /** Key in workspace_secrets where this connector's credentials live. */
  credentialsRef: text('credentials_ref'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Per-recipe configuration over a connector. New discovery sources are
 * usually new recipes under existing connectors, not new code.
 */
export const connectorRecipes = pgTable(
  'connector_recipes',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    connectorId: bigint('connector_id', { mode: 'bigint' })
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    templateType: connectorTemplateType('template_type').notNull(),
    seedUrls: text('seed_urls').array().notNull().default(sql`'{}'::text[]`),
    searchQueries: text('search_queries').array().notNull().default(sql`'{}'::text[]`),
    selectors: jsonb('selectors').notNull().default(sql`'{}'::jsonb`),
    paginationRules: jsonb('pagination_rules').notNull().default(sql`'{}'::jsonb`),
    enrichmentRules: jsonb('enrichment_rules').notNull().default(sql`'{}'::jsonb`),
    normalizationMapping: jsonb('normalization_mapping').notNull().default(sql`'{}'::jsonb`),
    evidenceRules: jsonb('evidence_rules').notNull().default(sql`'{}'::jsonb`),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceConnectorIdx: index('connector_recipes_ws_connector_idx').on(
      table.workspaceId,
      table.connectorId,
    ),
  }),
);

/**
 * One execution of a connector against a (possibly null) recipe and a set of
 * product profiles. The runner streams events into `connector_run_logs`
 * and produces `source_records`. `recipeSnapshot` is a frozen copy of the
 * recipe at run time so old runs can be reproduced when recipes change.
 */
export const connectorRuns = pgTable(
  'connector_runs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    connectorId: bigint('connector_id', { mode: 'bigint' })
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    recipeId: bigint('recipe_id', { mode: 'bigint' }).references(
      () => connectorRecipes.id,
      { onDelete: 'set null' },
    ),
    productProfileIds: bigint('product_profile_ids', { mode: 'bigint' })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    status: connectorRunStatus('status').notNull().default('pending'),
    progress: integer('progress').notNull().default(0),
    recordCount: integer('record_count').notNull().default(0),
    startedAt: timestamp('started_at', { mode: 'date', withTimezone: true }),
    completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }),
    errorPayload: jsonb('error_payload'),
    recipeSnapshot: jsonb('recipe_snapshot'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceCreatedIdx: index('connector_runs_ws_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    statusIdx: index('connector_runs_status_idx').on(table.status),
  }),
);

export const connectorRunLogs = pgTable(
  'connector_run_logs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    runId: bigint('run_id', { mode: 'bigint' })
      .notNull()
      .references(() => connectorRuns.id, { onDelete: 'cascade' }),
    level: text('level').notNull(),
    message: text('message').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runIdIdx: index('connector_run_logs_run_idx').on(table.runId, table.createdAt),
  }),
);

/**
 * Pre-classification record. Anything a connector emits goes through here
 * first. Dedupe is unique on (workspace, sourceSystem, sourceId); soft
 * dedupe across that uses domain similarity, etc., implemented in service.
 */
export const sourceRecords = pgTable(
  'source_records',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceSystem: text('source_system').notNull(),
    sourceId: text('source_id').notNull(),
    sourceUrl: text('source_url'),
    connectorId: bigint('connector_id', { mode: 'bigint' }).references(
      () => connectors.id,
      { onDelete: 'set null' },
    ),
    recipeId: bigint('recipe_id', { mode: 'bigint' }).references(
      () => connectorRecipes.id,
      { onDelete: 'set null' },
    ),
    runId: bigint('run_id', { mode: 'bigint' }).references(() => connectorRuns.id, {
      onDelete: 'set null',
    }),
    rawData: jsonb('raw_data').notNull(),
    normalizedData: jsonb('normalized_data').notNull(),
    evidenceUrls: text('evidence_urls').array().notNull().default(sql`'{}'::text[]`),
    confidence: integer('confidence').notNull().default(50),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dedupeKey: uniqueIndex('source_records_workspace_system_id_idx').on(
      table.workspaceId,
      table.sourceSystem,
      table.sourceId,
    ),
    workspaceCreatedIdx: index('source_records_ws_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
  }),
);

export type Connector = typeof connectors.$inferSelect;
export type NewConnector = typeof connectors.$inferInsert;
export type ConnectorRecipe = typeof connectorRecipes.$inferSelect;
export type NewConnectorRecipe = typeof connectorRecipes.$inferInsert;
export type ConnectorRun = typeof connectorRuns.$inferSelect;
export type NewConnectorRun = typeof connectorRuns.$inferInsert;
export type ConnectorRunLog = typeof connectorRunLogs.$inferSelect;
export type NewConnectorRunLog = typeof connectorRunLogs.$inferInsert;
export type SourceRecord = typeof sourceRecords.$inferSelect;
export type NewSourceRecord = typeof sourceRecords.$inferInsert;
export type ConnectorTemplateType = (typeof connectorTemplateType.enumValues)[number];
export type ConnectorRunStatus = (typeof connectorRunStatus.enumValues)[number];
