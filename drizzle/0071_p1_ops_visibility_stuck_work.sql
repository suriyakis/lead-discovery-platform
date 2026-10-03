ALTER TYPE "public"."connector_run_status" ADD VALUE 'partial';--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "last_progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outreach_queue" ADD COLUMN "last_failure_kind" text;--> statement-breakpoint
ALTER TABLE "outreach_queue" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
-- custom:begin
-- PC-10: what drizzle-kit 0.30 does not generate from the TS schema.
-- Rows a pre-PC-10 build claimed have no claimed_at; that claim set
-- updated_at, so the stuck-work reaper can date them from it.
UPDATE "outreach_queue" SET "claimed_at" = "updated_at" WHERE "status" = 'sending' AND "claimed_at" IS NULL;--> statement-breakpoint
-- Runs already running get their last update as the first heartbeat.
UPDATE "connector_runs" SET "last_progress_at" = "updated_at" WHERE "status" = 'running' AND "last_progress_at" IS NULL;--> statement-breakpoint
ALTER TABLE "outreach_queue" ADD CONSTRAINT "outreach_queue_last_failure_kind_check" CHECK ("last_failure_kind" IS NULL OR "last_failure_kind" IN ('transient', 'local', 'unknown', 'sender_auth', 'recipient_hard', 'policy', 'interrupted'));
-- custom:end
