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

/**
 * `contacts` — first-class contact records, deduplicated per workspace by
 * lowercased email. Phase 16 lifts contact info out of qualified_leads
 * (where it was embedded) into a shared entity that multiple leads,
 * threads, and source records can point to.
 *
 * The qualified_leads.contactName/Email/Role/Phone columns stay in place
 * for backward compatibility but are now treated as a denormalized
 * snapshot — the canonical store is here.
 */
export const contactStatus = pgEnum('contact_status', [
  'active',
  'archived',
]);

export const contacts = pgTable(
  'contacts',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** Lowercased + trimmed at the service layer. Required (key for dedup). */
    email: text('email').notNull(),
    name: text('name'),
    /** Job title / role. */
    role: text('role'),
    phone: text('phone'),
    /** Free-form company name. Phase 18 may promote this to its own entity. */
    companyName: text('company_name'),
    /** Optional canonical company domain (lowercased). Used by suppression. */
    companyDomain: text('company_domain'),

    status: contactStatus('status').notNull().default('active'),
    notes: text('notes'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),

    /**
     * Free-form jsonb so future enrichment passes (LinkedIn URL, social
     * handles, role taxonomy) can land without a migration.
     */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),

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
    workspaceEmailIdx: uniqueIndex('contacts_ws_email_idx').on(
      table.workspaceId,
      table.email,
    ),
    workspaceCompanyIdx: index('contacts_ws_company_idx').on(
      table.workspaceId,
      table.companyName,
    ),
    workspaceDomainIdx: index('contacts_ws_domain_idx').on(
      table.workspaceId,
      table.companyDomain,
    ),
  }),
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type ContactStatus = (typeof contactStatus.enumValues)[number];

/**
 * `contact_associations` — polymorphic join. Lets one contact tie to many
 * qualified_leads, mail_threads, source_records, mail_messages without
 * duplicating contact data on each. Future entities just add a new
 * `entity_type` value; no schema change needed.
 *
 * Each (contact_id, entity_type, entity_id) is unique to avoid duplicate
 * associations.
 */
export const contactAssociations = pgTable(
  'contact_associations',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contactId: bigint('contact_id', { mode: 'bigint' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),

    /** e.g. 'qualified_lead' | 'mail_thread' | 'mail_message' | 'source_record'. */
    entityType: text('entity_type').notNull(),
    /** Stringified bigint or text id of the target row. */
    entityId: text('entity_id').notNull(),
    /** Optional secondary role e.g. 'primary' | 'cc' | 'inbound_sender'. */
    relation: text('relation'),

    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    contactEntityIdx: uniqueIndex('contact_assoc_contact_entity_idx').on(
      table.contactId,
      table.entityType,
      table.entityId,
    ),
    workspaceEntityIdx: index('contact_assoc_ws_entity_idx').on(
      table.workspaceId,
      table.entityType,
      table.entityId,
    ),
  }),
);

export type ContactAssociation = typeof contactAssociations.$inferSelect;
export type NewContactAssociation = typeof contactAssociations.$inferInsert;
