CREATE TYPE "public"."crm_connection_status" AS ENUM('active', 'paused', 'failing', 'archived');--> statement-breakpoint
CREATE TYPE "public"."crm_sync_outcome" AS ENUM('pending', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "crm_connections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"system" text NOT NULL,
	"name" text NOT NULL,
	"credential_secret_key" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "crm_connection_status" DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_sync_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"crm_connection_id" bigint NOT NULL,
	"qualified_lead_id" bigint NOT NULL,
	"outcome" "crm_sync_outcome" DEFAULT 'pending' NOT NULL,
	"external_id" text,
	"status_code" integer,
	"error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"triggered_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_connections" ADD CONSTRAINT "crm_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_connections" ADD CONSTRAINT "crm_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_log" ADD CONSTRAINT "crm_sync_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_log" ADD CONSTRAINT "crm_sync_log_crm_connection_id_crm_connections_id_fk" FOREIGN KEY ("crm_connection_id") REFERENCES "public"."crm_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_log" ADD CONSTRAINT "crm_sync_log_qualified_lead_id_qualified_leads_id_fk" FOREIGN KEY ("qualified_lead_id") REFERENCES "public"."qualified_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_log" ADD CONSTRAINT "crm_sync_log_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_connections_ws_system_idx" ON "crm_connections" USING btree ("workspace_id","system");--> statement-breakpoint
CREATE INDEX "crm_connections_ws_status_idx" ON "crm_connections" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "crm_sync_log_ws_created_idx" ON "crm_sync_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "crm_sync_log_lead_conn_idx" ON "crm_sync_log" USING btree ("qualified_lead_id","crm_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_sync_log_pending_idx" ON "crm_sync_log" USING btree ("qualified_lead_id","crm_connection_id") WHERE outcome = 'pending';