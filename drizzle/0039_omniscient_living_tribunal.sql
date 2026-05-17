ALTER TABLE "workspaces" ADD COLUMN "follow_up_require_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "follow_up_step_configs" jsonb;--> statement-breakpoint
ALTER TABLE "outreach_follow_ups" ADD COLUMN "staged_subject" text;--> statement-breakpoint
ALTER TABLE "outreach_follow_ups" ADD COLUMN "staged_body" text;