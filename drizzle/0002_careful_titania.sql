CREATE TYPE "public"."connector_run_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."connector_template_type" AS ENUM('internet_search', 'directory_harvester', 'tender_api', 'csv_import', 'mock');--> statement-breakpoint
CREATE TABLE "connector_recipes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"connector_id" bigint NOT NULL,
	"name" text NOT NULL,
	"template_type" "connector_template_type" NOT NULL,
	"seed_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"search_queries" text[] DEFAULT '{}'::text[] NOT NULL,
	"selectors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pagination_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enrichment_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"normalization_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_run_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"connector_id" bigint NOT NULL,
	"recipe_id" bigint,
	"product_profile_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"status" "connector_run_status" DEFAULT 'pending' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_payload" jsonb,
	"recipe_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"template_type" "connector_template_type" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_ref" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"source_system" text NOT NULL,
	"source_id" text NOT NULL,
	"source_url" text,
	"connector_id" bigint,
	"recipe_id" bigint,
	"run_id" bigint,
	"raw_data" jsonb NOT NULL,
	"normalized_data" jsonb NOT NULL,
	"evidence_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"confidence" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_recipes" ADD CONSTRAINT "connector_recipes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_recipes" ADD CONSTRAINT "connector_recipes_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_run_logs" ADD CONSTRAINT "connector_run_logs_run_id_connector_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."connector_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_recipe_id_connector_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."connector_recipes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_recipe_id_connector_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."connector_recipes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_run_id_connector_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."connector_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_recipes_ws_connector_idx" ON "connector_recipes" USING btree ("workspace_id","connector_id");--> statement-breakpoint
CREATE INDEX "connector_run_logs_run_idx" ON "connector_run_logs" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "connector_runs_ws_created_idx" ON "connector_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "connector_runs_status_idx" ON "connector_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_workspace_system_id_idx" ON "source_records" USING btree ("workspace_id","source_system","source_id");--> statement-breakpoint
CREATE INDEX "source_records_ws_created_idx" ON "source_records" USING btree ("workspace_id","created_at");