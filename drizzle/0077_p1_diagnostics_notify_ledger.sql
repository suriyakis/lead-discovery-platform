CREATE TABLE "diagnostic_notices" (
	"workspace_id" bigint NOT NULL,
	"notice_key" text NOT NULL,
	"rule_code" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone,
	"last_notified_at" timestamp with time zone,
	"notify_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "diagnostic_notices_workspace_id_notice_key_pk" PRIMARY KEY("workspace_id","notice_key")
);
--> statement-breakpoint
ALTER TABLE "diagnostic_notices" ADD CONSTRAINT "diagnostic_notices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagnostic_notices_ws_rule_idx" ON "diagnostic_notices" USING btree ("workspace_id","rule_code");