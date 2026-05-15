import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';

export const workspaceMemberRole = pgEnum('workspace_member_role', [
  'owner',
  'admin',
  'manager',
  'member',
  'viewer',
]);

/**
 * Phase 23: workspace lifecycle. `archived` workspaces deny access to all
 * members (super-admins can still see + restore them). Used as the
 * super-admin "off" toggle for workspaces.
 */
export const workspaceStatus = pgEnum('workspace_status', ['active', 'archived']);

/** Phase 47: onboarding state machine. New workspaces start at
 *  `pending` and the dashboard redirects to /onboarding until the
 *  operator has completed (or skipped) the setup wizard. */
export const onboardingStatus = pgEnum('onboarding_status', [
  'pending',
  'in_progress',
  'completed',
]);

/** Phase 47/48: subscription state. The wizard's Plan step shows
 *  what the workspace is on today; payments (Stripe) plug in later
 *  to flip these via webhook. */
export const subscriptionStatus = pgEnum('subscription_status', [
  'trial',
  'active',
  'past_due',
  'canceled',
]);

export const workspaces = pgTable('workspaces', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  status: workspaceStatus('status').notNull().default('active'),
  archivedAt: timestamp('archived_at', { mode: 'date', withTimezone: true }),
  archivedBy: text('archived_by'),
  archivedReason: text('archived_reason'),
  /**
   * Phase 28: protected workspace flag. Default-flagged workspaces cannot
   * be archived or deleted — useful as an environment-level "system"
   * tenant that survives nuking everything else.
   */
  isDefault: boolean('is_default').notNull().default(false),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => users.id),

  /** Phase 47: where the operator is in the setup wizard. Defaults to
   *  `completed` so existing workspaces (created before the wizard
   *  shipped) don't get redirected on next login. New workspaces are
   *  created with `pending` via the bootstrap path. */
  onboardingStatus: onboardingStatus('onboarding_status')
    .notNull()
    .default('completed'),
  /** Phase 47/48: current plan. 'trial' is the default until Stripe
   *  webhook flips it. Free-form text so adding new tiers later
   *  doesn't require a migration. */
  plan: text('plan').notNull().default('trial'),
  /** Phase 47/48: subscription state, written by the (future) Stripe
   *  webhook handler. Until payments ship, every workspace is `trial`. */
  subscriptionStatus: subscriptionStatus('subscription_status')
    .notNull()
    .default('trial'),
  /** When the trial ends. Null = no time-bounded trial yet. */
  trialEndsAt: timestamp('trial_ends_at', { mode: 'date', withTimezone: true }),
  /** Stripe customer + subscription ids, populated by the webhook. */
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),

  // ---- Phase A: staged outreach defaults ----
  /** When an inbound reply lands on an outreach thread, automatically
   *  generate the next draft via AI. Operator can flip this OFF if they
   *  prefer to write every reply themselves. Default ON. */
  autoDraftReplies: boolean('auto_draft_replies').notNull().default(true),
  /** When auto-drafted reply confidence is high enough, send without
   *  human review. Default OFF — sales replies are too risky to auto-
   *  send unless the operator opts in. */
  autoSendReplies: boolean('auto_send_replies').notNull().default(false),

  /** Phase 50: per-product cap on bytes uploaded to vector storage.
   *  Enforced by the vector-storage provider before attaching a new
   *  knowledge source. 20 MB matches the operator's default budget for
   *  a single product's knowledge base. */
  vectorStorageQuotaMbPerProduct: integer('vector_storage_quota_mb_per_product')
    .notNull()
    .default(20),

  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceMemberRole('role').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceUser: uniqueIndex('workspace_members_workspace_user_idx').on(
      table.workspaceId,
      table.userId,
    ),
  }),
);

export const workspaceSettings = pgTable('workspace_settings', {
  workspaceId: bigint('workspace_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Phase 45: per-workspace provider selection. Operator picks the active
 * AI / embedding / research / search provider from the integrations
 * page; values stored here override the platform-level env vars
 * (AI_PROVIDER, EMBEDDING_PROVIDER, RESEARCH_PROVIDER, SEARCH_PROVIDER).
 *
 * NULL means "inherit the env default" — preserves prior behaviour for
 * workspaces that haven't opted in.
 */
export const workspaceProviderSettings = pgTable('workspace_provider_settings', {
  workspaceId: bigint('workspace_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** 'mock' | 'openai' | 'anthropic' — null inherits env. */
  aiProvider: text('ai_provider'),
  /** Specific model id for the chosen AI provider, e.g. 'gpt-5-nano'
   *  for openai, 'claude-opus-4-7' for anthropic. NULL inherits the
   *  provider's built-in default model. Validated against the per-
   *  vendor catalog in provider-settings.ts at write time. */
  aiModel: text('ai_model'),
  /** 'mock' | 'openai' — null inherits env. */
  embeddingProvider: text('embedding_provider'),
  /** 'mock' | 'gemini' | 'perplexity' — null inherits env. */
  researchProvider: text('research_provider'),
  /** Specific model id for the chosen research provider — e.g.
   *  'gemini-2.5-flash' or 'sonar-pro'. NULL inherits default. */
  researchModel: text('research_model'),
  /** 'mock' | 'serpapi' — null inherits env. */
  searchProvider: text('search_provider'),
  /** Phase 50: 'mock' | 'pgvector' | 'openai' — null inherits env
   *  (`VECTOR_STORAGE_PROVIDER`). Drives where knowledge sources land
   *  (local pgvector chunks vs. per-product OpenAI Vector Store) and
   *  which backend serves RAG retrieval. */
  vectorStorageProvider: text('vector_storage_provider'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type WorkspaceProviderSettings = typeof workspaceProviderSettings.$inferSelect;
export type NewWorkspaceProviderSettings = typeof workspaceProviderSettings.$inferInsert;

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
export type WorkspaceMemberRole = (typeof workspaceMemberRole.enumValues)[number];
export type WorkspaceStatus = (typeof workspaceStatus.enumValues)[number];
