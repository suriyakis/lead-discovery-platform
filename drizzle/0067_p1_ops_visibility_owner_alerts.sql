CREATE TABLE "ops_alert_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"sink" text DEFAULT 'ntfy' NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"priority" integer NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"http_status" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_alert_state" (
	"alert_key" text PRIMARY KEY NOT NULL,
	"last_alerted_at" timestamp with time zone NOT NULL,
	"last_event_id" bigint,
	"alert_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops_alert_state" ADD CONSTRAINT "ops_alert_state_last_event_id_ops_events_id_fk" FOREIGN KEY ("last_event_id") REFERENCES "public"."ops_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_alert_deliveries_kind_created_idx" ON "ops_alert_deliveries" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "ops_alert_deliveries_created_idx" ON "ops_alert_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ops_alert_state_last_alerted_idx" ON "ops_alert_state" USING btree ("last_alerted_at");--> statement-breakpoint
-- custom:begin
-- PC-08: value checks drizzle-kit 0.30 does not generate from the TS schema.
ALTER TABLE "ops_alert_state" ADD CONSTRAINT "ops_alert_state_alert_count_check" CHECK ("alert_count" >= 1);--> statement-breakpoint
ALTER TABLE "ops_alert_deliveries" ADD CONSTRAINT "ops_alert_deliveries_kind_check" CHECK ("kind" IN ('incident', 'digest', 'daily_digest', 'control', 'test'));--> statement-breakpoint
ALTER TABLE "ops_alert_deliveries" ADD CONSTRAINT "ops_alert_deliveries_status_check" CHECK ("status" IN ('sent', 'failed'));--> statement-breakpoint
ALTER TABLE "ops_alert_deliveries" ADD CONSTRAINT "ops_alert_deliveries_priority_check" CHECK ("priority" BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "ops_alert_deliveries" ADD CONSTRAINT "ops_alert_deliveries_event_count_check" CHECK ("event_count" >= 0);
-- custom:end
