CREATE TABLE "workspace_health_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"score" smallint NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comm_review" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"advice" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "health_check_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "health_check_interval_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "health_check_last_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_health_reports" ADD CONSTRAINT "workspace_health_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_reports_ws_created_idx" ON "workspace_health_reports" USING btree ("workspace_id","created_at");