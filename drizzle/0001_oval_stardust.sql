CREATE TABLE "product_profiles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"name" text NOT NULL,
	"short_description" text,
	"full_description" text,
	"target_customer_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_sectors" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_project_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"include_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclude_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"qualification_criteria" text,
	"disqualification_criteria" text,
	"relevance_threshold" smallint DEFAULT 50 NOT NULL,
	"outreach_instructions" text,
	"negative_outreach_instructions" text,
	"forbidden_phrases" text[] DEFAULT '{}'::text[] NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"document_source_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"pricing_snapshot_id" bigint,
	"crm_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_profiles" ADD CONSTRAINT "product_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_profiles" ADD CONSTRAINT "product_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_profiles" ADD CONSTRAINT "product_profiles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_profiles_workspace_active_idx" ON "product_profiles" USING btree ("workspace_id","active");