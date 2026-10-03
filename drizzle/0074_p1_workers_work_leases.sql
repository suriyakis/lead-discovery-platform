CREATE TABLE "work_leases" (
	"workspace_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"resource_key" text DEFAULT '' NOT NULL,
	"holder" text NOT NULL,
	"holder_label" text NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"renewed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "work_leases_pkey" PRIMARY KEY("workspace_id","kind","resource_key")
);
--> statement-breakpoint
ALTER TABLE "outreach_follow_ups" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outreach_follow_ups" ADD COLUMN "sending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_leases" ADD CONSTRAINT "work_leases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_leases_expires_idx" ON "work_leases" USING btree ("expires_at");--> statement-breakpoint
-- custom:begin
-- PC-12: value checks drizzle-kit 0.30 does not generate from the TS schema.
ALTER TABLE "work_leases" ADD CONSTRAINT "work_leases_kind_check" CHECK ("kind" IN ('autopilot.run', 'outreach.drain', 'outreach.follow_up', 'mailbox.sync', 'connector.recipe'));--> statement-breakpoint
ALTER TABLE "work_leases" ADD CONSTRAINT "work_leases_resource_key_check" CHECK (CASE WHEN "kind" IN ('mailbox.sync', 'connector.recipe') THEN "resource_key" ~ '^[0-9]+$' ELSE "resource_key" = '' END);--> statement-breakpoint
ALTER TABLE "outreach_follow_ups" ADD CONSTRAINT "outreach_follow_ups_processing_claim_check" CHECK ("status" <> 'processing' OR "claimed_at" IS NOT NULL);
-- custom:end
