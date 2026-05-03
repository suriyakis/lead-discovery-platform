CREATE TYPE "public"."outreach_queue_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."send_delay_mode" AS ENUM('immediate', 'fixed', 'random');--> statement-breakpoint
CREATE TABLE "outreach_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"mailbox_id" bigint NOT NULL,
	"draft_id" bigint,
	"to_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"cc_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"bcc_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"body_text" text,
	"body_html" text,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "outreach_queue_status" DEFAULT 'queued' NOT NULL,
	"delay_mode" "send_delay_mode" DEFAULT 'immediate' NOT NULL,
	"scheduled_send_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_message_id" bigint,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_send_settings" (
	"workspace_id" bigint PRIMARY KEY NOT NULL,
	"daily_email_limit" smallint DEFAULT 50 NOT NULL,
	"domain_cooldown_hours" smallint DEFAULT 24 NOT NULL,
	"default_delay_mode" "send_delay_mode" DEFAULT 'random' NOT NULL,
	"fixed_delay_minutes" smallint DEFAULT 15 NOT NULL,
	"random_delay_min_minutes" smallint DEFAULT 5 NOT NULL,
	"random_delay_max_minutes" smallint DEFAULT 30 NOT NULL,
	"emergency_pause" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach_queue" ADD CONSTRAINT "outreach_queue_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_queue" ADD CONSTRAINT "outreach_queue_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_queue" ADD CONSTRAINT "outreach_queue_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_send_settings" ADD CONSTRAINT "outreach_send_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_send_settings" ADD CONSTRAINT "outreach_send_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_queue_ws_status_idx" ON "outreach_queue" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "outreach_queue_ws_schedule_idx" ON "outreach_queue" USING btree ("workspace_id","scheduled_send_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_queue_draft_active_idx" ON "outreach_queue" USING btree ("draft_id") WHERE status IN ('queued', 'sending');