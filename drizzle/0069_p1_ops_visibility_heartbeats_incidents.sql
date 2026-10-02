-- PC-07 (I021/I022): background-job heartbeats and the ops incident stream.
-- job_heartbeats: one row per job name (8 repeatable ticks + connector.run),
-- written by the instrumented() wrapper and the boot-time schedule
-- registration. ops_events: fingerprinted, deduplicated, masked incidents
-- (workspace or platform scope); one open row per fingerprint.
-- Schema only; no data is changed here.
CREATE TABLE "job_heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'tick' NOT NULL,
	"interval_ms" integer,
	"queue_provider" text,
	"boot_id" text,
	"registered_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_status" text,
	"last_duration_ms" integer,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"last_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_due_at" timestamp with time zone,
	"run_count" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"workspace_id" bigint,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution" text
);
--> statement-breakpoint
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ops_events_open_fingerprint_idx" ON "ops_events" USING btree ("fingerprint") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "ops_events_source_open_idx" ON "ops_events" USING btree ("source") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "ops_events_ws_last_seen_idx" ON "ops_events" USING btree ("workspace_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "ops_events_last_seen_idx" ON "ops_events" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "ops_events_resolved_at_idx" ON "ops_events" USING btree ("resolved_at");--> statement-breakpoint
-- custom:begin
-- PC-07: value checks drizzle-kit 0.30 does not generate from the TS schema.
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_scope_check" CHECK ("scope" IN ('platform', 'workspace'));--> statement-breakpoint
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_scope_workspace_check" CHECK (("scope" = 'workspace') = ("workspace_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_severity_check" CHECK ("severity" IN ('info', 'warning', 'error', 'critical'));--> statement-breakpoint
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_occurrences_check" CHECK ("occurrences" >= 1);--> statement-breakpoint
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_resolution_check" CHECK (("resolved_at" IS NULL) = ("resolution" IS NULL) AND ("resolution" IS NULL OR "resolution" IN ('auto', 'manual')));--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD CONSTRAINT "job_heartbeats_kind_check" CHECK ("kind" IN ('tick', 'job'));--> statement-breakpoint
ALTER TABLE "job_heartbeats" ADD CONSTRAINT "job_heartbeats_status_check" CHECK ("last_status" IS NULL OR "last_status" IN ('running', 'ok', 'degraded', 'failed'));
-- custom:end
