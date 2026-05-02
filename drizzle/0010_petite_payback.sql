CREATE TYPE "public"."close_reason" AS ENUM('won', 'lost', 'no_response', 'wrong_fit', 'duplicate', 'spam', 'other');--> statement-breakpoint
CREATE TYPE "public"."pipeline_state" AS ENUM('raw_discovered', 'relevant', 'contacted', 'replied', 'contact_identified', 'qualified', 'handed_over', 'synced_to_crm', 'closed');--> statement-breakpoint
CREATE TABLE "pipeline_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"qualified_lead_id" bigint NOT NULL,
	"from_state" "pipeline_state",
	"to_state" "pipeline_state" NOT NULL,
	"event_kind" text DEFAULT 'transition' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qualified_leads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"review_item_id" bigint NOT NULL,
	"product_profile_id" bigint NOT NULL,
	"state" "pipeline_state" DEFAULT 'relevant' NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"contact_role" text,
	"contact_phone" text,
	"contact_notes" text,
	"assigned_to_user_id" text,
	"relevant_at" timestamp with time zone,
	"contacted_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"contact_identified_at" timestamp with time zone,
	"qualified_at" timestamp with time zone,
	"handed_over_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" "close_reason",
	"close_note" text,
	"crm_external_id" text,
	"crm_system" text,
	"notes" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_qualified_lead_id_qualified_leads_id_fk" FOREIGN KEY ("qualified_lead_id") REFERENCES "public"."qualified_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualified_leads" ADD CONSTRAINT "qualified_leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualified_leads" ADD CONSTRAINT "qualified_leads_review_item_id_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."review_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualified_leads" ADD CONSTRAINT "qualified_leads_product_profile_id_product_profiles_id_fk" FOREIGN KEY ("product_profile_id") REFERENCES "public"."product_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualified_leads" ADD CONSTRAINT "qualified_leads_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualified_leads" ADD CONSTRAINT "qualified_leads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_events_lead_idx" ON "pipeline_events" USING btree ("qualified_lead_id","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_events_ws_created_idx" ON "pipeline_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "qualified_leads_pair_idx" ON "qualified_leads" USING btree ("workspace_id","review_item_id","product_profile_id");--> statement-breakpoint
CREATE INDEX "qualified_leads_ws_state_idx" ON "qualified_leads" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "qualified_leads_ws_product_idx" ON "qualified_leads" USING btree ("workspace_id","product_profile_id");--> statement-breakpoint
CREATE INDEX "qualified_leads_ws_assigned_idx" ON "qualified_leads" USING btree ("workspace_id","assigned_to_user_id");