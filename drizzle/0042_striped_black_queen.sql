ALTER TABLE "mail_messages" ADD COLUMN "trashed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "spam_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "spam_reason" text;