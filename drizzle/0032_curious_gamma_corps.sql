CREATE TYPE "public"."outreach_stage" AS ENUM('discovery', 'engagement', 'pitch', 'closing');--> statement-breakpoint
CREATE TABLE "outreach_thread_state" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"qualified_lead_id" bigint NOT NULL,
	"thread_id" bigint NOT NULL,
	"stage" "outreach_stage" DEFAULT 'discovery' NOT NULL,
	"last_inbound_intent" text,
	"last_inbound_confidence" smallint,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"referral_to_email" text,
	"referral_to_thread_state_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "auto_draft_replies" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "auto_send_replies" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD COLUMN "stage" "outreach_stage" DEFAULT 'discovery' NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD COLUMN "parent_draft_id" bigint;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD COLUMN "triggered_by_message_id" bigint;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD COLUMN "referral_chain" jsonb;--> statement-breakpoint
ALTER TABLE "qualified_leads" ADD COLUMN "current_stage" text DEFAULT 'discovery' NOT NULL;--> statement-breakpoint
ALTER TABLE "qualified_leads" ADD COLUMN "current_contact_email" text;--> statement-breakpoint
ALTER TABLE "qualified_leads" ADD COLUMN "current_thread_id" bigint;--> statement-breakpoint
ALTER TABLE "outreach_thread_state" ADD CONSTRAINT "outreach_thread_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_thread_state_thread_idx" ON "outreach_thread_state" USING btree ("workspace_id","thread_id");--> statement-breakpoint
CREATE INDEX "outreach_thread_state_lead_idx" ON "outreach_thread_state" USING btree ("workspace_id","qualified_lead_id");--> statement-breakpoint
CREATE INDEX "outreach_thread_state_open_idx" ON "outreach_thread_state" USING btree ("workspace_id","stage") WHERE closed_at IS NULL;--> statement-breakpoint

-- Phase A backfill: any draft that already exists predates the staging
-- model and is mid-conversation by definition — flip from the new
-- default 'discovery' to 'engagement'. New drafts created after this
-- migration use the column default ('discovery').
UPDATE "outreach_drafts" SET "stage" = 'engagement' WHERE "created_at" < now();--> statement-breakpoint

-- Phase A backfill: leads with any prior outbound draft are also
-- mid-conversation; everyone else stays on the column default.
UPDATE "qualified_leads" SET "current_stage" = 'engagement'
 WHERE EXISTS (
   SELECT 1 FROM "outreach_drafts" d
    WHERE d."workspace_id" = "qualified_leads"."workspace_id"
      AND d."review_item_id" = "qualified_leads"."review_item_id"
      AND d."product_profile_id" = "qualified_leads"."product_profile_id"
 );