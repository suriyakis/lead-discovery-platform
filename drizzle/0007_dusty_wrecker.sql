CREATE TYPE "public"."outreach_draft_status" AS ENUM('draft', 'needs_edit', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TABLE "outreach_drafts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"review_item_id" bigint NOT NULL,
	"source_record_id" bigint NOT NULL,
	"product_profile_id" bigint NOT NULL,
	"qualification_id" bigint,
	"status" "outreach_draft_status" DEFAULT 'draft' NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"confidence" smallint DEFAULT 50 NOT NULL,
	"method" text NOT NULL,
	"model" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"forbidden_stripped" text[] DEFAULT '{}'::text[] NOT NULL,
	"matched_lesson_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"rejection_reason" text,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"rejected_by_user_id" text,
	"rejected_at" timestamp with time zone,
	"edited_by_user_id" text,
	"edited_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_review_item_id_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."review_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_product_profile_id_product_profiles_id_fk" FOREIGN KEY ("product_profile_id") REFERENCES "public"."product_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_qualification_id_qualifications_id_fk" FOREIGN KEY ("qualification_id") REFERENCES "public"."qualifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_rejected_by_user_id_users_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_drafts_ws_status_idx" ON "outreach_drafts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "outreach_drafts_ws_product_idx" ON "outreach_drafts" USING btree ("workspace_id","product_profile_id");--> statement-breakpoint
CREATE INDEX "outreach_drafts_review_product_idx" ON "outreach_drafts" USING btree ("review_item_id","product_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_drafts_active_idx" ON "outreach_drafts" USING btree ("workspace_id","review_item_id","product_profile_id") WHERE status <> 'superseded';