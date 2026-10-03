CREATE TYPE "public"."mailbox_failure_class" AS ENUM('auth', 'connection', 'ambiguous');--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "failure_class" "mailbox_failure_class";--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "next_probe_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "probe_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "smtp_verified_at" timestamp with time zone;--> statement-breakpoint
-- custom:begin
-- PC-09: value checks drizzle-kit 0.30 does not generate from the TS schema.
-- A failure class exists only while the mailbox is failing (NULL on a
-- failing row = failing since before PC-09, awaiting the reviewed backfill).
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_failure_class_only_when_failing_check" CHECK ("failure_class" IS NULL OR "status" = 'failing');--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_probe_attempts_check" CHECK ("probe_attempts" >= 0);
-- custom:end
