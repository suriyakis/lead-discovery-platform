CREATE TABLE "crawl_plans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer DEFAULT 60 NOT NULL,
	"quiet_start_hour" integer,
	"quiet_end_hour" integer,
	"timezone" text DEFAULT 'Europe/Warsaw' NOT NULL,
	"recipe_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"product_profile_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_run_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawl_plans" ADD CONSTRAINT "crawl_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crawl_plans_ws_idx" ON "crawl_plans" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "crawl_plans_ws_enabled_idx" ON "crawl_plans" USING btree ("workspace_id","enabled");--> statement-breakpoint
CREATE INDEX "crawl_plans_next_run_idx" ON "crawl_plans" USING btree ("next_run_at");