CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qualification_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stop_reason" text,
	"error" text,
	"requested_by" text,
	"up_to_record_id" bigint NOT NULL,
	"total_records" integer NOT NULL,
	"product_count" integer NOT NULL,
	"processed_records" integer DEFAULT 0 NOT NULL,
	"qualification_count" integer DEFAULT 0 NOT NULL,
	"failed_records" integer DEFAULT 0 NOT NULL,
	"last_record_id" bigint,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "qualification_runs" ADD CONSTRAINT "qualification_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_runs" ADD CONSTRAINT "qualification_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_expires_idx" ON "rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "qualification_runs_one_active_idx" ON "qualification_runs" USING btree ("workspace_id") WHERE status IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "qualification_runs_workspace_created_idx" ON "qualification_runs" USING btree ("workspace_id","created_at");
--> statement-breakpoint
-- custom:begin
-- PC-38: value checks drizzle-kit 0.30 does not generate from the TS schema.
ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_buckets_count_check" CHECK ("count" >= 1);--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_buckets_window_check" CHECK ("expires_at" > "window_start");--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_buckets_key_check" CHECK (char_length("key") BETWEEN 1 AND 200);--> statement-breakpoint
ALTER TABLE "qualification_runs" ADD CONSTRAINT "qualification_runs_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'stopped', 'failed'));--> statement-breakpoint
ALTER TABLE "qualification_runs" ADD CONSTRAINT "qualification_runs_stop_reason_check" CHECK (CASE WHEN "status" = 'stopped' THEN "stop_reason" IN ('no_tokens', 'held', 'lease_lost') ELSE "stop_reason" IS NULL END);--> statement-breakpoint
ALTER TABLE "qualification_runs" ADD CONSTRAINT "qualification_runs_counters_check" CHECK ("total_records" >= 0 AND "product_count" >= 0 AND "processed_records" >= 0 AND "qualification_count" >= 0 AND "failed_records" >= 0 AND "failed_records" <= "processed_records");--> statement-breakpoint
-- PC-38: work_leases gains the 'action' kind (single-flight for an
-- operator's button); its resource_key is the action's name, optionally
-- ':<id>' (ACTION_RESOURCE_PATTERN in services/work-leases.ts).
ALTER TABLE "work_leases" DROP CONSTRAINT "work_leases_kind_check";--> statement-breakpoint
ALTER TABLE "work_leases" ADD CONSTRAINT "work_leases_kind_check" CHECK ("kind" IN ('autopilot.run', 'outreach.drain', 'outreach.follow_up', 'mailbox.sync', 'connector.recipe', 'action'));--> statement-breakpoint
ALTER TABLE "work_leases" DROP CONSTRAINT "work_leases_resource_key_check";--> statement-breakpoint
ALTER TABLE "work_leases" ADD CONSTRAINT "work_leases_resource_key_check" CHECK (CASE WHEN "kind" IN ('mailbox.sync', 'connector.recipe') THEN "resource_key" ~ '^[0-9]+$' WHEN "kind" = 'action' THEN "resource_key" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(:[0-9]{1,19})?$' ELSE "resource_key" = '' END);
-- custom:end
