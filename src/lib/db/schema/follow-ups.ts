import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';
import { qualifiedLeads } from './pipeline';
import { mailThreads } from './mailing';

/**
 * Phase 58 — automatic follow-ups.
 *
 * After the first outbound on a thread lands, we pre-schedule N steps
 * (default 3) at fixed intervals (default 7 days apart). The hourly
 * tick `outreach.follow_up.tick` walks pending rows whose
 * `scheduled_for <= NOW()`, regenerates a polite draft via the AI
 * composer, and enqueues the send.
 *
 * A follow-up is cancelled (status='skipped') the moment the recipient
 * replies, or the send pipeline records a bounce / hard failure on the
 * thread — we never want to keep pinging someone who already answered
 * or whose mailbox is bouncing.
 *
 * Status semantics:
 *   pending  — scheduled, waiting for its tick.
 *   sent     — queued + delivered; final state.
 *   skipped  — short-circuited because the operator's situation changed
 *              (reply / bounce / manual cancel). Permanent.
 *   failed   — the AI compose or enqueue threw and the worker gave up
 *              after the retry budget.
 */
export const followUpStatus = ['pending', 'sent', 'skipped', 'failed'] as const;
export type FollowUpStatus = (typeof followUpStatus)[number];

export const followUpSkipReason = [
  'replied',
  'bounce',
  'manual_cancel',
  'product_archived',
  'lead_closed',
] as const;
export type FollowUpSkipReason = (typeof followUpSkipReason)[number];

export const outreachFollowUps = pgTable(
  'outreach_follow_ups',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The lead we're chasing. Schedule cancels when the lead closes. */
    qualifiedLeadId: bigint('qualified_lead_id', { mode: 'bigint' })
      .notNull()
      .references(() => qualifiedLeads.id, { onDelete: 'cascade' }),
    /** The thread we're following up on. Multiple steps share a thread. */
    threadId: bigint('thread_id', { mode: 'bigint' })
      .notNull()
      .references(() => mailThreads.id, { onDelete: 'cascade' }),
    /** 1..N. The last step is special-cased in the AI prompt (must
     *  explicitly tell the recipient it's the final email). */
    stepNumber: smallint('step_number').notNull(),
    /** Total steps the schedule was created with. Captures workspace
     *  config at the time of creation so a mid-flight change to
     *  followUpMaxSteps doesn't retroactively reshape existing
     *  schedules. */
    totalSteps: smallint('total_steps').notNull(),
    /** When the worker should pick this row up. Set at create time
     *  from the workspace's followUpIntervalDays. */
    scheduledFor: timestamp('scheduled_for', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),

    /** Status string — see followUpStatus enum above. Stored as text
     *  rather than a pg enum because adding statuses later (escalated /
     *  paused / etc.) shouldn't need a migration. */
    status: text('status').notNull().default('pending'),
    /** Why a 'skipped' row was skipped — only set when status='skipped'. */
    skipReason: text('skip_reason'),
    /** Free-form last-error for 'failed' rows. */
    lastError: text('last_error'),

    /** outreach_queue.id once the send was enqueued. */
    queueEntryId: bigint('queue_entry_id', { mode: 'bigint' }),
    /** outreach_drafts.id once the draft was persisted. */
    draftId: bigint('draft_id', { mode: 'bigint' }),
    /** mail_messages.id once the queue entry was sent. */
    sentMessageId: bigint('sent_message_id', { mode: 'bigint' }),
    /** When the worker last transitioned this row (sent / skipped /
     *  failed). */
    processedAt: timestamp('processed_at', {
      mode: 'date',
      withTimezone: true,
    }),

    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceStatusIdx: index('outreach_follow_ups_ws_status_idx').on(
      table.workspaceId,
      table.status,
    ),
    /** Worker's main query: pending rows due now. */
    dueIdx: index('outreach_follow_ups_due_idx').on(
      table.status,
      table.scheduledFor,
    ),
    /** Cancellation cascades: when a reply lands on a thread, the
     *  service walks every pending row keyed by (workspace, thread). */
    threadIdx: index('outreach_follow_ups_thread_idx').on(
      table.workspaceId,
      table.threadId,
    ),
    /** A schedule has at most one row per (thread, step). Re-running
     *  scheduleFollowUps for the same thread is a no-op rather than
     *  duplicating steps. */
    threadStepKey: uniqueIndex('outreach_follow_ups_thread_step_idx').on(
      table.workspaceId,
      table.threadId,
      table.stepNumber,
    ),
  }),
);

export type OutreachFollowUp = typeof outreachFollowUps.$inferSelect;
export type NewOutreachFollowUp = typeof outreachFollowUps.$inferInsert;

void users; // referenced for future actor_user_id additions
void sql; // referenced for future array default columns
