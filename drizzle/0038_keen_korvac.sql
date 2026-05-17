CREATE TABLE "outreach_follow_ups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"qualified_lead_id" bigint NOT NULL,
	"thread_id" bigint NOT NULL,
	"step_number" smallint NOT NULL,
	"total_steps" smallint NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"last_error" text,
	"queue_entry_id" bigint,
	"draft_id" bigint,
	"sent_message_id" bigint,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "follow_up_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "follow_up_interval_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "follow_up_max_steps" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_follow_ups" ADD CONSTRAINT "outreach_follow_ups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_follow_ups" ADD CONSTRAINT "outreach_follow_ups_qualified_lead_id_qualified_leads_id_fk" FOREIGN KEY ("qualified_lead_id") REFERENCES "public"."qualified_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_follow_ups" ADD CONSTRAINT "outreach_follow_ups_thread_id_mail_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_follow_ups_ws_status_idx" ON "outreach_follow_ups" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "outreach_follow_ups_due_idx" ON "outreach_follow_ups" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "outreach_follow_ups_thread_idx" ON "outreach_follow_ups" USING btree ("workspace_id","thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_follow_ups_thread_step_idx" ON "outreach_follow_ups" USING btree ("workspace_id","thread_id","step_number");