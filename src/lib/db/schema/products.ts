import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';

/**
 * A Product Profile represents something the workspace wants to sell —
 * a product, a service, a consulting offer. The schema is **generic on
 * purpose**: nothing specific to construction, software, or any single
 * sector. Sector-specific behavior comes from the field values (keywords,
 * sectors, criteria), never from special tables.
 *
 * Reserved fields (`documentSourceIds`, `pricingSnapshotId`, `crmMapping`)
 * are present from day 1 so future phases can attach without migrations:
 *   - documentSourceIds → Phase 9 (Document Storage)
 *   - pricingSnapshotId → optional commercial module (Quote/Pricing)
 *   - crmMapping        → Phase 13 (CRM/Export)
 */
export const productProfiles = pgTable(
  'product_profiles',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    shortDescription: text('short_description'),
    fullDescription: text('full_description'),

    targetCustomerTypes: text('target_customer_types')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    targetSectors: text('target_sectors')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    targetProjectTypes: text('target_project_types')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    includeKeywords: text('include_keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    excludeKeywords: text('exclude_keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    qualificationCriteria: text('qualification_criteria'),
    disqualificationCriteria: text('disqualification_criteria'),

    /** 0..100. Records below this score are not promoted to qualified. */
    relevanceThreshold: smallint('relevance_threshold').notNull().default(50),

    outreachInstructions: text('outreach_instructions'),
    negativeOutreachInstructions: text('negative_outreach_instructions'),
    forbiddenPhrases: text('forbidden_phrases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** Phase A++: per-stage angle overrides. Each one is a short
     *  instruction string that the corresponding stage composer
     *  injects into its system prompt. When NULL, the composer falls
     *  back to outreachInstructions for backwards compat. Operator
     *  edits manually or hits "Suggest with AI" to populate. */
    discoveryAngle: text('discovery_angle'),
    engagementAngle: text('engagement_angle'),
    pitchAngle: text('pitch_angle'),

    language: text('language').notNull().default('en'),
    active: boolean('active').notNull().default(true),

    /** Phase 46: when true, AI-generated outreach drafts run a research
        pre-pass against the lead and inject the answer + citations into
        the prompt context. Per-product opt-in because every enriched
        draft costs +1 research call (Gemini / Perplexity). Default off
        so existing products generate drafts at the same cost as before. */
    enrichDraftsWithResearch: boolean('enrich_drafts_with_research')
      .notNull()
      .default(false),
    /** The question to ask the research provider when enrichment is on.
        Templated: literal `{company}` and `{domain}` are replaced from the
        lead's contact_company / contact_domain at draft time. */
    researchQuestionTemplate: text('research_question_template')
      .notNull()
      .default(
        'What does {company} ({domain}) do, what are their main products and target customers, and what recent news or projects from the past 6 months would matter for a B2B introduction?',
      ),

    // ---- reserved for future phases (nullable / default-empty) ----
    documentSourceIds: bigint('document_source_ids', { mode: 'bigint' })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    pricingSnapshotId: bigint('pricing_snapshot_id', { mode: 'bigint' }),
    crmMapping: jsonb('crm_mapping').notNull().default(sql`'{}'::jsonb`),

    // ---- audit ----
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceActiveIdx: index('product_profiles_workspace_active_idx').on(
      table.workspaceId,
      table.active,
    ),
  }),
);

export type ProductProfile = typeof productProfiles.$inferSelect;
export type NewProductProfile = typeof productProfiles.$inferInsert;
