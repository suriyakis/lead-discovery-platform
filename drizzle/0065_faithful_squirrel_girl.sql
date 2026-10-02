-- flow:F-06: bookkeeping for versioned data-remediation scripts
-- (scripts/remediation/). One remediation_runs row per applied batch (id =
-- the dry-run report's batch id) and one remediation_log row per changed
-- row with its before- and after-image, so every apply can be reverted.
-- Schema only; no data is changed here.
CREATE TABLE "remediation_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"workspace_id" bigint,
	"category" text NOT NULL,
	"table_name" text NOT NULL,
	"row_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "remediation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"script" text NOT NULL,
	"module" text NOT NULL,
	"plan_hash" text NOT NULL,
	"decisions_hash" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"applied_by" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"reverted_by" text,
	"reverted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "remediation_log" ADD CONSTRAINT "remediation_log_run_id_remediation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."remediation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_log" ADD CONSTRAINT "remediation_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_runs" ADD CONSTRAINT "remediation_runs_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_runs" ADD CONSTRAINT "remediation_runs_reverted_by_users_id_fk" FOREIGN KEY ("reverted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remediation_log_run_idx" ON "remediation_log" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "remediation_log_table_row_idx" ON "remediation_log" USING btree ("table_name","row_id");