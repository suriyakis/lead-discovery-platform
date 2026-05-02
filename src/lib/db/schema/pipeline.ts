import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';
import { reviewItems } from './review';
import { productProfiles } from './products';

/**
 * `qualified_leads` — the commercial leads pipeline. A row exists once a
 * (review_item, product_profile) pair has progressed past raw discovery.
 * Phase 4's review queue handles the `raw_discovered` and `relevant` states
 * implicitly via review_items.state — this table picks up at `relevant` and
 * tracks the full journey to `closed`.
 *
 * Pipeline states (forward-only by default; the service exposes back-step
 * transitions for human correction):
 *
 *   raw_discovered     ← bookkeeping; a row is rarely written in this state
 *   relevant           ← review item approved + qualification crossed threshold
 *   contacted          ← outbound mail sent via Phase 10
 *   replied            ← inbound mail received (Phase 10 sync)
 *   contact_identified ← human enriched contact info (name/email/role)
 *   qualified          ← human confirmed BANT/fit
 *   handed_over        ← transferred to sales/external responsible party
 *   synced_to_crm      ← CRM export confirmed (Phase 13)
 *   closed             ← terminal; close_reason set
 */
export const pipelineState = pgEnum('pipeline_state', [
  'raw_discovered',
  'relevant',
  'contacted',
  'replied',
  'contact_identified',
  'qualified',
  'handed_over',
  'synced_to_crm',
  'closed',
]);

/** Reasons a lead can be closed. */
export const closeReason = pgEnum('close_reason', [
  'won',
  'lost',
  'no_response',
  'wrong_fit',
  'duplicate',
  'spam',
  'other',
]);

export const qualifiedLeads = pgTable(
  'qualified_leads',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    reviewItemId: bigint('review_item_id', { mode: 'bigint' })
      .notNull()
      .references(() => reviewItems.id, { onDelete: 'cascade' }),
    productProfileId: bigint('product_profile_id', { mode: 'bigint' })
      .notNull()
      .references(() => productProfiles.id, { onDelete: 'cascade' }),

    state: pipelineState('state').notNull().default('relevant'),

    // ---- contact (filled at contact_identified) ----
    contactName: text('contact_name'),
    contactEmail: text('contact_email'),
    contactRole: text('contact_role'),
    contactPhone: text('contact_phone'),
    contactNotes: text('contact_notes'),

    // ---- assignment ----
    assignedToUserId: text('assigned_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    // ---- per-state timestamps (audit + UI ribbon) ----
    relevantAt: timestamp('relevant_at', { mode: 'date', withTimezone: true }),
    contactedAt: timestamp('contacted_at', { mode: 'date', withTimezone: true }),
    repliedAt: timestamp('replied_at', { mode: 'date', withTimezone: true }),
    contactIdentifiedAt: timestamp('contact_identified_at', {
      mode: 'date',
      withTimezone: true,
    }),
    qualifiedAt: timestamp('qualified_at', { mode: 'date', withTimezone: true }),
    handedOverAt: timestamp('handed_over_at', { mode: 'date', withTimezone: true }),
    syncedAt: timestamp('synced_at', { mode: 'date', withTimezone: true }),
    closedAt: timestamp('closed_at', { mode: 'date', withTimezone: true }),

    closeReason: closeReason('close_reason'),
    closeNote: text('close_note'),

    // ---- CRM linkage (populated in Phase 13) ----
    crmExternalId: text('crm_external_id'),
    crmSystem: text('crm_system'),

    /** Free-form notes the operator can edit. */
    notes: text('notes'),
    /** Tags for filtering/segmenting the pipeline. */
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),

    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pairKey: uniqueIndex('qualified_leads_pair_idx').on(
      table.workspaceId,
      table.reviewItemId,
      table.productProfileId,
    ),
    workspaceStateIdx: index('qualified_leads_ws_state_idx').on(
      table.workspaceId,
      table.state,
    ),
    workspaceProductIdx: index('qualified_leads_ws_product_idx').on(
      table.workspaceId,
      table.productProfileId,
    ),
    workspaceAssignedIdx: index('qualified_leads_ws_assigned_idx').on(
      table.workspaceId,
      table.assignedToUserId,
    ),
  }),
);

export type QualifiedLead = typeof qualifiedLeads.$inferSelect;
export type NewQualifiedLead = typeof qualifiedLeads.$inferInsert;
export type PipelineState = (typeof pipelineState.enumValues)[number];
export type CloseReason = (typeof closeReason.enumValues)[number];

/**
 * `pipeline_events` — append-only state-transition log. Drives audit + the
 * "history" panel in the UI. Stores from-state, to-state, who, when, and
 * an optional payload for context (e.g., the message_id that triggered a
 * `contacted` transition; the close_reason set at `closed`).
 */
export const pipelineEvents = pgTable(
  'pipeline_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    qualifiedLeadId: bigint('qualified_lead_id', { mode: 'bigint' })
      .notNull()
      .references(() => qualifiedLeads.id, { onDelete: 'cascade' }),

    fromState: pipelineState('from_state'),
    toState: pipelineState('to_state').notNull(),
    /** Free-form: kind of event (transition / assignment / note / contact_update). */
    eventKind: text('event_kind').notNull().default('transition'),

    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),

    actorUserId: text('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    leadIdx: index('pipeline_events_lead_idx').on(
      table.qualifiedLeadId,
      table.createdAt,
    ),
    workspaceCreatedIdx: index('pipeline_events_ws_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
  }),
);

export type PipelineEvent = typeof pipelineEvents.$inferSelect;
export type NewPipelineEvent = typeof pipelineEvents.$inferInsert;
