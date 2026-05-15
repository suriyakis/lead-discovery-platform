ALTER TABLE "mailboxes" ADD COLUMN "imap_consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "imap_next_sync_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "imap_empty_syncs" integer DEFAULT 0 NOT NULL;