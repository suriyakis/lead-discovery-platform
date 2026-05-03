CREATE TABLE "autopilot_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"run_id" text NOT NULL,
	"step" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"entity_type" text,
	"entity_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autopilot_settings" (
	"workspace_id" bigint PRIMARY KEY NOT NULL,
	"autopilot_enabled" boolean DEFAULT false NOT NULL,
	"emergency_pause" boolean DEFAULT false NOT NULL,
	"enable_auto_approve_projects" boolean DEFAULT false NOT NULL,
	"auto_approve_threshold" smallint DEFAULT 70 NOT NULL,
	"enable_auto_enqueue_outreach" boolean DEFAULT false NOT NULL,
	"enable_auto_drain_queue" boolean DEFAULT false NOT NULL,
	"enable_auto_sync_inbound" boolean DEFAULT false NOT NULL,
	"enable_auto_crm_contact_sync" boolean DEFAULT false NOT NULL,
	"enable_auto_crm_deal_on_qualified" boolean DEFAULT false NOT NULL,
	"max_approvals_per_run" smallint DEFAULT 20 NOT NULL,
	"max_enqueues_per_run" smallint DEFAULT 20 NOT NULL,
	"default_mailbox_id" bigint,
	"default_crm_connection_id" bigint,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "autopilot_log" ADD CONSTRAINT "autopilot_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD CONSTRAINT "autopilot_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD CONSTRAINT "autopilot_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autopilot_log_ws_created_idx" ON "autopilot_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "autopilot_log_ws_run_idx" ON "autopilot_log" USING btree ("workspace_id","run_id");