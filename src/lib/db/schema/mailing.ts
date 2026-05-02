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
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';

/**
 * `mailboxes` — one row per workspace-owned email account that can send and
 * (optionally) receive. Credentials live in `workspace_secrets` encrypted at
 * rest; this table only holds connection metadata + the secret keys.
 *
 * Multiple mailboxes per workspace are supported (e.g., personal vs sales).
 * One can be marked default.
 */
export const mailboxStatus = pgEnum('mailbox_status', [
  'active',
  'paused',
  'failing',
  'archived',
]);

export const mailboxes = pgTable(
  'mailboxes',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** Display label, e.g., "Sales · jb@nulife.pl". */
    name: text('name').notNull(),
    /** From-address used in outbound mail. RFC 5322 mailbox text. */
    fromAddress: text('from_address').notNull(),
    /** Optional friendly name in From, e.g., "Jakub at Nulife". */
    fromName: text('from_name'),
    /** Reply-To override. Defaults to fromAddress when null. */
    replyTo: text('reply_to'),

    /** SMTP config */
    smtpHost: text('smtp_host').notNull(),
    smtpPort: integer('smtp_port').notNull().default(587),
    smtpSecure: boolean('smtp_secure').notNull().default(false),
    smtpUser: text('smtp_user').notNull(),
    /** Secret key into workspace_secrets that resolves to the SMTP password. */
    smtpPasswordSecretKey: text('smtp_password_secret_key').notNull(),

    /** IMAP config (optional — outbound-only mailboxes set this null). */
    imapHost: text('imap_host'),
    imapPort: integer('imap_port'),
    imapSecure: boolean('imap_secure').notNull().default(true),
    imapUser: text('imap_user'),
    imapPasswordSecretKey: text('imap_password_secret_key'),
    imapFolder: text('imap_folder').notNull().default('INBOX'),

    status: mailboxStatus('status').notNull().default('active'),
    isDefault: boolean('is_default').notNull().default(false),

    /** Last successful IMAP sync. */
    lastSyncedAt: timestamp('last_synced_at', { mode: 'date', withTimezone: true }),
    /** Last error message from a failing send/receive. Cleared on success. */
    lastError: text('last_error'),

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
    workspaceIdx: index('mailboxes_ws_idx').on(table.workspaceId),
    workspaceStatusIdx: index('mailboxes_ws_status_idx').on(
      table.workspaceId,
      table.status,
    ),
  }),
);

export type Mailbox = typeof mailboxes.$inferSelect;
export type NewMailbox = typeof mailboxes.$inferInsert;
export type MailboxStatus = (typeof mailboxStatus.enumValues)[number];

/**
 * `mail_threads` — server-assigned conversation grouping. We compute a
 * `external_thread_key` from the message Reference / In-Reply-To headers and
 * the Subject (post-stripping Re:/Fw:); messages with the same key cluster.
 */
export const mailThreads = pgTable(
  'mail_threads',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    mailboxId: bigint('mailbox_id', { mode: 'bigint' })
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),

    subject: text('subject').notNull(),
    /** Stable threading key derived from headers. */
    externalThreadKey: text('external_thread_key').notNull(),

    /** Cached counts/timestamps for fast sort. */
    messageCount: integer('message_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { mode: 'date', withTimezone: true }),
    /** Snapshot of unique participants (lowercased addresses). */
    participants: text('participants')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    threadKeyIdx: uniqueIndex('mail_threads_ws_mailbox_key_idx').on(
      table.workspaceId,
      table.mailboxId,
      table.externalThreadKey,
    ),
    workspaceLastMsgIdx: index('mail_threads_ws_last_msg_idx').on(
      table.workspaceId,
      table.lastMessageAt,
    ),
  }),
);

export type MailThread = typeof mailThreads.$inferSelect;
export type NewMailThread = typeof mailThreads.$inferInsert;

/**
 * `mail_messages` — every message we've sent or pulled, by mailbox.
 *
 * `direction` tells us which way the message flowed; `messageId` is the
 * RFC 5322 Message-ID header for dedup; `bodyText` and `bodyHtml` are the
 * decoded payload (large fields, but we keep them inline rather than in
 * IStorage so threading and search stay simple).
 */
export const mailDirection = pgEnum('mail_direction', ['outbound', 'inbound']);
export const mailStatus = pgEnum('mail_status', [
  'queued', // outbound, awaiting send
  'sending',
  'sent',
  'delivered', // we don't always know; treat as best-effort
  'bounced',
  'failed',
  'received', // inbound only
]);

export const mailMessages = pgTable(
  'mail_messages',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    mailboxId: bigint('mailbox_id', { mode: 'bigint' })
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    threadId: bigint('thread_id', { mode: 'bigint' }).references(
      () => mailThreads.id,
      { onDelete: 'set null' },
    ),

    direction: mailDirection('direction').notNull(),
    status: mailStatus('status').notNull(),

    /** RFC 5322 Message-ID header. Drives dedup on inbound + linking on send. */
    messageId: text('message_id').notNull(),
    inReplyTo: text('in_reply_to'),
    references: text('references')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    fromAddress: text('from_address').notNull(),
    fromName: text('from_name'),
    toAddresses: text('to_addresses')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ccAddresses: text('cc_addresses')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    bccAddresses: text('bcc_addresses')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    subject: text('subject').notNull().default(''),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),

    /** Decoded headers as JSON for audit. */
    headers: jsonb('headers').notNull().default(sql`'{}'::jsonb`),
    /** Optional attachment manifest: [{filename, contentType, sizeBytes, storageKey}]. */
    attachments: jsonb('attachments').notNull().default(sql`'[]'::jsonb`),

    sentAt: timestamp('sent_at', { mode: 'date', withTimezone: true }),
    receivedAt: timestamp('received_at', { mode: 'date', withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { mode: 'date', withTimezone: true }),
    failureReason: text('failure_reason'),

    /** Optional link back to an outreach draft we sent from. */
    sourceDraftId: bigint('source_draft_id', { mode: 'bigint' }),

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
    workspaceMessageIdIdx: uniqueIndex('mail_messages_ws_message_id_idx').on(
      table.workspaceId,
      table.messageId,
    ),
    threadCreatedIdx: index('mail_messages_thread_created_idx').on(
      table.threadId,
      table.createdAt,
    ),
    workspaceMailboxStatusIdx: index('mail_messages_ws_mailbox_status_idx').on(
      table.workspaceId,
      table.mailboxId,
      table.status,
    ),
  }),
);

export type MailMessage = typeof mailMessages.$inferSelect;
export type NewMailMessage = typeof mailMessages.$inferInsert;
export type MailDirection = (typeof mailDirection.enumValues)[number];
export type MailStatus = (typeof mailStatus.enumValues)[number];

/**
 * `signatures` — saved signature blocks. A mailbox can have a default
 * signature; users can override per-message in the compose UI.
 */
export const signatures = pgTable(
  'signatures',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    mailboxId: bigint('mailbox_id', { mode: 'bigint' }).references(
      () => mailboxes.id,
      { onDelete: 'set null' },
    ),

    name: text('name').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),
    isDefault: boolean('is_default').notNull().default(false),

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
    workspaceMailboxIdx: index('signatures_ws_mailbox_idx').on(
      table.workspaceId,
      table.mailboxId,
    ),
  }),
);

export type Signature = typeof signatures.$inferSelect;
export type NewSignature = typeof signatures.$inferInsert;

/**
 * `suppression_list` — addresses we MUST NOT email (bounces, opt-outs,
 * compliance lists). Checked before every outbound send.
 */
export const suppressionReason = pgEnum('suppression_reason', [
  'bounce_hard',
  'bounce_soft',
  'unsubscribe',
  'complaint',
  'manual',
]);

export const suppressionList = pgTable(
  'suppression_list',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'bigint' })
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Lowercased, no display name. */
    address: text('address').notNull(),
    reason: suppressionReason('reason').notNull(),
    note: text('note'),
    /** Soft suppressions can have a TTL after which they expire. */
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),

    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceAddressIdx: uniqueIndex('suppression_ws_address_idx').on(
      table.workspaceId,
      table.address,
    ),
  }),
);

export type SuppressionEntry = typeof suppressionList.$inferSelect;
export type NewSuppressionEntry = typeof suppressionList.$inferInsert;
export type SuppressionReason = (typeof suppressionReason.enumValues)[number];

// Voids to keep dead-imports quiet during early phases (smallint reserved
// for future quota/score columns).
void smallint;
