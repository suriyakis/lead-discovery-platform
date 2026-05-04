CREATE TABLE "autopilot_product_settings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"product_profile_id" bigint NOT NULL,
	"autopilot_enabled" boolean,
	"emergency_pause" boolean,
	"enable_auto_approve_projects" boolean,
	"auto_approve_threshold" smallint,
	"enable_auto_enqueue_outreach" boolean,
	"enable_auto_crm_contact_sync" boolean,
	"enable_auto_crm_deal_on_qualified" boolean,
	"default_mailbox_id" bigint,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "autopilot_product_settings" ADD CONSTRAINT "autopilot_product_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_product_settings" ADD CONSTRAINT "autopilot_product_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autopilot_product_settings_ws_product_idx" ON "autopilot_product_settings" USING btree ("workspace_id","product_profile_id");