import { sql } from 'drizzle-orm';
import { bigint, boolean, pgView, text, timestamp } from 'drizzle-orm/pg-core';
import { accountStatus } from './auth';
import { subscriptionStatus, workspaceStatus } from './workspaces';

/**
 * PC-05: `workspace_automation_state` — one row per workspace with every
 * workspace-level input of the automation gate (services/automation-gate.ts
 * reads it; the background ticks select from it through
 * activeWorkspacesForTicks()):
 *
 *   the lifecycle status, the accountable owner (PC-06: active account and
 *   still a member), the single workspace pause (who, when, why, from
 *   where), the go-live hold (flow:F-07: NULL outreach_live_at = not
 *   live), the wallet (billing-exempt or a positive balance) and the plan
 *   columns the gate resolves the autopilot entitlement from.
 *
 * Holds and the platform-wide outbound stop are read beside it (a
 * workspace has any number of holds; the stop is one platform row).
 *
 * A plain view, not materialized: it is read per gate check, so it must
 * never be stale.
 */
export const workspaceAutomationState = pgView('workspace_automation_state', {
  workspaceId: bigint('workspace_id', { mode: 'bigint' }).notNull(),
  workspaceStatus: workspaceStatus('workspace_status').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  ownerAccountStatus: accountStatus('owner_account_status'),
  ownerIsMember: boolean('owner_is_member').notNull(),
  ownerIncidentAt: timestamp('owner_incident_at', { mode: 'date', withTimezone: true }),
  pausedAt: timestamp('paused_at', { mode: 'date', withTimezone: true }),
  pausedByUserId: text('paused_by_user_id'),
  pauseReason: text('pause_reason'),
  pauseSource: text('pause_source'),
  outreachLiveAt: timestamp('outreach_live_at', { mode: 'date', withTimezone: true }),
  outreachLiveByUserId: text('outreach_live_by_user_id'),
  walletHasTokens: boolean('wallet_has_tokens').notNull(),
  billingExempt: boolean('billing_exempt').notNull(),
  plan: text('plan').notNull(),
  subscriptionStatus: subscriptionStatus('subscription_status').notNull(),
}).as(
  sql`SELECT w.id AS workspace_id, w.status AS workspace_status, w.owner_user_id, u."accountStatus" AS owner_account_status, (m.id IS NOT NULL) AS owner_is_member, w.automation_owner_incident_at AS owner_incident_at, w.automation_paused_at AS paused_at, w.automation_paused_by_user_id AS paused_by_user_id, w.automation_pause_reason AS pause_reason, w.automation_pause_source AS pause_source, w.outreach_live_at, w.outreach_live_by_user_id, (w.billing_exempt OR w.token_balance > 0) AS wallet_has_tokens, w.billing_exempt, w.plan, w.subscription_status FROM workspaces w LEFT JOIN users u ON u.id = w.owner_user_id LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = w.owner_user_id`,
);

export type WorkspaceAutomationStateRow = typeof workspaceAutomationState.$inferSelect;
